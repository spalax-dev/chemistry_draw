//! `GET /v2/info` — returns versions and API path.

use axum::{extract::State, Json};
use serde_json::json;

use crate::ffi::indigo;
use crate::state::AppState;

/// Returns the Indigo version and the API base URL.
///
/// `imago_versions` is a synthetic capability list: Ketcher disables its
/// built-in Recognize control when the list is empty, and the sidecar serves
/// that protocol with the local OCSR model. It does not advertise an Imago
/// build.
pub async fn get_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    tracing::info!("GET /v2/info");
    let v = indigo::version();
    Json(json!({
        "Indigo": { "version": v },
        "indigo_version": v,
        // Must match the port actually bound: the sidecar can fall back to a
        // different one when 9321 is busy.
        "api_path": format!("http://127.0.0.1:{}/v2", state.port),
        // Synthetic capability: the compatibility shim runs the local OCSR
        // model, and Ketcher needs a non-empty list to enable Recognize.
        "imago_versions": ["local-ocsr"],
    }))
}
