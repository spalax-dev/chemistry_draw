//! Shared application state, injected into handlers via `axum::extract::State`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use crate::service::ml::registry::ModelRegistry;

/// Injected into every axum handler.
///
/// # Fields
///
/// * `port` — listening port (used by `transport::info` for `api_path` and by
///   `transport::health`).
/// * `started_at` — when the sidecar began serving, for the health uptime.
/// * `models_dir` — root of the optional model store (`CHEMISTRY_MODELS_DIR`).
///
/// The model registry is loaded lazily on first use and cached — including its
/// failure — for the process lifetime. Constructing the state never touches the
/// filesystem or ONNX Runtime, so the sidecar starts without models.
#[derive(Clone)]
pub struct AppState {
    pub port: u16,
    pub started_at: Instant,
    pub models_dir: PathBuf,
    registry: Arc<OnceLock<Result<Arc<ModelRegistry>, String>>>,
}

impl AppState {
    /// Creates the state for a sidecar serving `port` with model root
    /// `models_dir`.
    pub fn new(port: u16, models_dir: impl Into<PathBuf>) -> Self {
        Self {
            port,
            started_at: Instant::now(),
            models_dir: models_dir.into(),
            registry: Arc::new(OnceLock::new()),
        }
    }

    /// Returns the validated model registry, loading it on first use.
    ///
    /// The error is the actionable registry message (manifest path, model root
    /// and `CHEMISTRY_MODELS_DIR`); handlers map it to HTTP 503.
    pub fn model_registry(&self) -> anyhow::Result<Arc<ModelRegistry>> {
        let cached = self.registry.get_or_init(|| {
            ModelRegistry::load(&self.models_dir)
                .map(Arc::new)
                .map_err(|error| format!("{error:#}"))
        });

        match cached {
            Ok(registry) => Ok(Arc::clone(registry)),
            Err(message) => Err(anyhow::anyhow!("{message}")),
        }
    }
}
