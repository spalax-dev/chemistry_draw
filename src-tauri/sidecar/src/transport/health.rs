//! `GET /v2/health` — diagnostic snapshot for bug reports.
//!
//! Unlike `/v2/info` (which Ketcher consumes), this endpoint is meant for
//! humans and support: it answers "is the sidecar alive, on which port, since
//! when, and can it find the Imago worker?" without needing the app logs.

use axum::{extract::State, Json};
use serde_json::json;

use crate::ffi::{imago, indigo};
use crate::state::AppState;

pub async fn get_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    tracing::info!("GET /v2/health");

    let worker_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("imago-worker")));
    let worker_found = worker_path.as_ref().map(|p| p.exists()).unwrap_or(false);

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": state.port,
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "indigo_version": indigo::version(),
        "imago_versions": imago::versions(),
        "imago_worker": {
            "found": worker_found,
            "path": worker_path.map(|p| p.to_string_lossy().to_string()),
        },
    }))
}
