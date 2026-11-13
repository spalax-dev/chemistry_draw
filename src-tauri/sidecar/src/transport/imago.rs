//! Ketcher compatibility shim for the Imago upload/job protocol.
//!
//! Ketcher's built-in Recognize Molecule control hardcodes `POST
//! {apiPath}imago/uploads` followed by `GET {apiPath}imago/uploads/:id`. The
//! route names are Ketcher's, not ours: no Imago library, worker or job format
//! is involved. The handler stores the raw image in the in-memory job store
//! from [`crate::service::jobs`], returns an `upload_id`, and a background
//! worker runs the local filter → OCSR → Indigo pipeline from
//! [`crate::service::recognition`].
//!
//! POST validates only the media type (`image/png`, `image/jpeg` or
//! `image/webp`) and the 10 MiB body cap. It never decodes the image: an
//! undecodable body becomes a `FAILURE` job, not a synchronous `400`, so the
//! client always gets an id it can poll. The `?version=` query is optional
//! (accepted and ignored) because one local OCSR model serves every request.
//!
//! Polling answers HTTP `200` with `{ "state": ... }` for a known job and `404
//! { "error": ... }` for an unknown, expired or restarted id. A `SUCCESS` body
//! carries exactly `metadata.mol_str`; a `FAILURE` body carries exactly
//! `error`.
//!
//! Both handlers prune the store before answering, so expired jobs leave the
//! map instead of accumulating for the process lifetime. The worker itself is
//! bounded by [`PROCESSING_TIMEOUT`], separate from the store TTL.

use std::path::Path as FsPath;
use std::time::{Duration, Instant};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::service::jobs::{JobStatus, TIMEOUT_MESSAGE};
use crate::service::recognition::{self, RecognitionFailure};
use crate::state::AppState;
use crate::transport::filter::validate_content_type;

/// How long the background pipeline may run before the job resolves as a
/// timeout. Generous on purpose: the first recognition loads the ~316 MB OCSR
/// pair from disk.
const PROCESSING_TIMEOUT: Duration = Duration::from_secs(120);

/// Message used when the worker itself cannot report a typed failure (a panic
/// or an unrecoverable join error). Not part of the documented outcome table;
/// the UI maps unknown messages to its generic dialog.
const INTERNAL_MESSAGE: &str = "Recognition failed. Try again.";

/// Accepted upload, as read by Ketcher.
#[derive(Debug, Serialize)]
pub struct UploadResponse {
    /// Opaque job id the client polls.
    pub upload_id: String,
}

/// Accepts a raw image and schedules the recognition job.
///
/// Always answers `200` once the media type is supported and the body is within
/// the route cap: model and decode problems resolve in the job, never as a
/// synchronous error.
pub async fn post_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UploadResponse>, AppError> {
    tracing::info!("POST /v2/imago/uploads");
    validate_content_type(&headers)?;

    let jobs = state.jobs();
    let now = Instant::now();
    jobs.purge(now);
    let id = jobs.create(body.to_vec(), now);
    let image = jobs.image(&id).unwrap_or_default();
    spawn_processing(state, id.clone(), image);

    Ok(Json(UploadResponse { upload_id: id }))
}

/// Reports the state of one recognition job.
///
/// Unknown and expired ids are `404`; every known state is `200` with the
/// Ketcher shape (`PENDING`, `SUCCESS` + `metadata.mol_str`, `FAILURE` +
/// `error`).
pub async fn get_upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    tracing::info!("GET /v2/imago/uploads/{id}");

    let jobs = state.jobs();
    let now = Instant::now();
    jobs.purge(now);
    let status = jobs
        .get(&id, now)
        .ok_or_else(|| AppError::NotFound(format!("unknown recognition job `{id}`")))?;

    Ok(Json(match status {
        JobStatus::Pending => json!({ "state": "PENDING" }),
        JobStatus::Success { molfile } => json!({
            "state": "SUCCESS",
            "metadata": { "mol_str": molfile },
        }),
        JobStatus::Failure { error } => json!({ "state": "FAILURE", "error": error }),
    }))
}

/// Runs the recognition pipeline off the async runtime and resolves the job.
///
/// ONNX Runtime and Indigo are synchronous, so the pipeline runs inside
/// [`tokio::task::spawn_blocking`] and the async worker keeps serving Indigo.
/// The timeout is a bound on processing, not a fixed sleep.
fn spawn_processing(state: AppState, id: String, image: Vec<u8>) {
    spawn_processing_with(state, id, image, PROCESSING_TIMEOUT, run_pipeline);
}

/// [`spawn_processing`] with an injected bound and pipeline.
///
/// The seam lets the timeout mapping be tested without waiting the production
/// 120 s or loading a model; production always passes [`PROCESSING_TIMEOUT`]
/// and [`run_pipeline`].
pub(crate) fn spawn_processing_with<P>(
    state: AppState,
    id: String,
    image: Vec<u8>,
    bound: Duration,
    pipeline: P,
) where
    P: FnOnce(&AppState, &[u8]) -> Result<String, RecognitionFailure> + Send + 'static,
{
    tokio::spawn(async move {
        let jobs = state.jobs();
        let models_dir = state.models_dir.clone();

        let worker_state = state.clone();
        let processing = tokio::task::spawn_blocking(move || pipeline(&worker_state, &image));
        let outcome = tokio::time::timeout(bound, processing).await;
        let now = Instant::now();

        match outcome {
            Ok(Ok(Ok(molfile))) => {
                jobs.succeed(&id, molfile, now);
            }
            Ok(Ok(Err(failure))) => {
                tracing::warn!("recognition job {id} failed: {}", failure.message());
                jobs.fail(&id, failure_message(failure, &models_dir), now);
            }
            Ok(Err(error)) => {
                tracing::error!("recognition job {id} worker failed: {error}");
                jobs.fail(&id, INTERNAL_MESSAGE.to_string(), now);
            }
            Err(_elapsed) => {
                tracing::warn!("recognition job {id} timed out after {bound:?}");
                jobs.fail(&id, TIMEOUT_MESSAGE.to_string(), now);
            }
        }
    });
}

/// Resolves the model registry and runs the pipeline.
///
/// The registry is resolved only after the image decodes, so an undecodable
/// upload reports the unsupported-image failure instead of a model-setup error.
fn run_pipeline(state: &AppState, image: &[u8]) -> Result<String, RecognitionFailure> {
    recognition::recognize(image, || {
        state.model_registry().map_err(|error| {
            tracing::warn!("recognition models are unavailable: {error:#}");
            RecognitionFailure::ModelUnavailable
        })
    })
}

/// Expands the model-unavailable failure with the actionable model-root hint.
fn failure_message(failure: RecognitionFailure, models_dir: &FsPath) -> String {
    match failure {
        RecognitionFailure::ModelUnavailable => recognition::model_unavailable_message(models_dir),
        other => other.message().to_string(),
    }
}
