//! `GET /v2/info` — returns versions and API path.

use axum::Json;
use serde_json::json;

use crate::ffi::{imago, indigo};

/// Returns Indigo version, Imago versions, and the API base URL.
///
/// Ketcher reads `imago_versions` to register the image recognition
/// backend and enable the "Recognize Molecule" button.
pub async fn get_info() -> Json<serde_json::Value> {
    tracing::info!("GET /v2/info");
    let v = indigo::version();
    let imago_v = imago::versions();
    Json(json!({
        "Indigo": { "version": v },
        "imago_versions": imago_v,
        "indigo_version": v,
        "api_path": "http://localhost:9321/v2"
    }))
}
