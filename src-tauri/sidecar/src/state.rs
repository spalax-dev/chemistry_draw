//! Shared application state, injected into handlers via `axum::extract::State`.

use std::time::Instant;

use crate::job::ImagoJobStore;

/// Injected into every axum handler.
///
/// # Fields
///
/// * `port` — listening port (used by `transport::info` for `api_path` and by
///   `transport::health`).
/// * `started_at` — when the sidecar began serving, for the health uptime.
/// * `imago_store` — in-memory job store for Imago recognition jobs.
#[derive(Clone)]
pub struct AppState {
    pub port: u16,
    pub started_at: Instant,
    pub imago_store: ImagoJobStore,
}
