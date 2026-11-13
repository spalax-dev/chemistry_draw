//! Model delivery (B3): the bundled catalog, the resumable downloader and the
//! `/v2/models` routes.
//!
//! The suite never touches the real network and never downloads the real
//! ~324 MB artifacts. Each test builds a fresh app state with its own temporary
//! model root and a dummy catalog whose artifact URLs point at a local axum
//! server bound to `127.0.0.1:0`. The server serves a few KiB of dummy bytes,
//! answers HTTP Range requests and records every request it receives, so the
//! downloader's behaviour is observable without a socket outside loopback.
//!
//! Covered contracts (`docs/architecture.md` §7, "Model delivery (B3)"):
//!
//! - the bundled catalog pins both families' URLs, sizes, SHA-256, licenses,
//!   roles and the published total;
//! - catalog parsing rejects absolute and `..` artifact paths;
//! - `GET /v2/models` answers on an empty root with every model missing and the
//!   download idle, and creates nothing;
//! - a download installs every artifact, leaves no `.part`, writes the schema-1
//!   manifest with `catalog_version` and both model entries, and verify reports
//!   `ok`;
//! - a checksum mismatch fails the run, deletes the `.part`, publishes no
//!   manifest and names the expected and actual hashes; a corrupt installed
//!   artifact is reported and repaired, including when a valid manifest exists;
//! - a cancelled run keeps the `.part`, and the retry resumes with
//!   `Range: bytes=<kept>-` (206);
//! - a server that ignores Range (200) or answers 416 restarts the artifact and
//!   completes;
//! - an offline URL fails with the URL and a network hint, and a retry works
//!   once the server is up;
//! - the disk guard is a pure floor check plus an injected-probe integration
//!   test that fails before any request and writes nothing;
//! - `/v2/info` advertises the synthetic `local-ocsr` capability only when the
//!   manifest is usable and both models' artifacts exist;
//! - verify on an empty root reports every artifact missing with the repair
//!   hint;
//! - an older installed manifest updates and a newer one is a 409; a restart
//!   reports ready/idle without auto-resuming; a failed run retains the
//!   previous manifest and a successful one publishes the new one; `{}` is not
//!   a usable manifest; a broken catalog is a 500 while info/health degrade;
//! - 409/200 conflict semantics for download, cancel and verify.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_stream::wrappers::ReceiverStream;

use crate::service::ml::catalog::{bundled_catalog, ArtifactRole, Catalog, MAX_CATALOG_BYTES};
use crate::service::ml::download::ensure_space;
use crate::tests::*;

// ── Constants ─────────────────────────────────────────────────

/// Artifact path of the image classifier inside the model root.
const CLASSIFIER_PATH: &str = "image-classifier-fp16/classifier.fp16.onnx";
/// Artifact path of the OCSR encoder inside the model root.
const ENCODER_PATH: &str = "ocsr-handdrawn-fp32/encoder.onnx";
/// Artifact path of the OCSR decoder-step graph inside the model root.
const DECODER_PATH: &str = "ocsr-handdrawn-fp32/decoder_step.onnx";
/// Artifact path of the OCSR vocabulary inside the model root.
const VOCAB_PATH: &str = "ocsr-handdrawn-fp32/vocab.json";

/// Catalog version of the dummy catalogs. It is deliberately not the bundled
/// `1`, so a status body that reports it proves it comes from the injected
/// catalog.
const TEST_CATALOG_VERSION: u32 = 7;

/// Repair hint documented for every non-`ok` verify report.
const VERIFY_REPAIR_HINT: &str = "POST /v2/models/download";

/// Upper bound for every poll loop; the actual completion is much faster.
const POLL_TIMEOUT: Duration = Duration::from_secs(10);

/// Poll interval for the download status. The real client polls once per
/// second; the tests need a short interval, never a fixed sleep.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

// ── Temporary model roots ─────────────────────────────────────

/// Unique temporary model root, removed when the test finishes.
pub(crate) struct TempModelRoot {
    path: PathBuf,
}

impl TempModelRoot {
    /// A root that must not exist yet: the route must answer without it and
    /// the downloader must create it on demand.
    fn absent(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "chemistry-draw-model-delivery-{}-{label}-{nanos}",
            std::process::id()
        ));
        assert!(
            !path.exists(),
            "test needs an absent model directory: {path:?}"
        );
        Self { path }
    }

    pub(crate) fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.path.join(relative)
    }
}

impl Drop for TempModelRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Writes `bytes` at `relative` under `root`, creating the parent directories.
fn write_file(root: &TempModelRoot, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .unwrap_or_else(|error| panic!("could not create {parent:?}: {error}"));
    }
    std::fs::write(&path, bytes)
        .unwrap_or_else(|error| panic!("could not write {path:?}: {error}"));
}

/// Reads an installed artifact; the panic names the missing path.
fn read_file(root: &TempModelRoot, relative: &str) -> Vec<u8> {
    let path = root.join(relative);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{path:?} must exist: {error}"))
}

/// Reads and parses the generated manifest.
fn read_manifest(root: &TempModelRoot) -> Value {
    let path = root.join("manifest.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{path:?} must exist: {error}"));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{path:?} must be JSON: {error}"))
}

/// Every file under the model root, as forward-slash relative paths, sorted.
fn installed_files(root: &TempModelRoot) -> Vec<String> {
    fn walk(base: &Path, directory: &Path, files: &mut Vec<String>) {
        let entries = std::fs::read_dir(directory)
            .unwrap_or_else(|error| panic!("could not list {directory:?}: {error}"));
        for entry in entries {
            let entry =
                entry.unwrap_or_else(|error| panic!("could not read {directory:?}: {error}"));
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, files);
            } else {
                let relative = path
                    .strip_prefix(base)
                    .unwrap_or_else(|error| panic!("{path:?} must live under {base:?}: {error}"));
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    let base = root.path();
    let mut files = Vec::new();
    walk(&base, &base, &mut files);
    files.sort();
    files
}

/// The only files a successful run may leave: the manifest plus four artifacts.
fn expected_installed_files() -> Vec<String> {
    let mut files = [
        "manifest.json",
        CLASSIFIER_PATH,
        ENCODER_PATH,
        DECODER_PATH,
        VOCAB_PATH,
    ]
    .map(str::to_string)
    .to_vec();
    files.sort();
    files
}

// ── Dummy artifacts ───────────────────────────────────────────

/// The four small artifacts served by the test server.
struct DummyArtifacts {
    classifier: Vec<u8>,
    encoder: Vec<u8>,
    decoder: Vec<u8>,
    vocab: Vec<u8>,
}

impl DummyArtifacts {
    /// A few KiB per artifact: enough to exercise streaming, too small to slow
    /// the suite down.
    fn standard() -> Self {
        Self {
            classifier: vec![0x11; 4096],
            encoder: vec![0x22; 3072],
            decoder: vec![0x33; 2048],
            vocab: vec![0x44; 1024],
        }
    }

    /// A classifier large enough that a slow server can be cancelled mid-file.
    fn slow_classifier() -> Self {
        Self {
            classifier: vec![0x11; 64 * 1024],
            ..Self::standard()
        }
    }

    fn files(&self) -> [(&'static str, &[u8]); 4] {
        [
            (CLASSIFIER_PATH, &self.classifier),
            (ENCODER_PATH, &self.encoder),
            (DECODER_PATH, &self.decoder),
            (VOCAB_PATH, &self.vocab),
        ]
    }

    fn total(&self) -> u64 {
        self.files()
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

// ── Dummy catalog ─────────────────────────────────────────────

/// Builds the documented catalog JSON with `classifier_path` as the classifier
/// artifact path. The other three artifacts are always the dummy ones, so the
/// fixture is a complete, otherwise-valid catalog.
///
/// The JSON follows the documented schema (`docs/architecture.md` §7):
/// `catalog_version` plus a `models` map, per-model provenance, license,
/// settings and artifacts with `role`/`path`/`url`/`size`/`sha256`, and the
/// graph contracts the generated manifest must copy.
fn dummy_catalog_json(base_url: &str, artifacts: &DummyArtifacts, classifier_path: &str) -> Value {
    let url = |relative: &str| format!("{base_url}/{relative}");

    json!({
        "catalog_version": TEST_CATALOG_VERSION,
        "models": {
            "image-classifier": {
                "id": "image-classifier@test/dummy",
                "version": "test/dummy",
                "license": "MIT",
                "source": base_url,
                "preprocessing": "runtime_default",
                "threshold": 0.000089,
                "artifacts": [{
                    "role": "classifier",
                    "path": classifier_path,
                    "url": url(classifier_path),
                    "size": artifacts.classifier.len(),
                    "sha256": sha256_hex(&artifacts.classifier),
                    "inputs": [
                        { "name": "input_2", "dtype": "float32", "shape": [1, 224, 224, 3] },
                        { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
                        { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
                    ],
                    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
                }]
            },
            "ocsr-handdrawn": {
                "id": "ocsr-handdrawn@test/dummy",
                "version": "test/dummy",
                "license": "CC-BY-4.0",
                "source": base_url,
                "preprocessing": "decimer_ocsr",
                "start_id": 13,
                "end_id": 14,
                "max_len": 302,
                "confidence_threshold": 0.901,
                "artifacts": [
                    {
                        "role": "encoder",
                        "path": ENCODER_PATH,
                        "url": url(ENCODER_PATH),
                        "size": artifacts.encoder.len(),
                        "sha256": sha256_hex(&artifacts.encoder),
                        "inputs": [
                            { "name": "image", "dtype": "float32", "shape": [1, 512, 512, 3] }
                        ],
                        "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 256, 512] }
                    },
                    {
                        "role": "decoder",
                        "path": DECODER_PATH,
                        "url": url(DECODER_PATH),
                        "size": artifacts.decoder.len(),
                        "sha256": sha256_hex(&artifacts.decoder),
                        "inputs": [
                            { "name": "tokens", "dtype": "int32", "shape": [1, -1] },
                            { "name": "enc_out", "dtype": "float32", "shape": [1, 256, 512] }
                        ],
                        "zero_inputs": [],
                        "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, -1, 156] }
                    },
                    {
                        "role": "vocab",
                        "path": VOCAB_PATH,
                        "url": url(VOCAB_PATH),
                        "size": artifacts.vocab.len(),
                        "sha256": sha256_hex(&artifacts.vocab)
                    }
                ]
            }
        }
    })
}

/// Builds a valid catalog whose artifact URLs point at `base_url`.
fn dummy_catalog(base_url: &str, artifacts: &DummyArtifacts) -> Catalog {
    let value = dummy_catalog_json(base_url, artifacts, CLASSIFIER_PATH);
    Catalog::from_json(&value.to_string()).expect("the dummy catalog must be valid")
}

/// A complete catalog JSON whose classifier artifact path is `path`, used to
/// pin the path validation rules.
fn catalog_json_with_path(path: &str) -> String {
    dummy_catalog_json(
        "https://example.invalid/chemistry-draw-ocsr",
        &DummyArtifacts::standard(),
        path,
    )
    .to_string()
}

/// Writes the four dummy artifacts under `root`.
fn write_dummy_artifacts(root: &TempModelRoot, artifacts: &DummyArtifacts) {
    for (relative, bytes) in artifacts.files() {
        write_file(root, relative, bytes);
    }
}

/// Stages a complete install: the four dummy artifacts plus a schema-1 manifest
/// recording `catalog_version`.
fn stage_install(root: &TempModelRoot, artifacts: &DummyArtifacts, catalog_version: u64) {
    write_dummy_artifacts(root, artifacts);
    let manifest = staged_manifest_with_version(artifacts, catalog_version);
    write_file(root, "manifest.json", manifest.to_string().as_bytes());
}

/// The schema-1 manifest a complete install would leave behind, written by the
/// test so the capability gate can be exercised without a download.
fn staged_manifest(artifacts: &DummyArtifacts) -> Value {
    staged_manifest_with_version(artifacts, 1)
}

/// The same staged manifest with an explicit `catalog_version`, used by the
/// update/downgrade and repair tests.
fn staged_manifest_with_version(artifacts: &DummyArtifacts, catalog_version: u64) -> Value {
    json!({
        "schema": 1,
        "catalog_version": catalog_version,
        "models": {
            "image-classifier": {
                "id": "image-classifier@Iagea/d21f4cb",
                "file": CLASSIFIER_PATH,
                "artifact_sha256": sha256_hex(&artifacts.classifier),
                "threshold": 0.000089,
                "preprocessing": "runtime_default",
                "inputs": [
                    { "name": "input_2", "dtype": "float32", "shape": [1, 224, 224, 3] },
                    { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
                    { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
                ],
                "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
            },
            "ocsr-handdrawn": {
                "id": "ocsr-handdrawn@zenodo:10781330",
                "preprocessing": "decimer_ocsr",
                "start_id": 13,
                "end_id": 14,
                "max_len": 302,
                "confidence_threshold": 0.901,
                "encoder": {
                    "file": ENCODER_PATH,
                    "artifact_sha256": sha256_hex(&artifacts.encoder),
                    "inputs": [
                        { "name": "image", "dtype": "float32", "shape": [1, 512, 512, 3] }
                    ],
                    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 256, 512] }
                },
                "decoder": {
                    "file": DECODER_PATH,
                    "artifact_sha256": sha256_hex(&artifacts.decoder),
                    "inputs": [
                        { "name": "tokens", "dtype": "int32", "shape": [1, -1] },
                        { "name": "enc_out", "dtype": "float32", "shape": [1, 256, 512] }
                    ],
                    "zero_inputs": [],
                    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, -1, 156] }
                },
                "vocab": {
                    "file": VOCAB_PATH,
                    "artifact_sha256": sha256_hex(&artifacts.vocab)
                }
            }
        }
    })
}

/// A temp root with both models installed: the four dummy artifacts and a
/// manifest the existing registry accepts. Used by the `/v2/info` capability
/// tests in `recognition.rs`.
pub(crate) fn installed_model_root(label: &str) -> TempModelRoot {
    let root = TempModelRoot::absent(label);
    let artifacts = DummyArtifacts::standard();
    write_dummy_artifacts(&root, &artifacts);
    let manifest = staged_manifest(&artifacts);
    write_file(&root, "manifest.json", manifest.to_string().as_bytes());
    root
}

// ── Local HTTP test server ────────────────────────────────────

/// How the server writes an artifact body.
#[derive(Clone, Copy, Debug)]
enum ServeMode {
    /// One response with the whole body.
    Fast,
    /// One chunk every `delay`, so a run can be cancelled mid-file.
    Slow { chunk_size: usize, delay: Duration },
    /// Answers `200` with the full body even when the request carried `Range`
    /// (a proxy/CDN that ignores resume requests).
    IgnoreRange,
    /// Answers `416` to a request with `Range`; a request without it gets the
    /// body. Exercises the truncate-and-restart branch.
    RejectRange,
}

#[derive(Clone)]
struct ServedFile {
    bytes: Arc<Vec<u8>>,
    mode: ServeMode,
}

/// One recorded request. The `Range` header and the response status prove
/// whether a resume happened.
#[derive(Clone, Debug)]
struct ServerRequest {
    path: String,
    range: Option<String>,
    status: u16,
}

struct ServerState {
    files: Mutex<HashMap<String, ServedFile>>,
    log: Mutex<Vec<ServerRequest>>,
}

/// A local axum server serving dummy artifacts with Range support.
///
/// The server is spawned on the test runtime and dies with it; no shutdown
/// handle is needed. Every request is recorded so the tests can assert exactly
/// which artifacts were fetched and whether a resume used `Range`.
struct TestServer {
    base_url: String,
    state: Arc<ServerState>,
}

impl TestServer {
    /// Starts the server on an ephemeral loopback port.
    async fn start(artifacts: &DummyArtifacts) -> Self {
        Self::start_on(0, artifacts).await
    }

    /// Starts the server on `port`; `0` picks an ephemeral port.
    async fn start_on(port: u16, artifacts: &DummyArtifacts) -> Self {
        let files = artifacts
            .files()
            .into_iter()
            .map(|(relative, bytes)| {
                (
                    format!("/{relative}"),
                    ServedFile {
                        bytes: Arc::new(bytes.to_vec()),
                        mode: ServeMode::Fast,
                    },
                )
            })
            .collect();

        let state = Arc::new(ServerState {
            files: Mutex::new(files),
            log: Mutex::new(Vec::new()),
        });

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap_or_else(|error| {
                panic!("could not bind the test server on 127.0.0.1:{port}: {error}")
            });
        let address = listener
            .local_addr()
            .expect("the bound listener must have a local address");
        let app = Router::new().fallback(serve).with_state(Arc::clone(&state));
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("the test server must keep serving");
        });

        Self {
            base_url: format!("http://127.0.0.1:{}", address.port()),
            state,
        }
    }

    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Makes the artifact drip out in `chunk_size` pieces every `delay`.
    fn slow(&self, relative: &str, chunk_size: usize, delay: Duration) {
        self.set_mode(relative, ServeMode::Slow { chunk_size, delay });
    }

    /// Restores a fast response for later requests (for example the resume).
    fn fast(&self, relative: &str) {
        self.set_mode(relative, ServeMode::Fast);
    }

    /// Makes the artifact ignore `Range` and answer `200` with the full body.
    fn ignores_range(&self, relative: &str) {
        self.set_mode(relative, ServeMode::IgnoreRange);
    }

    /// Makes the artifact answer `416` to a range request.
    fn rejects_range(&self, relative: &str) {
        self.set_mode(relative, ServeMode::RejectRange);
    }

    fn set_mode(&self, relative: &str, mode: ServeMode) {
        let path = format!("/{relative}");
        let mut files = self
            .state
            .files
            .lock()
            .expect("the file map lock is healthy");
        let file = files
            .get_mut(&path)
            .unwrap_or_else(|| panic!("no test artifact is served at {path}"));
        file.mode = mode;
    }

    /// Replaces the served bytes (used for checksum and repair scenarios).
    fn replace_bytes(&self, relative: &str, bytes: Vec<u8>) {
        let path = format!("/{relative}");
        let mut files = self
            .state
            .files
            .lock()
            .expect("the file map lock is healthy");
        let file = files
            .get_mut(&path)
            .unwrap_or_else(|| panic!("no test artifact is served at {path}"));
        file.bytes = Arc::new(bytes);
    }

    fn requests(&self) -> Vec<ServerRequest> {
        self.state
            .log
            .lock()
            .expect("the request log lock is healthy")
            .clone()
    }

    fn request_count(&self) -> usize {
        self.state
            .log
            .lock()
            .expect("the request log lock is healthy")
            .len()
    }

    fn requests_for(&self, relative: &str) -> Vec<ServerRequest> {
        let path = format!("/{relative}");
        self.requests()
            .into_iter()
            .filter(|request| request.path == path)
            .collect()
    }
}

fn record(state: &ServerState, path: &str, range: Option<String>, status: StatusCode) {
    state
        .log
        .lock()
        .expect("the request log lock is healthy")
        .push(ServerRequest {
            path: path.to_string(),
            range,
            status: status.as_u16(),
        });
}

/// Parses the start offset of an open-ended `bytes=<start>-` Range header.
fn parse_range_start(value: &str) -> Option<u64> {
    let spec = value.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    if !end.is_empty() {
        return None;
    }
    start.trim().parse().ok()
}

/// Builds a streamed body that yields `chunk_size` bytes every `delay`.
fn slow_body(data: Arc<Vec<u8>>, start: usize, chunk_size: usize, delay: Duration) -> Body {
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        for chunk in data[start..].chunks(chunk_size) {
            if sender
                .send(Ok(Bytes::copy_from_slice(chunk)))
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(delay).await;
        }
    });
    Body::from_stream(ReceiverStream::new(receiver))
}

async fn serve(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let file = state
        .files
        .lock()
        .expect("the file map lock is healthy")
        .get(&path)
        .cloned();
    let Some(file) = file else {
        record(&state, &path, range, StatusCode::NOT_FOUND);
        return StatusCode::NOT_FOUND.into_response();
    };

    let total = file.bytes.len();

    // A server that rejects resume requests: every range request is a 416, a
    // request without Range gets the body.
    if matches!(file.mode, ServeMode::RejectRange) && range.is_some() {
        record(&state, &path, range, StatusCode::RANGE_NOT_SATISFIABLE);
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Body::empty())
            .expect("the 416 response must build");
    }

    let (status, start) = if matches!(file.mode, ServeMode::IgnoreRange) {
        (StatusCode::OK, 0)
    } else {
        let start = match range.as_deref().map(parse_range_start) {
            Some(Some(start)) if start < total as u64 => start as usize,
            Some(Some(_)) => {
                record(&state, &path, range, StatusCode::RANGE_NOT_SATISFIABLE);
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Body::empty())
                    .expect("the 416 response must build");
            }
            _ => 0,
        };
        let status = if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        (status, start)
    };

    let body = match file.mode {
        ServeMode::Slow { chunk_size, delay } => {
            slow_body(Arc::clone(&file.bytes), start, chunk_size, delay)
        }
        ServeMode::Fast | ServeMode::IgnoreRange | ServeMode::RejectRange => {
            Body::from(file.bytes[start..].to_vec())
        }
    };
    record(&state, &path, range, status);

    let mut response = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (total - start).to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{total}", total - 1),
        );
    }
    response
        .body(body)
        .expect("the artifact response must build")
}

/// Reserves a loopback port and releases it, so a catalog can point at a port
/// where nothing is listening yet.
async fn free_port() -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("the port probe must bind");
    listener
        .local_addr()
        .expect("the port probe must have an address")
        .port()
}

// ── Polling helpers ───────────────────────────────────────────

/// Polls `GET /v2/models` until `predicate` holds or the deadline passes.
async fn poll_models(app: &Router, predicate: impl Fn(&Value) -> bool, timeout: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let (status, body) = fetch_get(app, "/v2/models").await;
        assert_eq!(
            status,
            StatusCode::OK,
            "GET /v2/models must answer 200 while polling, got body: {body}"
        );
        if predicate(&body) {
            return body;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "GET /v2/models never reached the expected state within {timeout:?}; last body: {body}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Polls until the download state is exactly `state`.
async fn wait_for_state(app: &Router, state: &str, timeout: Duration) -> Value {
    poll_models(app, |body| body["download"]["state"] == state, timeout).await
}

// ── Bundled catalog pins ──────────────────────────────────────

/// The classifier entry pins the published provenance, license, settings and
/// the single artifact's URL, size and SHA-256.
#[test]
fn bundled_catalog_pins_the_classifier_artifact() {
    let catalog = bundled_catalog();

    assert_eq!(
        catalog.catalog_version, 1,
        "the bundled catalog version is part of the contract"
    );
    assert_eq!(
        catalog.models.len(),
        2,
        "the bundled catalog pins both model families"
    );

    let model = catalog
        .models
        .get("image-classifier")
        .expect("the bundled catalog must declare the image classifier");
    assert_eq!(model.id, "image-classifier@Iagea/d21f4cb");
    assert_eq!(model.version, "Iagea/d21f4cb");
    assert_eq!(model.license, "MIT");
    assert_eq!(
        model.source, "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
        "the provenance source is the pinned Hugging Face repository"
    );
    assert_eq!(model.preprocessing, "runtime_default");
    assert_eq!(model.threshold, Some(0.000089));
    assert_eq!(model.artifacts.len(), 1);

    let artifact = &model.artifacts[0];
    assert_eq!(artifact.role, ArtifactRole::Classifier);
    assert_eq!(artifact.path, CLASSIFIER_PATH);
    assert_eq!(
        artifact.url,
        "https://huggingface.co/spalax-dev/chemistry-draw-ocsr/resolve/main/image-classifier-fp16/classifier.fp16.onnx"
    );
    assert_eq!(artifact.size, 8_162_917);
    assert_eq!(
        artifact.sha256,
        "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9"
    );
}

/// The OCSR entry pins the provenance, CC-BY-4.0 license, decode settings and
/// the three artifacts in catalog order.
#[test]
fn bundled_catalog_pins_the_ocsr_artifacts() {
    let catalog = bundled_catalog();
    let model = catalog
        .models
        .get("ocsr-handdrawn")
        .expect("the bundled catalog must declare the OCSR model");

    assert_eq!(model.id, "ocsr-handdrawn@zenodo:10781330");
    assert_eq!(model.version, "zenodo:10781330");
    assert_eq!(model.license, "CC-BY-4.0");
    assert_eq!(
        model.source, "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
        "the provenance source is the pinned Hugging Face repository"
    );
    assert_eq!(model.preprocessing, "decimer_ocsr");
    assert_eq!(model.start_id, Some(13));
    assert_eq!(model.end_id, Some(14));
    assert_eq!(model.max_len, Some(302));
    assert_eq!(model.confidence_threshold, Some(0.901));
    assert_eq!(model.artifacts.len(), 3);

    let expected = [
        (
            ArtifactRole::Encoder,
            ENCODER_PATH,
            208_801_677_u64,
            "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
        ),
        (
            ArtifactRole::Decoder,
            DECODER_PATH,
            107_017_280_u64,
            "cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197",
        ),
        (
            ArtifactRole::Vocab,
            VOCAB_PATH,
            5_316_u64,
            "62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd",
        ),
    ];

    for (artifact, (role, path, size, sha256)) in model.artifacts.iter().zip(expected) {
        assert_eq!(artifact.role, role);
        assert_eq!(artifact.path, path);
        assert_eq!(artifact.size, size);
        assert_eq!(artifact.sha256, sha256);
        assert_eq!(
            artifact.url,
            format!("https://huggingface.co/spalax-dev/chemistry-draw-ocsr/resolve/main/{path}"),
            "every artifact URL is the pinned repository URL plus its path"
        );
    }
}

/// The four published sizes add up to the documented total.
#[test]
fn bundled_catalog_total_matches_the_published_size() {
    let total: u64 = bundled_catalog()
        .models
        .values()
        .flat_map(|model| &model.artifacts)
        .map(|artifact| artifact.size)
        .sum();

    assert_eq!(
        total, 323_987_190,
        "the bundled catalog must pin the published 323,987,190 bytes"
    );
}

// ── Catalog validation ────────────────────────────────────────

/// An artifact path is relative to the model root; an absolute path must be
/// rejected instead of writing outside the root.
#[test]
fn catalog_rejects_an_absolute_artifact_path() {
    let raw = catalog_json_with_path("/etc/chemistry-draw/classifier.onnx");

    let error = Catalog::from_json(&raw)
        .expect_err("an absolute artifact path must be rejected as a catalog error");
    let message = format!("{error:#}").to_lowercase();

    assert!(
        message.contains("absolute"),
        "the catalog error must explain that the path is absolute, got: {message}"
    );
    assert!(
        message.contains("classifier.onnx"),
        "the catalog error must name the offending path, got: {message}"
    );
}

/// A `..` component would escape the model root and must be rejected.
#[test]
fn catalog_rejects_a_parent_directory_artifact_path() {
    let raw = catalog_json_with_path("../escape/classifier.onnx");

    let error = Catalog::from_json(&raw)
        .expect_err("a `..` artifact path must be rejected as a catalog error");
    let message = format!("{error:#}").to_lowercase();

    assert!(
        message.contains("../escape"),
        "the catalog error must name the escaping path, got: {message}"
    );
}

/// The declared total is summed with an overflow check and an upper bound, so a
/// hostile or corrupted override cannot wrap the byte count the preflight
/// trusts.
#[test]
fn catalog_rejects_an_overflowing_or_absurd_total_size() {
    let artifacts = DummyArtifacts::standard();

    let mut overflow = dummy_catalog_json("http://127.0.0.1:9", &artifacts, CLASSIFIER_PATH);
    overflow["models"]["image-classifier"]["artifacts"][0]["size"] = json!(u64::MAX);
    overflow["models"]["ocsr-handdrawn"]["artifacts"][0]["size"] = json!(2_u64);
    let error = Catalog::from_json(&overflow.to_string())
        .expect_err("a total that overflows u64 must be rejected");
    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("overflow"),
        "the catalog error must explain the overflow, got: {message}"
    );

    let mut too_large = dummy_catalog_json("http://127.0.0.1:9", &artifacts, CLASSIFIER_PATH);
    too_large["models"]["image-classifier"]["artifacts"][0]["size"] = json!(MAX_CATALOG_BYTES + 1);
    let error = Catalog::from_json(&too_large.to_string())
        .expect_err("a total above the supported maximum must be rejected");
    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("maximum"),
        "the catalog error must name the supported maximum, got: {message}"
    );
}

// ── Status with an empty root ─────────────────────────────────

/// `GET /v2/models` answers on a missing root without creating it, reports
/// every model missing and leaves the download idle.
#[tokio::test]
async fn status_with_an_empty_root_reports_every_model_missing() {
    let root = TempModelRoot::absent("status-empty");
    let artifacts = DummyArtifacts::standard();
    let catalog = dummy_catalog("http://127.0.0.1:9", &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, body) = fetch_get(&app, "/v2/models").await;

    assert_eq!(
        status,
        StatusCode::OK,
        "an empty root must still answer 200"
    );
    assert_eq!(body["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(body["installed_catalog_version"], Value::Null);
    assert_eq!(body["update_available"], false);
    assert_eq!(body["ready"], false);
    assert_eq!(body["manifest_present"], false);
    assert_eq!(body["total_bytes"], json!(artifacts.total()));
    assert_eq!(body["installed_bytes"], json!(0));

    let models = body["models"]
        .as_array()
        .unwrap_or_else(|| panic!("models must be an array, got: {body}"));
    assert_eq!(models.len(), 2);

    let classifier = models
        .iter()
        .find(|model| model["key"] == "image-classifier")
        .unwrap_or_else(|| panic!("the status must list the classifier, got: {models:?}"));
    assert_eq!(classifier["id"], "image-classifier@test/dummy");
    assert_eq!(classifier["version"], "test/dummy");
    assert_eq!(classifier["license"], "MIT");
    assert_eq!(classifier["total_bytes"], json!(artifacts.classifier.len()));
    assert_eq!(classifier["installed_bytes"], json!(0));
    assert_eq!(classifier["installed"], false);
    assert_eq!(classifier["missing"], json!([CLASSIFIER_PATH]));

    let ocsr = models
        .iter()
        .find(|model| model["key"] == "ocsr-handdrawn")
        .unwrap_or_else(|| panic!("the status must list the OCSR model, got: {models:?}"));
    assert_eq!(ocsr["id"], "ocsr-handdrawn@test/dummy");
    assert_eq!(ocsr["license"], "CC-BY-4.0");
    assert_eq!(
        ocsr["total_bytes"],
        json!(artifacts.total() - artifacts.classifier.len() as u64)
    );
    assert_eq!(ocsr["installed"], false);
    assert_eq!(
        ocsr["missing"],
        json!([ENCODER_PATH, DECODER_PATH, VOCAB_PATH]),
        "missing lists every artifact in catalog order"
    );

    assert_eq!(body["download"]["state"], "idle");
    assert_eq!(body["download"]["downloaded_bytes"], json!(0));
    assert_eq!(body["download"]["total_bytes"], json!(artifacts.total()));
    assert_eq!(body["download"]["current_file"], Value::Null);
    assert_eq!(body["download"]["error"], Value::Null);

    assert!(
        !root.path().exists(),
        "GET /v2/models must not create the model root"
    );
}

// ── Download success and manifest generation ─────────────────

/// A full run installs every artifact, leaves no `.part`, writes the schema-1
/// manifest and reports the installed state; verify then reports `ok`.
#[tokio::test]
async fn download_installs_artifacts_and_writes_the_manifest() {
    let root = TempModelRoot::absent("download-success");
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, body) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "starting a download must be 202, got body: {body}"
    );
    assert!(
        body["download"].is_object(),
        "the download response must carry the status body, got: {body}"
    );

    let ready = wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    assert_eq!(ready["ready"], true, "a complete run must be ready");
    assert_eq!(ready["manifest_present"], true);
    assert_eq!(
        ready["installed_catalog_version"],
        json!(TEST_CATALOG_VERSION)
    );
    assert_eq!(ready["update_available"], false);
    assert_eq!(ready["installed_bytes"], json!(artifacts.total()));
    assert_eq!(ready["total_bytes"], json!(artifacts.total()));
    assert_eq!(
        ready["download"]["downloaded_bytes"],
        json!(artifacts.total())
    );
    assert_eq!(ready["download"]["current_file"], Value::Null);
    assert_eq!(ready["download"]["error"], Value::Null);

    for (relative, bytes) in artifacts.files() {
        assert_eq!(
            read_file(&root, relative),
            bytes,
            "{relative} must be installed byte-identically"
        );
        assert_eq!(
            server.requests_for(relative).len(),
            1,
            "{relative} must be fetched exactly once"
        );
    }
    assert_eq!(
        installed_files(&root),
        expected_installed_files(),
        "a successful run must leave only the four artifacts and the manifest (no .part)"
    );

    let manifest = read_manifest(&root);
    assert_eq!(manifest["schema"], json!(1));
    assert_eq!(manifest["catalog_version"], json!(TEST_CATALOG_VERSION));
    let models = manifest["models"]
        .as_object()
        .unwrap_or_else(|| panic!("the manifest must carry a models map, got: {manifest}"));
    assert_eq!(models.len(), 2);

    let classifier = &manifest["models"]["image-classifier"];
    assert_eq!(classifier["id"], "image-classifier@test/dummy");
    assert_eq!(classifier["file"], CLASSIFIER_PATH);
    assert_eq!(
        classifier["artifact_sha256"],
        sha256_hex(&artifacts.classifier)
    );
    assert_eq!(classifier["source"], server.base_url());
    assert_eq!(classifier["license"], "MIT");
    assert_eq!(classifier["threshold"], json!(0.000089));
    assert_eq!(classifier["preprocessing"], "runtime_default");
    let inputs = classifier["inputs"]
        .as_array()
        .unwrap_or_else(|| panic!("the classifier entry must copy the inputs, got: {classifier}"));
    assert_eq!(inputs.len(), 3);
    assert_eq!(inputs[0]["name"], "input_2");
    assert_eq!(inputs[0]["shape"], json!([1, 224, 224, 3]));
    assert_eq!(classifier["output"]["name"], "Identity:0");

    let ocsr = &manifest["models"]["ocsr-handdrawn"];
    assert_eq!(ocsr["id"], "ocsr-handdrawn@test/dummy");
    assert_eq!(ocsr["source"], server.base_url());
    assert_eq!(ocsr["license"], "CC-BY-4.0");
    assert_eq!(ocsr["preprocessing"], "decimer_ocsr");
    assert_eq!(ocsr["start_id"], json!(13));
    assert_eq!(ocsr["end_id"], json!(14));
    assert_eq!(ocsr["max_len"], json!(302));
    assert_eq!(ocsr["confidence_threshold"], json!(0.901));
    assert_eq!(ocsr["encoder"]["file"], ENCODER_PATH);
    assert_eq!(
        ocsr["encoder"]["artifact_sha256"],
        sha256_hex(&artifacts.encoder)
    );
    assert_eq!(ocsr["encoder"]["inputs"][0]["name"], "image");
    assert_eq!(ocsr["decoder"]["file"], DECODER_PATH);
    assert_eq!(ocsr["decoder"]["zero_inputs"], json!([]));
    assert_eq!(ocsr["vocab"]["file"], VOCAB_PATH);
    assert_eq!(
        ocsr["vocab"]["artifact_sha256"],
        sha256_hex(&artifacts.vocab)
    );

    // The manifest is the loading contract: the existing registry must accept
    // it and report both models as available.
    let ids = crate::service::ml::registry::available_model_ids(&root.path());
    assert_eq!(
        ids,
        ["image-classifier@test/dummy", "ocsr-handdrawn@test/dummy"],
        "the generated manifest must parse through the existing registry"
    );

    let (status, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["ok"], true);
    assert_eq!(report["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(report["checked_bytes"], json!(artifacts.total()));
    assert_eq!(report["repair"], Value::Null);
    let entries = report["artifacts"]
        .as_array()
        .unwrap_or_else(|| panic!("verify must list every artifact, got: {report}"));
    assert_eq!(entries.len(), 4);
    for (entry, relative) in
        entries
            .iter()
            .zip([CLASSIFIER_PATH, ENCODER_PATH, DECODER_PATH, VOCAB_PATH])
    {
        assert_eq!(entry["path"], relative);
        assert_eq!(entry["status"], "ok");
    }
}

// ── Checksum mismatch ─────────────────────────────────────────

/// Wrong bytes from the server fail the run: the `.part` is deleted, the final
/// file is never published, no manifest appears and the error names the path
/// and both hashes.
#[tokio::test]
async fn checksum_mismatch_fails_without_publishing_a_manifest() {
    let root = TempModelRoot::absent("checksum-mismatch");
    let artifacts = DummyArtifacts::standard();
    let mut wrong_encoder = artifacts.encoder.clone();
    wrong_encoder[0] ^= 0xff;
    let wrong_sha256 = sha256_hex(&wrong_encoder);

    let server = TestServer::start(&artifacts).await;
    server.replace_bytes(ENCODER_PATH, wrong_encoder);
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let failed = wait_for_state(&app, "failed", POLL_TIMEOUT).await;
    let error = failed["download"]["error"]
        .as_str()
        .unwrap_or_else(|| panic!("a failed run must carry an error string, got: {failed}"));
    assert!(
        error.contains(ENCODER_PATH),
        "the checksum error must name the artifact path, got: {error}"
    );
    assert!(
        error.contains(&sha256_hex(&artifacts.encoder)),
        "the checksum error must name the expected SHA-256, got: {error}"
    );
    assert!(
        error.contains(&wrong_sha256),
        "the checksum error must name the actual SHA-256, got: {error}"
    );

    assert_eq!(failed["ready"], false);
    assert_eq!(failed["manifest_present"], false);
    assert!(
        !root.join("manifest.json").exists(),
        "a failed run must not publish a manifest"
    );
    assert!(
        !root.join(ENCODER_PATH).exists(),
        "a checksum mismatch must never install the artifact"
    );
    assert!(
        !root.join(format!("{ENCODER_PATH}.part")).exists(),
        "a checksum mismatch must delete the .part"
    );
    assert!(
        root.join(CLASSIFIER_PATH).is_file(),
        "the artifact before the failure is installed and kept"
    );

    let (status, info) = fetch_get(&app, "/v2/info").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        info["imago_versions"],
        json!([]),
        "without a published manifest the capability stays disabled"
    );
}

/// A corrupt installed artifact is reported with expected and actual hashes;
/// a following download re-hashes it, replaces it and rewrites the manifest.
#[tokio::test]
async fn verify_reports_a_corrupt_artifact_and_download_repairs_it() {
    let root = TempModelRoot::absent("verify-repair");
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    // A same-size corrupt encoder at its final path: verify must call it
    // `corrupt` (hash mismatch), not `missing`.
    let mut corrupt_encoder = artifacts.encoder.clone();
    corrupt_encoder[0] ^= 0xff;
    let corrupt_sha256 = sha256_hex(&corrupt_encoder);
    write_file(&root, ENCODER_PATH, &corrupt_encoder);

    let (status, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["ok"], false);
    assert_eq!(report["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(
        report["checked_bytes"],
        json!(artifacts.encoder.len()),
        "verify only reads the present artifacts"
    );
    assert_eq!(report["repair"], VERIFY_REPAIR_HINT);
    let entries = report["artifacts"]
        .as_array()
        .unwrap_or_else(|| panic!("verify must list every artifact, got: {report}"));
    let encoder = entries
        .iter()
        .find(|entry| entry["path"] == ENCODER_PATH)
        .unwrap_or_else(|| panic!("verify must report the corrupt encoder, got: {entries:?}"));
    assert_eq!(encoder["status"], "corrupt");
    assert_eq!(encoder["expected_sha256"], sha256_hex(&artifacts.encoder));
    assert_eq!(encoder["actual_sha256"], corrupt_sha256);
    for relative in [CLASSIFIER_PATH, DECODER_PATH, VOCAB_PATH] {
        let entry = entries
            .iter()
            .find(|entry| entry["path"] == relative)
            .unwrap_or_else(|| panic!("verify must report {relative}, got: {entries:?}"));
        assert_eq!(entry["status"], "missing");
    }

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "the repair path is a normal download"
    );
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    assert_eq!(
        read_file(&root, ENCODER_PATH),
        artifacts.encoder,
        "the repair run must replace the corrupt bytes"
    );
    assert!(
        root.join("manifest.json").is_file(),
        "a repaired install must publish the manifest"
    );
    let (_, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(report["ok"], true);
    assert_eq!(report["repair"], Value::Null);
}

// ── Cancel and Range resume ───────────────────────────────────

/// A slow response is cancelled mid-file: the `.part` survives and the retry
/// resumes with `Range: bytes=<kept>-`, answered with 206.
#[tokio::test]
async fn cancel_keeps_the_partial_file_and_resume_uses_range() {
    let root = TempModelRoot::absent("cancel-resume");
    let artifacts = DummyArtifacts::slow_classifier();
    let server = TestServer::start(&artifacts).await;
    server.slow(CLASSIFIER_PATH, 1024, Duration::from_millis(25));
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let downloading = poll_models(
        &app,
        |body| {
            body["download"]["state"] == "downloading"
                && body["download"]["current_file"] == CLASSIFIER_PATH
                && body["download"]["downloaded_bytes"].as_u64().unwrap_or(0) > 0
        },
        POLL_TIMEOUT,
    )
    .await;
    assert_eq!(
        downloading["download"]["error"],
        Value::Null,
        "a running download carries no error"
    );

    let (status, _) = post_json(&app, "/v2/models/download/cancel", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "cancelling a running download must be 202"
    );

    let cancelled = wait_for_state(&app, "cancelled", POLL_TIMEOUT).await;
    assert_eq!(cancelled["download"]["error"], Value::Null);
    assert_eq!(cancelled["ready"], false);
    assert_eq!(cancelled["manifest_present"], false);

    let part = root.join(format!("{CLASSIFIER_PATH}.part"));
    let kept = std::fs::read(&part)
        .unwrap_or_else(|error| panic!("a cancelled run must keep {part:?}: {error}"));
    assert!(
        !kept.is_empty(),
        "a cancelled run must keep the bytes already downloaded"
    );
    assert!(
        kept.len() < artifacts.classifier.len(),
        "the run must have been cancelled mid-file, kept {} of {} bytes",
        kept.len(),
        artifacts.classifier.len()
    );
    assert_eq!(
        cancelled["download"]["downloaded_bytes"],
        json!(kept.len()),
        "the status must report the kept .part length"
    );
    assert!(
        !root.join(CLASSIFIER_PATH).exists(),
        "a cancelled run must not install a partial file"
    );

    // The retry resumes: make the rest fast so the test does not wait for the
    // slow drip again.
    server.fast(CLASSIFIER_PATH);
    let requests_before = server.requests_for(CLASSIFIER_PATH).len();
    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "a retry after a cancel must start a new run"
    );
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    let requests = server.requests_for(CLASSIFIER_PATH);
    assert!(
        requests.len() > requests_before,
        "the resumed run must fetch the classifier again"
    );
    let resumed = &requests[requests_before];
    let expected_range = format!("bytes={}-", kept.len());
    assert_eq!(
        resumed.range.as_deref(),
        Some(expected_range.as_str()),
        "the resumed run must ask for the bytes it already has"
    );
    assert_eq!(
        resumed.status, 206,
        "a range request must be answered with 206 Partial Content"
    );

    assert_eq!(
        read_file(&root, CLASSIFIER_PATH),
        artifacts.classifier,
        "the resumed file must be byte-identical to the served artifact"
    );
    assert!(
        !part.exists(),
        "a completed artifact must not leave a .part behind"
    );
}

// ── Offline and retry ─────────────────────────────────────────

/// A catalog URL pointing at a closed port fails with the URL and a network
/// hint; the same app succeeds once the server is listening on that port.
#[tokio::test]
async fn offline_download_fails_with_an_actionable_error_and_retry_succeeds() {
    let root = TempModelRoot::absent("offline-retry");
    let artifacts = DummyArtifacts::standard();
    let port = free_port().await;
    let base_url = format!("http://127.0.0.1:{port}");
    let catalog = dummy_catalog(&base_url, &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let failed = wait_for_state(&app, "failed", POLL_TIMEOUT).await;
    let error = failed["download"]["error"]
        .as_str()
        .unwrap_or_else(|| panic!("an offline run must carry an error string, got: {failed}"));
    let url = format!("{base_url}/{CLASSIFIER_PATH}");
    assert!(
        error.contains(&url),
        "the offline error must name the URL, got: {error}"
    );
    assert!(
        error.to_lowercase().contains("network"),
        "the offline error must ask to check the network, got: {error}"
    );
    assert_eq!(failed["ready"], false);
    assert_eq!(failed["manifest_present"], false);

    // The failure must not take Indigo or the status route down.
    let (status, info) = fetch_get(&app, "/v2/info").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["imago_versions"], json!([]));

    // The server comes up on the same port; the retry works.
    let server = TestServer::start_on(port, &artifacts).await;
    assert_eq!(server.base_url(), base_url);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    assert_eq!(
        read_file(&root, CLASSIFIER_PATH),
        artifacts.classifier,
        "the retry must install the artifact"
    );
    assert!(root.join("manifest.json").is_file());
}

// ── Disk guard (pure) ─────────────────────────────────────────

/// The preflight is a floor: available >= required passes, including equality.
#[test]
fn ensure_space_accepts_enough_free_space() {
    ensure_space(1024, 1024).expect("exactly enough free space must pass");
    ensure_space(1024, 4096).expect("more free space than required must pass");
    ensure_space(0, 0).expect("a zero-byte requirement must pass");
}

/// Not enough free space is a failure whose message names both byte counts.
#[test]
fn ensure_space_rejects_insufficient_free_space() {
    let error = ensure_space(4096, 1024).expect_err("insufficient free space must fail");
    let message = format!("{error:#}");

    assert!(
        message.contains("4096"),
        "the disk error must name the required bytes, got: {message}"
    );
    assert!(
        message.contains("1024"),
        "the disk error must name the available bytes, got: {message}"
    );
    assert!(
        message.to_lowercase().contains("space"),
        "the disk error must explain the disk-space problem, got: {message}"
    );
}

// ── /v2/info capability gating ────────────────────────────────

/// A clean install advertises `imago_versions: []`, so Ketcher disables
/// Recognize; the rest of the info payload is unchanged.
#[tokio::test]
async fn info_hides_the_capability_without_models() {
    let root = TempModelRoot::absent("info-empty");
    let artifacts = DummyArtifacts::standard();
    let catalog = dummy_catalog("http://127.0.0.1:9", &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["imago_versions"],
        json!([]),
        "without models the capability list must be empty, got: {body}"
    );
    assert!(
        body["indigo_version"]
            .as_str()
            .is_some_and(|version| !version.is_empty()),
        "info must keep reporting the Indigo version, got: {body}"
    );
    assert_eq!(body["api_path"], "http://127.0.0.1:9321/v2");

    let (status, alias) = fetch_get(&app, "/v2/indigo/info").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        alias["imago_versions"],
        json!([]),
        "the alias must gate the capability the same way"
    );
}

/// After a dummy download the manifest parses and both models exist, so the
/// synthetic capability appears; removing one artifact disables it again.
#[tokio::test]
async fn info_advertises_the_capability_after_the_dummy_download() {
    let root = TempModelRoot::absent("info-installed");
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    let (status, body) = fetch_get(&app, "/v2/info").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["imago_versions"],
        json!(["local-ocsr"]),
        "installed models must enable Recognize, got: {body}"
    );

    std::fs::remove_file(root.join(VOCAB_PATH))
        .expect("the installed vocabulary must be removable");
    let (_, body) = fetch_get(&app, "/v2/info").await;
    assert_eq!(
        body["imago_versions"],
        json!([]),
        "a missing required artifact must disable the capability again"
    );
}

// ── Verify on an empty root ───────────────────────────────────

/// With no manifest and no files, verify falls back to the active catalog and
/// reports every artifact `missing`, with the repair hint and no bytes read.
#[tokio::test]
async fn verify_on_an_empty_root_reports_every_artifact_missing() {
    let root = TempModelRoot::absent("verify-empty");
    let artifacts = DummyArtifacts::standard();
    let catalog = dummy_catalog("http://127.0.0.1:9", &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, report) = post_json(&app, "/v2/models/verify", json!({})).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["ok"], false);
    assert_eq!(report["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(report["checked_bytes"], json!(0));
    assert_eq!(report["repair"], VERIFY_REPAIR_HINT);

    let entries = report["artifacts"]
        .as_array()
        .unwrap_or_else(|| panic!("verify must list every artifact, got: {report}"));
    let paths: Vec<&str> = entries
        .iter()
        .map(|entry| {
            entry["path"]
                .as_str()
                .unwrap_or_else(|| panic!("every artifact entry must carry a path, got: {entry}"))
        })
        .collect();
    assert_eq!(
        paths,
        [CLASSIFIER_PATH, ENCODER_PATH, DECODER_PATH, VOCAB_PATH],
        "verify lists the active catalog's artifacts in catalog order"
    );
    for entry in entries {
        assert_eq!(entry["status"], "missing");
        assert!(
            entry.get("actual_sha256").is_none(),
            "a missing artifact must not report an actual hash, got: {entry}"
        );
    }

    assert!(
        !root.path().exists(),
        "verify is read-only and must not create the model root"
    );
}

// ── 409/200 conflict semantics ────────────────────────────────

/// A second download while a run is active is 409 with the standard error
/// envelope; the active run is then cancelled.
#[tokio::test]
async fn download_while_a_run_is_active_is_409() {
    let root = TempModelRoot::absent("download-active-409");
    let artifacts = DummyArtifacts::slow_classifier();
    let server = TestServer::start(&artifacts).await;
    server.slow(CLASSIFIER_PATH, 1024, Duration::from_millis(25));
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "downloading", POLL_TIMEOUT).await;

    let (status, body) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a second download while one is active must be 409, got body: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "a 409 must carry the standard error envelope, got: {body}"
    );

    let (status, _) = post_json(&app, "/v2/models/download/cancel", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "cancelled", POLL_TIMEOUT).await;
}

/// A download when the install is already ready is a 200 no-op: no worker, no
/// request, and the state stays `ready`.
#[tokio::test]
async fn download_when_ready_is_a_200_no_op() {
    let root = TempModelRoot::absent("download-ready-noop");
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    let requests_before = server.request_count();

    let (status, body) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a download when ready is a 200 no-op, got body: {body}"
    );
    assert_eq!(body["ready"], true);
    assert_eq!(body["download"]["state"], "ready");

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        server.request_count(),
        requests_before,
        "a no-op download must not fetch anything"
    );
    let (_, status_body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(
        status_body["download"]["state"], "ready",
        "a no-op must not start a worker"
    );
}

/// Cancel without a running download is 409, and the status stays idle.
#[tokio::test]
async fn cancel_without_a_download_is_409() {
    let root = TempModelRoot::absent("cancel-idle");
    let artifacts = DummyArtifacts::standard();
    let catalog = dummy_catalog("http://127.0.0.1:9", &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, body) = post_json(&app, "/v2/models/download/cancel", json!({})).await;

    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "cancel without a download must be 409, got body: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "a 409 must carry the standard error envelope, got: {body}"
    );

    let (_, status_body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(status_body["download"]["state"], "idle");
}

/// Verify during a run is 409: the downloader is mutating the files it would
/// hash. The active run is then cancelled.
#[tokio::test]
async fn verify_while_a_run_is_active_is_409() {
    let root = TempModelRoot::absent("verify-active-409");
    let artifacts = DummyArtifacts::slow_classifier();
    let server = TestServer::start(&artifacts).await;
    server.slow(CLASSIFIER_PATH, 1024, Duration::from_millis(25));
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "downloading", POLL_TIMEOUT).await;

    let (status, body) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "verify during a download must be 409, got body: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "a 409 must carry the standard error envelope, got: {body}"
    );

    let (status, _) = post_json(&app, "/v2/models/download/cancel", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "cancelled", POLL_TIMEOUT).await;
}

// ── Repair with a valid manifest ──────────────────────────────

/// The normal repair case: a complete install with a valid, current manifest
/// and one same-size corrupt artifact. Verify reports `corrupt`; the explicit
/// download must re-hash, return `202`, fetch only the bad artifact, replace
/// it, rewrite the manifest and leave verify `ok`.
#[tokio::test]
async fn download_with_a_valid_manifest_repairs_a_corrupt_artifact() {
    let root = TempModelRoot::absent("repair-valid-manifest");
    let artifacts = DummyArtifacts::standard();
    stage_install(&root, &artifacts, u64::from(TEST_CATALOG_VERSION));

    // Same size, wrong contents: an existence-only check calls this installed.
    let mut corrupt_encoder = artifacts.encoder.clone();
    corrupt_encoder[0] ^= 0xff;
    write_file(&root, ENCODER_PATH, &corrupt_encoder);

    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (_, status_body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(
        status_body["ready"], true,
        "the cheap status check still sees every file present"
    );
    assert_eq!(status_body["update_available"], false);

    let (status, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["ok"], false);
    let encoder = report["artifacts"]
        .as_array()
        .unwrap_or_else(|| panic!("verify must list every artifact, got: {report}"))
        .iter()
        .find(|entry| entry["path"] == ENCODER_PATH)
        .unwrap_or_else(|| panic!("verify must report the corrupt encoder, got: {report}"));
    assert_eq!(encoder["status"], "corrupt");
    assert_eq!(encoder["actual_sha256"], sha256_hex(&corrupt_encoder));

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "a valid manifest must not hide a corrupt artifact: the download repairs it"
    );
    let ready = wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    assert_eq!(ready["ready"], true);

    assert_eq!(
        read_file(&root, ENCODER_PATH),
        artifacts.encoder,
        "the repair run must replace the corrupt artifact"
    );
    assert_eq!(
        server.requests_for(ENCODER_PATH).len(),
        1,
        "only the corrupt artifact is fetched"
    );
    for relative in [CLASSIFIER_PATH, DECODER_PATH, VOCAB_PATH] {
        assert_eq!(
            server.requests_for(relative).len(),
            0,
            "{relative} already matches and must be skipped"
        );
    }

    let manifest = read_manifest(&root);
    assert_eq!(manifest["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(
        manifest["models"]["image-classifier"]["id"], "image-classifier@test/dummy",
        "the repair run rewrites the manifest from the catalog"
    );
    assert_eq!(
        manifest["models"]["ocsr-handdrawn"]["encoder"]["artifact_sha256"],
        sha256_hex(&artifacts.encoder)
    );
    assert_eq!(
        installed_files(&root),
        expected_installed_files(),
        "the repair must leave no .part or temporary manifest behind"
    );

    let (_, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(report["ok"], true);
    assert_eq!(report["repair"], Value::Null);
}

// ── Catalog version update and downgrade ──────────────────────

/// An older installed manifest reports `update_available: true`; a download
/// re-verifies the existing artifacts, fetches nothing (they all match), and
/// rewrites the manifest with the active catalog version.
#[tokio::test]
async fn an_older_installed_manifest_is_updated_by_a_download() {
    let root = TempModelRoot::absent("catalog-update");
    let artifacts = DummyArtifacts::standard();
    let older = u64::from(TEST_CATALOG_VERSION) - 1;
    stage_install(&root, &artifacts, older);

    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (_, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(body["installed_catalog_version"], json!(older));
    assert_eq!(body["update_available"], true);
    assert_eq!(body["ready"], true, "old-but-usable artifacts stay ready");

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "an older manifest is an update, never a no-op"
    );
    let ready = wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    assert_eq!(
        ready["installed_catalog_version"],
        json!(TEST_CATALOG_VERSION)
    );
    assert_eq!(ready["update_available"], false);
    assert_eq!(ready["ready"], true);

    let manifest = read_manifest(&root);
    assert_eq!(manifest["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert!(
        !root.join("manifest.json.tmp").exists(),
        "the rewritten manifest is published through a temp file and a rename"
    );
    assert_eq!(
        server.request_count(),
        0,
        "matching artifacts are re-verified on disk, not downloaded again"
    );

    let (_, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(report["ok"], true);
    assert_eq!(report["catalog_version"], json!(TEST_CATALOG_VERSION));
}

/// A newer installed catalog is never downgraded: the status reports no update
/// and the download is `409` without touching the manifest or the network.
#[tokio::test]
async fn a_newer_installed_catalog_is_409_and_left_untouched() {
    let root = TempModelRoot::absent("catalog-downgrade");
    let artifacts = DummyArtifacts::standard();
    let newer = u64::from(TEST_CATALOG_VERSION) + 1;
    stage_install(&root, &artifacts, newer);
    let manifest_before =
        std::fs::read(root.join("manifest.json")).expect("the staged manifest must be readable");

    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (_, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(body["installed_catalog_version"], json!(newer));
    assert_eq!(
        body["update_available"], false,
        "a newer installed catalog is never reported as a pending update"
    );
    assert_eq!(body["ready"], true);

    let (status, body) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "downgrading a newer installed catalog must be 409, got body: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| error.contains("newer")),
        "the 409 must explain that the installed catalog is newer, got: {body}"
    );

    assert_eq!(
        server.request_count(),
        0,
        "a rejected downgrade must do no work"
    );
    assert_eq!(
        std::fs::read(root.join("manifest.json")).expect("the manifest must still exist"),
        manifest_before,
        "a rejected downgrade must leave the manifest untouched"
    );
}

// ── Range restart: server ignores Range and 416 ───────────────

/// A server that ignores `Range` and answers `200` with the full body: the
/// downloader truncates the partial file and restarts, then completes.
#[tokio::test]
async fn a_server_that_ignores_range_restarts_and_completes() {
    let root = TempModelRoot::absent("range-ignored");
    let artifacts = DummyArtifacts::standard();
    let prefix = &artifacts.classifier[..512];
    write_file(&root, &format!("{CLASSIFIER_PATH}.part"), prefix);

    let server = TestServer::start(&artifacts).await;
    server.ignores_range(CLASSIFIER_PATH);
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    assert_eq!(
        read_file(&root, CLASSIFIER_PATH),
        artifacts.classifier,
        "the restarted artifact must be byte-identical"
    );
    assert!(
        !root.join(format!("{CLASSIFIER_PATH}.part")).exists(),
        "no .part may remain after the restart completed"
    );

    let requests = server.requests_for(CLASSIFIER_PATH);
    assert_eq!(
        requests.len(),
        1,
        "the 200 response already carries the full body, so no second request is needed"
    );
    assert_eq!(
        requests[0].range.as_deref(),
        Some(format!("bytes={}-", prefix.len()).as_str()),
        "the first request must ask to resume"
    );
    assert_eq!(
        requests[0].status, 200,
        "the server answering 200 proves Range was ignored"
    );
}

/// A server that answers `416` to a range request: the downloader discards the
/// partial file, retries from zero and completes.
#[tokio::test]
async fn a_server_that_rejects_range_restarts_and_completes() {
    let root = TempModelRoot::absent("range-rejected");
    let artifacts = DummyArtifacts::standard();
    let prefix = &artifacts.classifier[..512];
    write_file(&root, &format!("{CLASSIFIER_PATH}.part"), prefix);

    let server = TestServer::start(&artifacts).await;
    server.rejects_range(CLASSIFIER_PATH);
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    assert_eq!(
        read_file(&root, CLASSIFIER_PATH),
        artifacts.classifier,
        "the restarted artifact must be byte-identical"
    );
    assert!(
        !root.join(format!("{CLASSIFIER_PATH}.part")).exists(),
        "no .part may remain after the restart completed"
    );

    let requests = server.requests_for(CLASSIFIER_PATH);
    assert_eq!(
        requests.len(),
        2,
        "the downloader must retry once without a range after the 416"
    );
    assert_eq!(
        requests[0].range.as_deref(),
        Some(format!("bytes={}-", prefix.len()).as_str())
    );
    assert_eq!(requests[0].status, 416);
    assert!(
        requests[1].range.is_none(),
        "the retry must restart from zero"
    );
    assert_eq!(requests[1].status, 200);
}

// ── Disk preflight (injected probe) ───────────────────────────

/// The downloader's free-space probe is injectable: a full "disk" fails the run
/// before any HTTP request and writes no artifact; enough space then succeeds.
#[tokio::test]
async fn disk_preflight_fails_before_any_request_and_succeeds_with_space() {
    let root = TempModelRoot::absent("disk-preflight");
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let (app, state) = test_app_and_state_with_catalog(root.path(), catalog);

    state.downloads().set_space_probe(|_| Ok(0));

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let failed = wait_for_state(&app, "failed", POLL_TIMEOUT).await;
    let error = failed["download"]["error"]
        .as_str()
        .unwrap_or_else(|| panic!("a full disk must carry an error string, got: {failed}"));
    assert!(
        error.contains(&artifacts.total().to_string()),
        "the disk error must name the required bytes, got: {error}"
    );
    assert!(
        error.contains("0 bytes"),
        "the disk error must name the available bytes, got: {error}"
    );
    assert!(
        error.to_lowercase().contains("space"),
        "the disk error must explain the disk-space problem, got: {error}"
    );
    assert_eq!(
        server.request_count(),
        0,
        "the preflight must fail before any HTTP request"
    );
    assert!(
        installed_files(&root).is_empty(),
        "a failed preflight must not write an artifact"
    );

    state.downloads().set_space_probe(|_| Ok(u64::MAX));
    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    assert_eq!(
        read_file(&root, CLASSIFIER_PATH),
        artifacts.classifier,
        "enough free space lets the same catalog install"
    );
}

// ── Broken catalog ────────────────────────────────────────────

/// A broken catalog override is an actionable `500` on the model routes; info
/// and health degrade to "no models" without panicking.
#[tokio::test]
async fn a_broken_catalog_is_500_and_info_and_health_degrade() {
    let root = TempModelRoot::absent("broken-catalog");
    let message = "invalid CHEMISTRY_MODEL_CATALOG /tmp/test-catalog.json: bad document";
    let app = test_app_with_catalog_error(root.path(), message);

    let (status, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "a broken catalog must be the documented 500, got body: {body}"
    );
    assert_eq!(
        body["error"], message,
        "the 500 must carry the standard error envelope with the actionable cause"
    );

    for route in [
        "/v2/models/download",
        "/v2/models/download/cancel",
        "/v2/models/verify",
    ] {
        let (status, body) = post_json(&app, route, json!({})).await;
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{route} must be 500 with a broken catalog, got body: {body}"
        );
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "{route} must carry the standard error envelope, got: {body}"
        );
    }

    let (status, info) = fetch_get(&app, "/v2/info").await;
    assert_eq!(status, StatusCode::OK, "info must keep serving Indigo");
    assert_eq!(info["imago_versions"], json!([]));
    assert!(
        info["indigo_version"]
            .as_str()
            .is_some_and(|version| !version.is_empty()),
        "info must keep the Indigo version, got: {info}"
    );

    let (status, health) = fetch_get(&app, "/v2/health").await;
    assert_eq!(status, StatusCode::OK, "health must keep serving");
    assert_eq!(
        health["models"],
        json!([]),
        "a broken catalog degrades to no installed models, got: {health}"
    );
    assert!(
        !root.path().exists(),
        "neither route may touch the model root"
    );
}

// ── Restart state ─────────────────────────────────────────────

/// A restart derives `ready` from a complete root and `idle` from a partial
/// one, never auto-resumes, and a fresh explicit download resumes the `.part`.
#[tokio::test]
async fn restart_reports_ready_or_idle_and_a_fresh_download_resumes() {
    let artifacts = DummyArtifacts::standard();
    let server = TestServer::start(&artifacts).await;

    let complete = TempModelRoot::absent("restart-complete");
    stage_install(&complete, &artifacts, u64::from(TEST_CATALOG_VERSION));
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(complete.path(), catalog);

    let (_, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(body["ready"], true);
    assert_eq!(
        body["download"]["state"], "ready",
        "a complete root reports ready after a restart"
    );
    assert_eq!(
        server.request_count(),
        0,
        "startup and status polling never fetch anything"
    );

    let partial = TempModelRoot::absent("restart-partial");
    let kept = artifacts.classifier.len() / 2;
    write_file(
        &partial,
        &format!("{CLASSIFIER_PATH}.part"),
        &artifacts.classifier[..kept],
    );
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(partial.path(), catalog);

    let (_, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(body["ready"], false);
    assert_eq!(
        body["download"]["state"], "idle",
        "a partial root reports idle after a restart"
    );
    assert_eq!(
        server.request_count(),
        0,
        "a restart never resumes a download automatically"
    );

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "an explicit download resumes the kept .part"
    );
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    let requests = server.requests_for(CLASSIFIER_PATH);
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].range.as_deref(),
        Some(format!("bytes={kept}-").as_str()),
        "the fresh run must resume from the kept bytes"
    );
    assert_eq!(read_file(&partial, CLASSIFIER_PATH), artifacts.classifier);
}

// ── Manifest publish and retention ────────────────────────────

/// A failed run with an existing manifest leaves the previous file untouched;
/// a successful retry publishes the new one (temp file + rename, no `.tmp`
/// left behind).
#[tokio::test]
async fn a_failed_run_keeps_the_previous_manifest_and_a_retry_rewrites_it() {
    let root = TempModelRoot::absent("manifest-retention");
    let artifacts = DummyArtifacts::standard();
    let older = u64::from(TEST_CATALOG_VERSION) - 1;
    stage_install(&root, &artifacts, older);
    let previous =
        std::fs::read(root.join("manifest.json")).expect("the staged manifest must be readable");
    std::fs::remove_file(root.join(ENCODER_PATH)).expect("the staged encoder must be removable");

    let server = TestServer::start(&artifacts).await;
    let mut wrong_encoder = artifacts.encoder.clone();
    wrong_encoder[0] ^= 0xff;
    server.replace_bytes(ENCODER_PATH, wrong_encoder);
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let failed = wait_for_state(&app, "failed", POLL_TIMEOUT).await;
    assert!(
        failed["download"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("failed verification")),
        "the failed run must keep its checksum error, got: {failed}"
    );
    assert_eq!(
        std::fs::read(root.join("manifest.json"))
            .expect("the previous manifest must survive a failed run"),
        previous,
        "a failed run must never publish a partial manifest"
    );
    assert!(
        !root.join("manifest.json.tmp").exists(),
        "a failed run must not leave a temporary manifest behind"
    );

    server.replace_bytes(ENCODER_PATH, artifacts.encoder.clone());
    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_state(&app, "ready", POLL_TIMEOUT).await;

    let manifest = read_manifest(&root);
    assert_eq!(manifest["catalog_version"], json!(TEST_CATALOG_VERSION));
    assert_eq!(
        manifest["models"]["ocsr-handdrawn"]["encoder"]["artifact_sha256"],
        sha256_hex(&artifacts.encoder)
    );
    assert!(
        !root.join("manifest.json.tmp").exists(),
        "the successful run publishes the manifest through a temp file and a rename"
    );
    let (_, report) = post_json(&app, "/v2/models/verify", json!({})).await;
    assert_eq!(report["ok"], true);
}

// ── Manifest validity gate ────────────────────────────────────

/// `{}` is syntactically valid JSON but not a usable manifest: the install is
/// not ready, `/v2/info` must not advertise the capability and `/v2/health`
/// reports no models.
#[tokio::test]
async fn an_empty_manifest_is_not_ready_and_hides_the_capability() {
    let root = TempModelRoot::absent("manifest-empty-object");
    let artifacts = DummyArtifacts::standard();
    write_dummy_artifacts(&root, &artifacts);
    write_file(&root, "manifest.json", b"{}");
    let catalog = dummy_catalog("http://127.0.0.1:9", &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);

    let (status, body) = fetch_get(&app, "/v2/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["manifest_present"], true,
        "manifest_present is only the parse check"
    );
    assert_eq!(
        body["ready"], false,
        "an empty manifest must not make every present file look ready"
    );
    assert_eq!(body["installed_catalog_version"], Value::Null);
    assert_eq!(body["update_available"], true);

    let (status, info) = fetch_get(&app, "/v2/info").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        info["imago_versions"],
        json!([]),
        "an unusable manifest must not advertise local-ocsr"
    );

    let (status, health) = fetch_get(&app, "/v2/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["models"], json!([]));

    // The repair path treats the unusable manifest as missing and republishes it.
    let server = TestServer::start(&artifacts).await;
    let catalog = dummy_catalog(&server.base_url(), &artifacts);
    let app = test_app_with_catalog(root.path(), catalog);
    let (status, _) = post_json(&app, "/v2/models/download", json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let ready = wait_for_state(&app, "ready", POLL_TIMEOUT).await;
    assert_eq!(ready["ready"], true);
    assert_eq!(
        server.request_count(),
        0,
        "the artifacts already match; only the manifest is regenerated"
    );
    assert_eq!(
        read_manifest(&root)["models"]["image-classifier"]["id"],
        "image-classifier@test/dummy"
    );
}
