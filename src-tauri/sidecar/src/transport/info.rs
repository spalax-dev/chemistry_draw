//! `GET /v2/info` — returns versions and API path.

use axum::{extract::State, Json};
use serde_json::json;

use crate::ffi::{imago, indigo};
use crate::state::AppState;

/// Returns Indigo version, Imago versions, and the API base URL.
///
/// Ketcher reads `imago_versions` to register the image recognition
/// backend and enable the "Recognize Molecule" button.
pub async fn get_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    tracing::info!("GET /v2/info");
    let v = indigo::version();
    let imago_v = imago::versions();
    Json(json!({
        "Indigo": { "version": v },
        "imago_versions": imago_v,
        "indigo_version": v,
        // Must match the port actually bound: the sidecar can fall back to a
        // different one when 9321 is busy.
        "api_path": format!("http://127.0.0.1:{}/v2", state.port)
    }))
}
