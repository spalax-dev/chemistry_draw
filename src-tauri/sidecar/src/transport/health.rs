//! `GET /v2/health` — diagnostic snapshot for bug reports.
//!
//! Unlike `/v2/info` (which Ketcher consumes), this endpoint is meant for
//! humans and support: it answers "is the sidecar alive, on which port, and
//! since when?" without needing the app logs. It also reports the ONNX Runtime
//! generation and the model ids declared by the manifest and present on disk.
//!
//! Health never fails because of the model store: metadata is parsed without
//! opening a session, and a missing or invalid manifest reports no models.

use axum::{extract::State, Json};
use serde_json::json;

use crate::ffi::indigo;
use crate::service::ml::{catalog, registry, runtime};
use crate::state::AppState;

pub async fn get_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    tracing::info!("GET /v2/health");

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": state.port,
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "indigo_version": indigo::version(),
        "onnxruntime_version": runtime::version_string(),
        "models": model_ids(&state),
    }))
}

/// Model ids whose artifacts exist on disk.
///
/// A parsed manifest is authoritative (it is what the app loads). Without one,
/// the active catalog supplies the ids for the same cheap presence check, so a
/// download that installed artifacts but did not reach the manifest still
/// reports what is on disk. A broken catalog override reports no ids.
fn model_ids(state: &AppState) -> Vec<String> {
    if catalog::manifest_present(&state.models_dir) {
        return registry::available_model_ids(&state.models_dir);
    }

    match state.catalog() {
        Ok(catalog) => catalog::installed_model_ids(&state.models_dir, &catalog),
        Err(_) => Vec::new(),
    }
}
