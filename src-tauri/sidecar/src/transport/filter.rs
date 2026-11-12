//! `POST /v2/filter/classify` — image gate for the structure classifier.
//!
//! The body is a raw image (no multipart, no base64): `image/png`,
//! `image/jpeg` or `image/webp`. The handler validates the media type and
//! decodes the image **before** resolving the model, so malformed input is a
//! `400` even when no model is installed; a well-formed image without a usable
//! model is a `503`.
//!
//! The route caps the raw body at 10 MiB (10,485,760 bytes) on its own
//! [`DefaultBodyLimit`], above axum's 2 MiB default; larger bodies never reach
//! the decoder and get `413`. That `413` body is plain text from axum, not the
//! `{ "error": ... }` JSON shape; every other error uses [`AppError`].
//!
//! Decoding is bounded ([`crate::service::ml::preprocess`]): images over
//! 12,000 px per side or over 128 MiB of decoder allocations get the same `400`
//! as undecodable bytes.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap},
    Json,
};
use serde::Serialize;

use crate::error::AppError;
use crate::service::ml::classifier::{Classification, ClassifyError};
use crate::service::ml::preprocess::classifier_input;
use crate::state::AppState;

/// Maximum accepted raw image body: 10 MiB.
pub const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Image media types accepted on this route.
const SUPPORTED_MEDIA_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

/// Successful classification, as consumed by the Ketcher frontend.
#[derive(Debug, Serialize)]
pub struct ClassifyResponse {
    /// `true` when the image contains a chemical structure.
    pub contains_molecule: bool,
    /// `"structure"` when `contains_molecule`, otherwise `"no-structure"`.
    pub category: &'static str,
    /// `sigmoid(logit)`.
    pub score: f64,
    /// Calibrated threshold echoed from the manifest.
    pub threshold: f64,
    /// Raw logit emitted by the graph.
    pub logit: f32,
    /// Provenance id of the model that produced the answer.
    pub model: String,
}

/// Classifies a raw image as `structure` or `no-structure`.
pub async fn post_classify(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ClassifyResponse>, AppError> {
    tracing::info!("POST /v2/filter/classify");
    validate_content_type(&headers)?;

    // Decode first: a malformed image is always 400, even with no model.
    let input = classifier_input(&body).map_err(AppError::bad_request)?;

    let registry = state
        .model_registry()
        .map_err(AppError::service_unavailable)?;
    let classifier = registry.classifier().ok_or_else(|| {
        let manifest = state.models_dir.join("manifest.json");
        AppError::service_unavailable(format!(
            "the model manifest {} does not declare the `image-classifier` model \
             (model root {}; set CHEMISTRY_MODELS_DIR to a model root whose manifest declares it)",
            manifest.display(),
            state.models_dir.display()
        ))
    })?;

    let model = classifier.contract().id.clone();
    let threshold = classifier.threshold();
    let classification = classifier.classify(input)?;

    Ok(Json(ClassifyResponse {
        contains_molecule: classification.contains_molecule,
        category: category(classification),
        score: classification.score,
        threshold,
        logit: classification.logit,
        model,
    }))
}

/// Builds the router fragment for this route, body limit included.
pub fn route() -> axum::routing::MethodRouter<AppState> {
    use axum::routing::post;

    post(post_classify).layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

fn category(classification: Classification) -> &'static str {
    if classification.contains_molecule {
        "structure"
    } else {
        "no-structure"
    }
}

/// Accepts only the three documented media types, ignoring `;` parameters.
fn validate_content_type(headers: &HeaderMap) -> Result<(), AppError> {
    let Some(raw) = headers.get(header::CONTENT_TYPE) else {
        return Err(unsupported_media_type(None));
    };
    let Ok(raw) = raw.to_str() else {
        return Err(unsupported_media_type(None));
    };

    let media_type = raw
        .split(';')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_ascii_lowercase();
    if SUPPORTED_MEDIA_TYPES.contains(&media_type.as_str()) {
        Ok(())
    } else {
        Err(unsupported_media_type(Some(&media_type)))
    }
}

fn unsupported_media_type(media_type: Option<&str>) -> AppError {
    let supported = SUPPORTED_MEDIA_TYPES.join(", ");
    match media_type {
        Some(media_type) => AppError::bad_request(format!(
            "unsupported image content type `{media_type}`; supported types: {supported}"
        )),
        None => AppError::bad_request(format!(
            "missing or unreadable Content-Type; supported image types: {supported}"
        )),
    }
}

impl From<ClassifyError> for AppError {
    fn from(error: ClassifyError) -> Self {
        match error {
            ClassifyError::Contract(message) => AppError::ServiceUnavailable(message),
            ClassifyError::Inference(message) => AppError::Internal(message),
        }
    }
}
