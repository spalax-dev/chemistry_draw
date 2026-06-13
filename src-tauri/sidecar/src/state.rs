//! Shared application state, injected into handlers via `axum::extract::State`.

use crate::job::ImagoJobStore;

/// Injected into every axum handler.
///
/// # Fields
///
/// * `_port` — listening port (used by `transport::info` for `api_path`).
/// * `imago_store` — in-memory job store for Imago recognition jobs.
#[derive(Clone)]
pub struct AppState {
    pub _port: u16,
    pub imago_store: ImagoJobStore,
}
