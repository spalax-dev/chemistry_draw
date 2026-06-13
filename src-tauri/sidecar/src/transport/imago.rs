//! Handlers for `/v2/imago/uploads`.
//!
//! * `POST /v2/imago/uploads` — accepts raw image bytes, creates a job,
//!   runs recognition synchronously, returns the upload id.
//! * `GET /v2/imago/uploads/{id}` — polls job status.

use axum::{
    body::Bytes,
    extract::{Path, State},
    response::Json,
};

use crate::error::AppError;
use crate::job::{ImagoJobStore, JobStatus};
use crate::service::imago_ops;
use crate::state::AppState;

/// Accepts an image, creates a recognition job, and returns the upload id.
///
/// # Request
///
/// Raw image bytes (PNG or JPEG) in the request body.
///
/// # Response
///
/// ```json
/// { "upload_id": "550e8400-e29b-41d4-a716-446655440000" }
/// ```
pub async fn post_upload(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    let id = state.imago_store.create();
    process_and_store(&state.imago_store, &id, &body);
    Ok(Json(serde_json::json!({ "upload_id": id })))
}

/// Polls the status of a recognition job.
///
/// # Responses
///
/// ```json
/// { "state": "PROCESSING" }
/// { "state": "SUCCESS", "metadata": { "mol_str": "…" } }
/// { "state": "FAILURE", "error": "…" }
/// ```
pub async fn get_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    match state.imago_store.get(&id) {
        Some(JobStatus::Processing) => Ok(Json(serde_json::json!({ "state": "PROCESSING" }))),
        Some(JobStatus::Success { mol_str }) => {
            tracing::info!("Imago job {id} -> SUCCESS");
            Ok(Json(serde_json::json!({
                "state": "SUCCESS",
                "metadata": { "mol_str": mol_str }
            })))
        }
        Some(JobStatus::Failure { error }) => {
            tracing::error!("Imago job {id} -> FAILURE: {error}");
            Ok(Json(serde_json::json!({
                "state": "FAILURE",
                "error": error
            })))
        }
        None => Err(AppError::not_found(format!("upload_id {id} not found"))),
    }
}

fn process_and_store(store: &ImagoJobStore, id: &str, image_bytes: &[u8]) {
    match imago_ops::process(image_bytes) {
        Ok(mol_str) => store.set_success(id, mol_str),
        Err(e) => store.set_failure(id, format!("{e:#}")),
    }
}
