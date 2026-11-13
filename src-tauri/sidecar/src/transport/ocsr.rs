//! `POST /v2/ocsr/recognize` — image to SMILES through the OCSR model pair.
//!
//! The body is a raw image (no multipart, no base64): `image/png`,
//! `image/jpeg` or `image/webp`. The handler validates the media type and
//! decodes the image (`decimer_ocsr`) **before** resolving the model, so
//! malformed input is a `400` even when no model is installed; a well-formed
//! image without a usable model is a `503`.
//!
//! The route caps the raw body at 10 MiB (10,485,760 bytes) on its own
//! [`DefaultBodyLimit`], above axum's 2 MiB default; larger bodies never reach
//! the decoder and get `413`. That `413` body is plain text from axum, not the
//! `{ "error": ... }` JSON shape; every other error uses [`AppError`].
//!
//! An incomplete decode (the decoder reached `max_len` without its end token) is
//! `422` with the actionable message; a truncated SMILES is never returned.
//! Decoding is bounded ([`crate::service::ml::ocsr_preprocess`]): images over
//! 12,000 px per side or over 128 MiB of decoder allocations get the same `400`
//! as undecodable bytes.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    Json,
};
use serde::Serialize;

use crate::error::AppError;
use crate::service::ml::ocsr::{OcsrError, OcsrPrediction};
use crate::service::ml::ocsr_preprocess::ocsr_input;
use crate::state::AppState;
use crate::transport::filter::validate_content_type;

/// Maximum accepted raw image body: 10 MiB.
pub const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
/// Actionable message returned for an incomplete decode.
const INCOMPLETE_MESSAGE: &str = "could not finish the structure; try a sharper image";

/// Successful recognition, as returned to the client.
#[derive(Debug, Serialize)]
pub struct RecognizeResponse {
    /// Detokenized, digit-remapped SMILES.
    pub smiles: String,
    /// Mean chosen-token probability, informational.
    pub confidence: f64,
    /// Always `false`: an incomplete decode is a `422`, not a partial result.
    pub incomplete: bool,
    /// Provenance id of the model that produced the answer.
    pub model: String,
}

/// Recognizes the chemical structure drawn in a raw image.
pub async fn post_recognize(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RecognizeResponse>, AppError> {
    tracing::info!("POST /v2/ocsr/recognize");
    validate_content_type(&headers)?;

    // Decode first: a malformed image is always 400, even with no model.
    let input = ocsr_input(&body).map_err(AppError::bad_request)?;

    let registry = state
        .model_registry()
        .map_err(AppError::service_unavailable)?;
    let model = registry
        .ocsr()
        .map_err(AppError::service_unavailable)?
        .ok_or_else(|| {
            let manifest = state.models_dir.join("manifest.json");
            AppError::service_unavailable(format!(
                "the model manifest {} does not declare the OCSR model \
             (model root {}; set CHEMISTRY_MODELS_DIR to a model root whose manifest declares it)",
                manifest.display(),
                state.models_dir.display()
            ))
        })?;

    let model_id = model.contract().id.clone();
    let prediction = model.predict(&input)?;
    ensure_complete(&prediction)?;

    Ok(Json(RecognizeResponse {
        smiles: prediction.smiles,
        confidence: prediction.confidence,
        incomplete: prediction.incomplete,
        model: model_id,
    }))
}

/// Rejects an incomplete decode: a truncated SMILES is not a result.
///
/// The handler routes every prediction through this guard, so the `422` mapping
/// is tested without hoping the real model truncates.
pub(crate) fn ensure_complete(prediction: &OcsrPrediction) -> Result<(), AppError> {
    if prediction.incomplete {
        Err(AppError::Unprocessable(INCOMPLETE_MESSAGE.to_string()))
    } else {
        Ok(())
    }
}

/// Builds the router fragment for this route, body limit included.
pub fn route() -> axum::routing::MethodRouter<AppState> {
    use axum::routing::post;

    post(post_recognize).layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

impl From<OcsrError> for AppError {
    fn from(error: OcsrError) -> Self {
        match error {
            OcsrError::Contract(message) => AppError::ServiceUnavailable(message),
            OcsrError::Inference(message) => AppError::Internal(message),
        }
    }
}
