//! `GET /v2/health` — diagnostic snapshot for bug reports.
//!
//! Unlike `/v2/info` (which Ketcher consumes), this endpoint is meant for
//! humans and support: it answers "is the sidecar alive, on which port, and
//! since when?" without needing the app logs.

use axum::{extract::State, Json};
use serde_json::json;

use crate::ffi::indigo;
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
    }))
}
