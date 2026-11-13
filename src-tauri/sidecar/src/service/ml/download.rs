//! Resumable model downloader (B3): catalog → verified artifacts → manifest.
//!
//! The downloader is opt-in and owned by the sidecar. `POST
//! /v2/models/download` starts a background task; the HTTP handler never waits
//! for the ~324 MB transfer. Progress is polled through `GET /v2/models`.
//!
//! Per artifact the flow is:
//!
//! 1. skip a final file whose size and SHA-256 already match the catalog;
//! 2. stream into `<path>.part`, resuming an existing partial file with
//!    `Range: bytes=<length>-` and `Accept-Encoding: identity`;
//! 3. hash the complete `.part`; a size or SHA-256 mismatch removes it and
//!    fails the run without touching a previous final file;
//! 4. install with an atomic rename, then continue with the next artifact.
//!
//! After the last artifact the state becomes `verifying`, the schema-1
//! `manifest.json` is generated from the catalog and published through a
//! temporary file plus an atomic rename, and the state becomes `ready`.
//! Cancellation is cooperative (checked between chunks), keeps the `.part` and
//! ends `cancelled`; a new `POST /v2/models/download` resumes from it.
//!
//! An explicit `POST /v2/models/download` first re-hashes the installed
//! artifacts. It is a `200` no-op only when every size and SHA-256 matches and
//! the installed manifest is usable and current; a corrupt file under an
//! otherwise valid manifest is repaired like any other mismatch.
//!
//! Failures are actionable and terminal for that run: offline errors name the
//! URL and ask to check the network, checksum errors name the path and both
//! hashes, and disk errors name the required and available bytes. Indigo keeps
//! serving in every case.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::service::ml::catalog::{
    self, ArtifactRole, Catalog, CatalogArtifact, CatalogModel, MANIFEST_SCHEMA,
};

/// Repair hint reported by every non-`ok` verify report.
pub const REPAIR_HINT: &str = "POST /v2/models/download";

/// Hash buffer size; large enough to keep syscall overhead low, small enough
/// to stay out of the way of inference.
const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// State of the downloader. The first four variants are per run; `idle` is
/// also the restart state, and `ready` is reported when the installed set is
/// complete even if this process never downloaded it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    /// No run is active and the installed set is not complete.
    Idle,
    /// Artifacts are being fetched.
    Downloading,
    /// Every artifact is installed; the manifest is being generated.
    Verifying,
    /// The installed set is complete.
    Ready,
    /// The run was cancelled; partial files are kept.
    Cancelled,
    /// The run failed; `error` explains why.
    Failed,
}

/// Download progress, serialized as the `download` object of `/v2/models`.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    /// Current state.
    pub state: DownloadState,
    /// Cumulative bytes for the run: completed artifacts plus the current
    /// `.part` length.
    pub downloaded_bytes: u64,
    /// Total catalog size.
    pub total_bytes: u64,
    /// Artifact path being fetched or installed.
    pub current_file: Option<String>,
    /// Actionable failure message; only set while `state` is `failed`.
    pub error: Option<String>,
}

/// One model entry of the status body.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    /// Manifest key.
    pub key: String,
    /// Provenance id.
    pub id: String,
    /// Upstream version.
    pub version: String,
    /// SPDX license identifier.
    pub license: String,
    /// Declared artifact bytes.
    pub total_bytes: u64,
    /// Bytes of the artifact files that exist.
    pub installed_bytes: u64,
    /// True when every artifact file exists.
    pub installed: bool,
    /// Missing artifact paths, in catalog order.
    pub missing: Vec<String>,
}

/// Full body of `GET /v2/models` and of the download/cancel routes.
#[derive(Debug, Clone, Serialize)]
pub struct ModelsStatus {
    /// Active catalog version.
    pub catalog_version: u64,
    /// Version recorded by the installed manifest, when present.
    pub installed_catalog_version: Option<u64>,
    /// True when the installed manifest is older than the active catalog.
    pub update_available: bool,
    /// True when the manifest parses and every artifact exists.
    pub ready: bool,
    /// True when the manifest exists and parses.
    pub manifest_present: bool,
    /// Declared catalog bytes.
    pub total_bytes: u64,
    /// Bytes of the artifact files that exist.
    pub installed_bytes: u64,
    /// Per-model installation state, in catalog order.
    pub models: Vec<ModelStatus>,
    /// Download progress.
    pub download: DownloadStatus,
}

/// Outcome of `POST /v2/models/download`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartOutcome {
    /// A background run was spawned (`202`).
    Started,
    /// The install is ready and current; nothing was started (`200`).
    Noop,
}

/// Why a download could not start.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// The request conflicts with the current state (`409`).
    #[error("{0}")]
    Conflict(String),
    /// Unexpected failure (`500`).
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Verify report for `POST /v2/models/verify`.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    /// True only when every artifact is present and matches.
    pub ok: bool,
    /// Catalog version used for the check.
    pub catalog_version: u64,
    /// Bytes hashed for the present artifacts.
    pub checked_bytes: u64,
    /// One entry per artifact, in manifest or catalog order.
    pub artifacts: Vec<ArtifactCheck>,
    /// Repair hint, or `null` when everything matches.
    pub repair: Option<&'static str>,
}

/// Result for one artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactStatus {
    /// Present and matching.
    Ok,
    /// The file does not exist.
    Missing,
    /// Present but the SHA-256 (or the read) does not match.
    Corrupt,
}

/// Verify entry for one artifact.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactCheck {
    /// Path relative to the model root.
    pub path: String,
    /// Outcome.
    pub status: ArtifactStatus,
    /// Expected SHA-256; only set for `corrupt`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    /// Actual SHA-256; only set for `corrupt` when the file could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_sha256: Option<String>,
    /// Bytes read for this artifact; not part of the response body.
    #[serde(skip)]
    bytes: u64,
}

/// Shared downloader handle. Cloning shares the run state and cancellation
/// flag, so every clone of `AppState` observes the same download.
#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<Inner>,
}

/// Reads the free bytes available for the model root.
///
/// Production reads the filesystem; tests replace it to simulate a full or
/// roomy volume without filling the test disk.
type SpaceProbe = Arc<dyn Fn(&Path) -> Result<u64> + Send + Sync>;

struct Inner {
    status: Mutex<DownloadStatus>,
    cancel: AtomicBool,
    space_probe: Mutex<SpaceProbe>,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    /// Creates an idle manager.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                status: Mutex::new(DownloadStatus {
                    state: DownloadState::Idle,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    current_file: None,
                    error: None,
                }),
                cancel: AtomicBool::new(false),
                space_probe: Mutex::new(Arc::new(default_space_probe)),
            }),
        }
    }

    /// Replaces the free-space probe.
    ///
    /// Test seam: the suite simulates a full or roomy volume without writing
    /// enough data to change the real free space.
    #[cfg(test)]
    pub fn set_space_probe(&self, probe: impl Fn(&Path) -> Result<u64> + Send + Sync + 'static) {
        *self
            .inner
            .space_probe
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Arc::new(probe);
    }

    /// True while a run is downloading or generating the manifest.
    pub fn is_active(&self) -> bool {
        matches!(
            self.lock().state,
            DownloadState::Downloading | DownloadState::Verifying
        )
    }

    /// Builds the `/v2/models` body from the catalog and the filesystem.
    ///
    /// This never creates the model root and never hashes an artifact: a
    /// clean install answers immediately with every model missing.
    pub fn models_status(&self, root: &Path, catalog: &Catalog) -> ModelsStatus {
        let installed = InstalledSummary::scan(root, catalog);
        let run = self.lock().clone();
        let state = match run.state {
            DownloadState::Idle if installed.ready => DownloadState::Ready,
            state => state,
        };
        let downloaded_bytes = match state {
            DownloadState::Idle => 0,
            DownloadState::Ready => catalog.total_bytes(),
            _ => run.downloaded_bytes,
        };

        ModelsStatus {
            catalog_version: catalog.catalog_version,
            installed_catalog_version: installed.installed_catalog_version,
            update_available: installed.update_available,
            ready: installed.ready,
            manifest_present: installed.manifest_present,
            total_bytes: catalog.total_bytes(),
            installed_bytes: installed.installed_bytes,
            models: installed.models,
            download: DownloadStatus {
                state,
                downloaded_bytes,
                total_bytes: catalog.total_bytes(),
                current_file: if matches!(
                    state,
                    DownloadState::Downloading | DownloadState::Verifying
                ) {
                    run.current_file
                } else {
                    None
                },
                error: if state == DownloadState::Failed {
                    run.error
                } else {
                    None
                },
            },
        }
    }

    /// Starts or resumes a run in the background.
    ///
    /// Conflicts (a run is active, or the installed catalog is newer) are
    /// reported as [`StartError::Conflict`]. An install only no-ops
    /// ([`StartOutcome::Noop`]) when every artifact re-hashes to the catalog
    /// size and SHA-256 **and** the installed manifest is usable and records
    /// the active catalog version. Anything else starts a repair/update run:
    /// a corrupt artifact with a perfectly valid manifest is the normal repair
    /// case and must not be mistaken for "already installed".
    ///
    /// Re-hashing happens before the response so the `200`/`202` decision is
    /// truthful; it runs on the blocking pool so the async handler is not
    /// stalled by disk I/O.
    pub async fn start(
        &self,
        root: PathBuf,
        catalog: Arc<Catalog>,
    ) -> std::result::Result<StartOutcome, StartError> {
        let verify_before_noop = {
            let mut status = self.lock();

            if matches!(
                status.state,
                DownloadState::Downloading | DownloadState::Verifying
            ) {
                return Err(StartError::Conflict(
                    "a model download is already running; wait for it to finish or POST \
                     /v2/models/download/cancel"
                        .to_string(),
                ));
            }

            let installed = InstalledSummary::scan(&root, &catalog);
            if let Some(version) = installed.installed_catalog_version {
                if version > catalog.catalog_version {
                    return Err(StartError::Conflict(format!(
                        "the installed model catalog version {version} is newer than the bundled \
                         version {}; this app cannot downgrade it, update the app instead",
                        catalog.catalog_version
                    )));
                }
            }
            let verify_before_noop = installed.ready && !installed.update_available;

            // Claim the start slot before the first await so a concurrent POST
            // cannot hash and spawn a second worker. `verifying` is an active
            // state (no second start, no cancel); the no-op path restores
            // `idle`.
            *status = DownloadStatus {
                state: DownloadState::Verifying,
                downloaded_bytes: 0,
                total_bytes: catalog.total_bytes(),
                current_file: None,
                error: None,
            };
            verify_before_noop
        };

        if verify_before_noop && installed_matches_catalog(&root, &catalog).await {
            let mut status = self.lock();
            status.state = DownloadState::Idle;
            status.downloaded_bytes = 0;
            status.current_file = None;
            status.error = None;
            return Ok(StartOutcome::Noop);
        }

        let mut status = self.lock();
        *status = DownloadStatus {
            state: DownloadState::Downloading,
            downloaded_bytes: 0,
            total_bytes: catalog.total_bytes(),
            current_file: None,
            error: None,
        };
        self.inner.cancel.store(false, Ordering::SeqCst);
        drop(status);

        tokio::spawn(run(Arc::clone(&self.inner), root, catalog));
        Ok(StartOutcome::Started)
    }

    /// Requests cancellation of the active download.
    ///
    /// Only a `downloading` run is cancellable: `verifying` is short and the
    /// worker is about to publish the manifest, so cancelling there is a
    /// conflict.
    pub fn cancel(&self) -> std::result::Result<(), StartError> {
        let status = self.lock();
        if status.state != DownloadState::Downloading {
            return Err(StartError::Conflict(
                "no model download is running; only a downloading run can be cancelled".to_string(),
            ));
        }
        self.inner.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Hashes the installed artifacts and reports `ok|missing|corrupt` per
    /// artifact.
    ///
    /// The installed manifest is used when it parses (it is what the app
    /// loads); otherwise the active catalog is used, so an empty root reports
    /// every artifact as `missing`. Verification is read-only.
    pub async fn verify(&self, root: &Path, catalog: &Catalog) -> Result<VerifyReport> {
        let manifest = catalog::read_manifest(root);
        let catalog_version = manifest
            .as_ref()
            .and_then(|manifest| manifest.get("catalog_version"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(catalog.catalog_version);
        let artifacts = manifest
            .as_ref()
            .and_then(manifest_artifacts)
            .unwrap_or_else(|| {
                catalog
                    .artifacts()
                    .map(|artifact| (artifact.path.clone(), artifact.sha256.clone()))
                    .collect()
            });

        let root = root.to_path_buf();
        let checks = tokio::task::spawn_blocking(move || {
            artifacts
                .into_iter()
                .map(|(path, expected)| check_artifact(&root, path, expected))
                .collect::<Vec<_>>()
        })
        .await
        .context("the model verification task panicked")?;

        let checked_bytes = checks.iter().map(|check| check.bytes).sum();
        let ok = checks
            .iter()
            .all(|check| check.status == ArtifactStatus::Ok);

        Ok(VerifyReport {
            ok,
            catalog_version,
            checked_bytes,
            artifacts: checks,
            repair: (!ok).then_some(REPAIR_HINT),
        })
    }

    fn lock(&self) -> MutexGuard<'_, DownloadStatus> {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

/// Preflight floor check: `available` must be at least `required`.
///
/// This is deliberately pure and only compares two byte counts; the caller
/// obtains `available` from the filesystem. Equality passes.
pub fn ensure_space(required: u64, available: u64) -> Result<()> {
    if available < required {
        bail!(
            "not enough disk space for the model download: {required} bytes are required but \
             only {available} bytes are available; free some disk space and retry POST \
             /v2/models/download"
        );
    }
    Ok(())
}

fn default_space_probe(root: &Path) -> Result<u64> {
    Ok(fs2::available_space(root)?)
}

/// True when the installed manifest is current and every catalog artifact is
/// present with the catalog size and SHA-256.
///
/// This is the explicit-download no-op gate. It hashes the installed artifacts
/// (on the blocking pool), so a corrupt file with a valid manifest is repaired
/// instead of being skipped by an existence check.
async fn installed_matches_catalog(root: &Path, catalog: &Catalog) -> bool {
    if !catalog::manifest_is_current(root, catalog) {
        return false;
    }

    let root = root.to_path_buf();
    let artifacts: Vec<(String, u64, String)> = catalog
        .artifacts()
        .map(|artifact| {
            (
                artifact.path.clone(),
                artifact.size,
                artifact.sha256.clone(),
            )
        })
        .collect();

    tokio::task::spawn_blocking(move || {
        artifacts.iter().all(|(path, expected_size, expected_sha)| {
            let file = root.join(path);
            if !file.is_file() {
                return false;
            }
            let size = std::fs::metadata(&file)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            size == *expected_size
                && sha256_file(&file).is_ok_and(|actual| actual.eq_ignore_ascii_case(expected_sha))
        })
    })
    .await
    .unwrap_or(false)
}

/// Installed-state snapshot shared by the status body, `start` and `verify`.
struct InstalledSummary {
    manifest_present: bool,
    installed_catalog_version: Option<u64>,
    update_available: bool,
    ready: bool,
    installed_bytes: u64,
    models: Vec<ModelStatus>,
}

impl InstalledSummary {
    fn scan(root: &Path, catalog: &Catalog) -> Self {
        let manifest_present = catalog::manifest_present(root);
        let installed_catalog_version = catalog::installed_catalog_version(root);
        let update_available = manifest_present
            && installed_catalog_version.is_none_or(|version| version < catalog.catalog_version);

        let mut installed_bytes = 0_u64;
        let mut models = Vec::with_capacity(catalog.models.len());
        for (key, model) in &catalog.models {
            let mut model_installed_bytes = 0_u64;
            let mut missing = Vec::new();
            for artifact in &model.artifacts {
                let path = root.join(&artifact.path);
                if path.is_file() {
                    model_installed_bytes += std::fs::metadata(&path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);
                } else {
                    missing.push(artifact.path.clone());
                }
            }
            installed_bytes += model_installed_bytes;
            models.push(ModelStatus {
                key: key.clone(),
                id: model.id.clone(),
                version: model.version.clone(),
                license: model.license.clone(),
                total_bytes: model.total_bytes(),
                installed_bytes: model_installed_bytes,
                installed: missing.is_empty(),
                missing,
            });
        }

        Self {
            manifest_present,
            installed_catalog_version,
            update_available,
            ready: catalog::models_ready(root, catalog),
            installed_bytes,
            models,
        }
    }
}

/// Why the background worker stopped.
enum RunOutcome {
    Completed,
    Cancelled,
}

/// Why one artifact needed another request.
enum ArtifactOutcome {
    /// The final file is installed and verified.
    Installed,
    /// The run was cancelled; `kept` is the `.part` length.
    Cancelled { kept: u64 },
}

/// Background worker: preflight, every artifact, then the manifest.
async fn run(inner: Arc<Inner>, root: PathBuf, catalog: Arc<Catalog>) {
    match run_download(&inner, &root, &catalog).await {
        Ok(RunOutcome::Completed | RunOutcome::Cancelled) => {}
        Err(error) => {
            let message = format!("{error:#}");
            tracing::warn!("model download failed: {message}");
            let mut status = inner.lock();
            if matches!(
                status.state,
                DownloadState::Downloading | DownloadState::Verifying
            ) {
                status.state = DownloadState::Failed;
                status.error = Some(message);
                status.current_file = None;
            }
        }
    }
}

async fn run_download(inner: &Arc<Inner>, root: &Path, catalog: &Catalog) -> Result<RunOutcome> {
    std::fs::create_dir_all(root).with_context(|| {
        format!(
            "could not create the model root {}; set CHEMISTRY_MODELS_DIR to a writable \
             directory",
            root.display()
        )
    })?;

    let installed = InstalledSummary::scan(root, catalog);
    let remaining = catalog
        .total_bytes()
        .saturating_sub(installed.installed_bytes);
    let available = {
        let probe = inner
            .space_probe
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        probe(root).with_context(|| {
            format!(
                "could not read the free disk space of {}; check the model root",
                root.display()
            )
        })?
    };
    ensure_space(remaining, available)?;

    let client = Client::builder()
        .user_agent(concat!("chemistry-draw/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("could not create the HTTP client for the model download")?;

    let mut completed = 0_u64;
    for model in catalog.models.values() {
        for artifact in &model.artifacts {
            if inner.is_cancelled() {
                finish_cancelled(inner, completed);
                return Ok(RunOutcome::Cancelled);
            }

            set_progress(inner, completed, Some(&artifact.path));
            match download_artifact(inner, &client, root, artifact, completed).await? {
                ArtifactOutcome::Installed => {
                    completed += artifact.size;
                    set_progress(inner, completed, None);
                }
                ArtifactOutcome::Cancelled { kept } => {
                    finish_cancelled(inner, completed + kept);
                    return Ok(RunOutcome::Cancelled);
                }
            }
        }
    }

    set_state(inner, DownloadState::Verifying);
    let manifest = generate_manifest(catalog)?;
    write_manifest(root, &manifest)?;
    if !catalog::all_artifacts_present(root, catalog) {
        bail!(
            "the model download finished but not every artifact is present under {}; retry \
             POST /v2/models/download",
            root.display()
        );
    }

    let mut status = inner.lock();
    status.state = DownloadState::Ready;
    status.downloaded_bytes = catalog.total_bytes();
    status.current_file = None;
    status.error = None;
    tracing::info!("model download complete: {} bytes", catalog.total_bytes());

    Ok(RunOutcome::Completed)
}

/// Installs one artifact, resuming an existing `.part`.
async fn download_artifact(
    inner: &Arc<Inner>,
    client: &Client,
    root: &Path,
    artifact: &CatalogArtifact,
    completed: u64,
) -> Result<ArtifactOutcome> {
    let target = root.join(&artifact.path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "could not create the artifact directory {}",
                parent.display()
            )
        })?;
    }
    let part = part_path(&target);

    if target.is_file() {
        let size = std::fs::metadata(&target)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if size == artifact.size {
            let actual = sha256_file_async(&target).await?;
            if actual.eq_ignore_ascii_case(&artifact.sha256) {
                // A stale `.part` from an interrupted attempt is garbage once
                // the final file verifies; a completed run leaves none behind.
                remove_if_exists(&part)?;
                tracing::info!("model artifact {} is already installed", artifact.path);
                return Ok(ArtifactOutcome::Installed);
            }
            tracing::warn!(
                "model artifact {} has sha256 {actual}, expected {}; replacing it",
                artifact.path,
                artifact.sha256
            );
        }
    }

    let mut offset = std::fs::metadata(&part)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > artifact.size {
        remove_if_exists(&part)?;
        offset = 0;
    }
    if offset == artifact.size {
        let actual = sha256_file_async(&part).await?;
        if actual.eq_ignore_ascii_case(&artifact.sha256) {
            install_file(&part, &target)?;
            return Ok(ArtifactOutcome::Installed);
        }
        remove_if_exists(&part)?;
        offset = 0;
    }

    // A server that ignores `Range` (200) or answers 416/another range makes
    // us restart once without a partial file. A second failure is terminal.
    let mut restarted = false;
    loop {
        if inner.is_cancelled() {
            let kept = std::fs::metadata(&part)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            return Ok(ArtifactOutcome::Cancelled { kept });
        }

        let response = request_artifact(client, artifact, offset).await?;
        if inner.is_cancelled() {
            let kept = std::fs::metadata(&part)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            return Ok(ArtifactOutcome::Cancelled { kept });
        }

        let status = response.status();
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            if offset == 0 || restarted {
                bail!(
                    "could not download {}: the server answered HTTP 416 for the requested \
                     range; retry POST /v2/models/download",
                    artifact.url
                );
            }
            remove_if_exists(&part)?;
            offset = 0;
            restarted = true;
            continue;
        }
        if status == StatusCode::OK {
            if offset > 0 {
                // The server ignored `Range`; restart the artifact from zero.
                remove_if_exists(&part)?;
                offset = 0;
            }
        } else if status == StatusCode::PARTIAL_CONTENT {
            if content_range_start(response.headers()) != Some(offset) {
                if restarted {
                    bail!(
                        "could not download {}: the server returned an unexpected Content-Range; \
                         retry POST /v2/models/download",
                        artifact.url
                    );
                }
                remove_if_exists(&part)?;
                offset = 0;
                restarted = true;
                continue;
            }
        } else if !status.is_success() {
            bail!(
                "could not download {}: the server answered HTTP {status}; retry \
                 POST /v2/models/download",
                artifact.url
            );
        }

        let mut options = OpenOptions::new();
        options.create(true).write(true);
        if offset > 0 {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options
            .open(&part)
            .with_context(|| format!("could not open {} for writing", part.display()))?;

        let mut written = offset;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if inner.is_cancelled() {
                file.flush()
                    .with_context(|| format!("could not flush {}", part.display()))?;
                let kept = file
                    .metadata()
                    .map(|metadata| metadata.len())
                    .unwrap_or(written);
                return Ok(ArtifactOutcome::Cancelled { kept });
            }
            let chunk = chunk.map_err(|error| {
                anyhow!(
                    "could not download {}: {error}; check your network connection and retry \
                     POST /v2/models/download",
                    artifact.url
                )
            })?;
            file.write_all(&chunk)
                .with_context(|| format!("could not write {}", part.display()))?;
            written += chunk.len() as u64;
            set_progress(inner, completed + written, Some(&artifact.path));
        }

        file.flush()
            .with_context(|| format!("could not flush {}", part.display()))?;
        let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        drop(file);

        if length < artifact.size {
            bail!(
                "the download of `{}` ended after {length} of {} bytes; the partial file was \
                 kept, retry POST /v2/models/download to resume",
                artifact.path,
                artifact.size
            );
        }
        if length > artifact.size {
            remove_if_exists(&part)?;
            bail!(
                "artifact `{}` is {length} bytes but the catalog declares {}; the partial file \
                 was removed",
                artifact.path,
                artifact.size
            );
        }

        let actual = sha256_file_async(&part).await?;
        if !actual.eq_ignore_ascii_case(&artifact.sha256) {
            remove_if_exists(&part)?;
            bail!(
                "artifact `{}` failed verification: expected sha256 {}, got {}; the partial file \
                 was removed",
                artifact.path,
                artifact.sha256,
                actual
            );
        }

        install_file(&part, &target)?;
        set_progress(inner, completed + artifact.size, None);
        tracing::info!(
            "model artifact {} installed ({} bytes)",
            artifact.path,
            artifact.size
        );
        return Ok(ArtifactOutcome::Installed);
    }
}

async fn request_artifact(
    client: &Client,
    artifact: &CatalogArtifact,
    offset: u64,
) -> Result<reqwest::Response> {
    let mut request = client
        .get(&artifact.url)
        .header(ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }

    request.send().await.map_err(|error| {
        anyhow!(
            "could not download {}: {error}; check your network connection and retry \
             POST /v2/models/download",
            artifact.url
        )
    })
}

/// Parses the start offset of a `Content-Range: bytes <start>-<end>/<total>`
/// header.
fn content_range_start(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let (range, _) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    start.trim().parse().ok()
}

fn part_path(target: &Path) -> PathBuf {
    let mut part = target.as_os_str().to_os_string();
    part.push(".part");
    PathBuf::from(part)
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("could not remove {}", path.display())),
    }
}

/// Moves a verified file into place. On Windows a rename cannot replace an
/// existing file, so the old file is removed immediately before the rename.
fn install_file(from: &Path, to: &Path) -> Result<()> {
    #[cfg(windows)]
    if to.exists() {
        remove_if_exists(to)?;
    }

    std::fs::rename(from, to)
        .with_context(|| format!("could not install {} as {}", from.display(), to.display()))
}

fn write_manifest(root: &Path, manifest: &serde_json::Value) -> Result<()> {
    let raw = serde_json::to_vec_pretty(manifest)
        .context("could not serialize the generated model manifest")?;
    let temporary = root.join("manifest.json.tmp");
    std::fs::write(&temporary, raw)
        .with_context(|| format!("could not write {}", temporary.display()))?;
    install_file(&temporary, &catalog::manifest_path(root))
}

/// Builds the schema-1 manifest the registry loads from the catalog.
fn generate_manifest(catalog: &Catalog) -> Result<serde_json::Value> {
    let mut models = serde_json::Map::new();

    for (key, model) in &catalog.models {
        let entry = if let Some(classifier) = model.artifact(ArtifactRole::Classifier) {
            serde_json::json!({
                "id": &model.id,
                "version": &model.version,
                "file": &classifier.path,
                "artifact_sha256": &classifier.sha256,
                "source": &model.source,
                "license": &model.license,
                "threshold": model.threshold,
                "preprocessing": &model.preprocessing,
                "inputs": &classifier.inputs,
                "output": &classifier.output,
            })
        } else {
            let encoder = required_artifact(model, ArtifactRole::Encoder)?;
            let decoder = required_artifact(model, ArtifactRole::Decoder)?;
            let vocab = required_artifact(model, ArtifactRole::Vocab)?;
            serde_json::json!({
                "id": &model.id,
                "version": &model.version,
                "source": &model.source,
                "license": &model.license,
                "preprocessing": &model.preprocessing,
                "start_id": model.start_id,
                "end_id": model.end_id,
                "max_len": model.max_len,
                "confidence_threshold": model.confidence_threshold,
                "encoder": {
                    "file": &encoder.path,
                    "artifact_sha256": &encoder.sha256,
                    "inputs": &encoder.inputs,
                    "output": &encoder.output,
                },
                "decoder": {
                    "file": &decoder.path,
                    "artifact_sha256": &decoder.sha256,
                    "inputs": &decoder.inputs,
                    "zero_inputs": &decoder.zero_inputs,
                    "output": &decoder.output,
                },
                "vocab": {
                    "file": &vocab.path,
                    "artifact_sha256": &vocab.sha256,
                },
            })
        };

        models.insert(key.clone(), entry);
    }

    Ok(serde_json::json!({
        "schema": MANIFEST_SCHEMA,
        "catalog_version": catalog.catalog_version,
        "models": models,
    }))
}

fn required_artifact(model: &CatalogModel, role: ArtifactRole) -> Result<&CatalogArtifact> {
    model.artifact(role).ok_or_else(|| {
        anyhow!(
            "model `{}` is missing the `{role}` artifact required for the manifest",
            model.id
        )
    })
}

/// Extracts `(path, sha256)` pairs from a parsed manifest, in model order.
///
/// Returns `None` when the manifest does not declare a recognizable model, so
/// verification falls back to the active catalog.
fn manifest_artifacts(manifest: &serde_json::Value) -> Option<Vec<(String, String)>> {
    let models = manifest.get("models")?.as_object()?;
    let mut artifacts = Vec::new();

    for entry in models.values() {
        if let (Some(file), Some(sha256)) = (
            entry.get("file").and_then(serde_json::Value::as_str),
            entry
                .get("artifact_sha256")
                .and_then(serde_json::Value::as_str),
        ) {
            artifacts.push((file.to_string(), sha256.to_string()));
            continue;
        }

        for slot in ["encoder", "decoder", "vocab"] {
            let Some(graph) = entry.get(slot) else {
                continue;
            };
            if let (Some(file), Some(sha256)) = (
                graph.get("file").and_then(serde_json::Value::as_str),
                graph
                    .get("artifact_sha256")
                    .and_then(serde_json::Value::as_str),
            ) {
                artifacts.push((file.to_string(), sha256.to_string()));
            }
        }
    }

    (!artifacts.is_empty()).then_some(artifacts)
}

fn check_artifact(root: &Path, path: String, expected: String) -> ArtifactCheck {
    let full = root.join(&path);
    if !full.is_file() {
        return ArtifactCheck {
            path,
            status: ArtifactStatus::Missing,
            expected_sha256: None,
            actual_sha256: None,
            bytes: 0,
        };
    }

    let bytes = std::fs::metadata(&full)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    match sha256_file(&full) {
        Ok(actual) if actual.eq_ignore_ascii_case(&expected) => ArtifactCheck {
            path,
            status: ArtifactStatus::Ok,
            expected_sha256: None,
            actual_sha256: None,
            bytes,
        },
        Ok(actual) => ArtifactCheck {
            path,
            status: ArtifactStatus::Corrupt,
            expected_sha256: Some(expected),
            actual_sha256: Some(actual),
            bytes,
        },
        Err(error) => {
            tracing::warn!("could not hash model artifact {full:?}: {error:#}");
            ArtifactCheck {
                path,
                status: ArtifactStatus::Corrupt,
                expected_sha256: Some(expected),
                actual_sha256: None,
                bytes,
            }
        }
    }
}

async fn sha256_file_async(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .context("the artifact checksum task panicked")?
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("could not open {} for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; HASH_BUFFER_BYTES];

    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("could not read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn set_progress(inner: &Inner, downloaded: u64, current: Option<&str>) {
    let mut status = inner.lock();
    if status.state == DownloadState::Downloading {
        status.downloaded_bytes = downloaded;
        status.current_file = current.map(str::to_string);
    }
}

fn set_state(inner: &Inner, state: DownloadState) {
    inner.lock().state = state;
}

fn finish_cancelled(inner: &Inner, downloaded: u64) {
    let mut status = inner.lock();
    status.state = DownloadState::Cancelled;
    status.downloaded_bytes = downloaded;
    status.current_file = None;
    status.error = None;
    tracing::info!("model download cancelled after {downloaded} bytes; partial files kept");
}

impl Inner {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn lock(&self) -> MutexGuard<'_, DownloadStatus> {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}
