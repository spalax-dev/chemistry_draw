//! Shared application state, injected into handlers via `axum::extract::State`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use crate::service::jobs::JobStore;
use crate::service::ml::catalog::{self, Catalog};
use crate::service::ml::download::DownloadManager;
use crate::service::ml::registry::ModelRegistry;

/// Injected into every axum handler.
///
/// # Fields
///
/// * `port` — listening port (used by `transport::info` for `api_path` and by
///   `transport::health`).
/// * `started_at` — when the sidecar began serving, for the health uptime.
/// * `models_dir` — root of the optional model store (`CHEMISTRY_MODELS_DIR`).
/// * `jobs` — in-memory recognition jobs for the Ketcher compatibility routes.
/// * `catalog` — the bundled model catalog, or the actionable error from a
///   broken `CHEMISTRY_MODEL_CATALOG` override.
/// * `downloads` — the process-wide resumable downloader.
///
/// The model registry is loaded lazily on first use and cached — including its
/// failure — for the process lifetime. Constructing the state never touches the
/// filesystem or ONNX Runtime, so the sidecar starts without models.
#[derive(Clone)]
pub struct AppState {
    pub port: u16,
    pub started_at: Instant,
    pub models_dir: PathBuf,
    jobs: Arc<JobStore>,
    registry: Arc<OnceLock<Result<Arc<ModelRegistry>, String>>>,
    catalog: Arc<Result<Arc<Catalog>, String>>,
    downloads: DownloadManager,
}

impl AppState {
    /// Creates the state for a sidecar serving `port` with model root
    /// `models_dir`.
    ///
    /// The catalog comes from `CHEMISTRY_MODEL_CATALOG` when set (a test and
    /// support override) and from the bundled catalog otherwise. An
    /// unreadable or invalid override is stored as an error instead of
    /// panicking, so Indigo keeps serving and the model routes answer `500`.
    pub fn new(port: u16, models_dir: impl Into<PathBuf>) -> Self {
        Self::with_catalog_result(port, models_dir, load_catalog())
    }

    /// Creates the state with an explicit catalog.
    ///
    /// The model-delivery tests use this to point the downloader at dummy
    /// artifacts served from loopback, so the suite never reads the checkout's
    /// `models/` and never touches the real network.
    pub fn with_catalog(port: u16, models_dir: impl Into<PathBuf>, catalog: Catalog) -> Self {
        Self::with_catalog_result(port, models_dir, Ok(Arc::new(catalog)))
    }

    /// Creates the state with an explicit catalog error.
    ///
    /// Test seam for the broken-override contract: the model routes answer the
    /// actionable `500` while `/v2/info` and `/v2/health` degrade to "no
    /// models" without touching the environment.
    #[cfg(test)]
    pub fn with_catalog_error(
        port: u16,
        models_dir: impl Into<PathBuf>,
        message: impl Into<String>,
    ) -> Self {
        Self::with_catalog_result(port, models_dir, Err(message.into()))
    }

    fn with_catalog_result(
        port: u16,
        models_dir: impl Into<PathBuf>,
        catalog: Result<Arc<Catalog>, String>,
    ) -> Self {
        Self {
            port,
            started_at: Instant::now(),
            models_dir: models_dir.into(),
            jobs: Arc::new(JobStore::new()),
            registry: Arc::new(OnceLock::new()),
            catalog: Arc::new(catalog),
            downloads: DownloadManager::new(),
        }
    }

    /// Returns the process-wide recognition job store.
    ///
    /// Uploads create jobs and polls read them; both handlers share this one
    /// store through the cloned state.
    pub fn jobs(&self) -> Arc<JobStore> {
        Arc::clone(&self.jobs)
    }

    /// Returns the active model catalog, or the actionable override error.
    ///
    /// The model routes map the error to HTTP `500`; `/v2/info` and
    /// `/v2/health` degrade to "no models installed" instead.
    pub fn catalog(&self) -> anyhow::Result<Arc<Catalog>> {
        match self.catalog.as_ref() {
            Ok(catalog) => Ok(Arc::clone(catalog)),
            Err(message) => Err(anyhow::anyhow!("{message}")),
        }
    }

    /// Returns the shared model downloader.
    ///
    /// Cloning the state shares the same run state and cancellation flag.
    pub fn downloads(&self) -> &DownloadManager {
        &self.downloads
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

/// Loads the catalog override or falls back to the bundled catalog.
fn load_catalog() -> Result<Arc<Catalog>, String> {
    let Some(path) = std::env::var_os("CHEMISTRY_MODEL_CATALOG") else {
        return Ok(Arc::new(catalog::bundled_catalog().clone()));
    };
    let path = PathBuf::from(path);
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        format!(
            "could not read CHEMISTRY_MODEL_CATALOG {}: {error}",
            path.display()
        )
    })?;
    Catalog::from_json(&raw).map(Arc::new).map_err(|error| {
        format!(
            "invalid CHEMISTRY_MODEL_CATALOG {}: {error:#}",
            path.display()
        )
    })
}
