// Tests for the ONNX image classifier (`POST /v2/filter/classify`), the
// `runtime_default` preprocessing pipeline and the manifest contract guard.
//
// Tests that need the real artifact are gated with
// `#[ignore = "requires local ONNX model"]`; the harness runs them with
// `--include-ignored` only when both `models/manifest.json` and the ONNX
// Runtime dylib (`ORT_DYLIB_PATH`) exist.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::service::ml::preprocess::{classifier_input, ClassifierInput, MAX_IMAGE_SIDE};
use crate::service::ml::registry::{validate_tensor_shape, ModelRegistry};
use crate::tests::*;
use crate::transport::filter::MAX_BODY_BYTES;
use axum::http::StatusCode;
use png::{BitDepth, ColorType};
use serde_json::{json, Value};

/// Side length of the square classifier input.
const SIDE: usize = 224;
/// Calibrated decision threshold: a score at or below it means `structure`.
const THRESHOLD: f64 = 0.000089;
/// Provenance id echoed by the endpoint and reported by health.
const MODEL_ID: &str = "image-classifier@Iagea/d21f4cb";
/// Artifact path inside the model root.
const MANIFEST_ARTIFACT: &str = "image-classifier-fp16/classifier.fp16.onnx";
/// SHA-256 of the pinned classifier artifact.
const ARTIFACT_SHA256: &str = "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9";

// ── Helpers ───────────────────────────────────────────────────

fn encode_png(width: u32, height: u32, color: ColorType, data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(color);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .expect("in-memory PNG header must encode");
        writer
            .write_image_data(data)
            .expect("in-memory PNG data must encode");
    }
    bytes
}

fn png_rgba(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&pixel(x, y));
        }
    }
    encode_png(width, height, ColorType::Rgba, &data)
}

fn png_rgb(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&pixel(x, y));
        }
    }
    encode_png(width, height, ColorType::Rgb, &data)
}

/// Reads one NHWC pixel from the preprocessed tensor.
fn pixel(input: &ClassifierInput, x: usize, y: usize) -> [f32; 3] {
    let index = (y * SIDE + x) * 3;
    [
        input.data[index],
        input.data[index + 1],
        input.data[index + 2],
    ]
}

fn row_is_all_white(input: &ClassifierInput, y: usize) -> bool {
    (0..SIDE).all(|x| pixel(input, x, y) == [255.0, 255.0, 255.0])
}

/// Loads a fixture committed under `src-tauri/sidecar/fixtures/`.
fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("missing fixture {path:?}: {error}"))
}

/// Returns the actionable `error` field of an error response.
fn error_message(body: &Value) -> &str {
    body["error"].as_str().unwrap_or("")
}

/// Asserts that `score` is exactly `sigmoid(logit)` (within float tolerance).
fn assert_logit_and_score(body: &Value) {
    let logit = body["logit"]
        .as_f64()
        .unwrap_or_else(|| panic!("logit must be a number, got body: {body}"));
    let score = body["score"]
        .as_f64()
        .unwrap_or_else(|| panic!("score must be a number, got body: {body}"));
    let expected = 1.0 / (1.0 + (-logit).exp());
    assert!(
        (score - expected).abs() <= 1e-6,
        "score must equal sigmoid(logit): score {score}, logit {logit}, expected {expected}"
    );
}

/// Unique temporary model root, removed when the test finishes.
struct TempModelRoot {
    path: PathBuf,
}

impl TempModelRoot {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "chemistry-draw-{}-{label}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("could not create {path:?}: {error}"));
        Self { path }
    }

    fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn write_manifest(&self, manifest: &Value) {
        let path = self.path.join("manifest.json");
        std::fs::write(&path, manifest.to_string())
            .unwrap_or_else(|error| panic!("could not write {path:?}: {error}"));
    }

    fn write_artifact(&self, relative: &str, bytes: &[u8]) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .unwrap_or_else(|error| panic!("could not create {parent:?}: {error}"));
        }
        std::fs::write(&path, bytes)
            .unwrap_or_else(|error| panic!("could not write {path:?}: {error}"));
    }
}

impl Drop for TempModelRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Manifest with one `image-classifier` entry using the explicit input shape.
fn classifier_manifest(
    artifact_sha256: &str,
    preprocessing: &str,
    input_shape: [usize; 4],
) -> Value {
    json!({
        "schema": 1,
        "models": {
            "image-classifier": {
                "id": MODEL_ID,
                "file": MANIFEST_ARTIFACT,
                "artifact_sha256": artifact_sha256,
                "threshold": THRESHOLD,
                "preprocessing": preprocessing,
                "inputs": [
                    { "name": "input_2", "dtype": "float32", "shape": input_shape },
                    { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
                    { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
                ],
                "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
            }
        }
    })
}

async fn post_caffeine(root: &TempModelRoot) -> (StatusCode, Value) {
    let app = test_app_with_models(root.path());
    post_bytes(
        &app,
        "/v2/filter/classify",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await
}

/// Asserts the endpoint answers 503 with an actionable, model-root-aware error.
async fn assert_model_unavailable(root: &TempModelRoot, expected: &str) {
    let (status, body) = post_caffeine(root).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.contains(expected),
        "the 503 must contain `{expected}`, got: {message}"
    );
    assert!(
        message.contains("manifest.json"),
        "the 503 must name the manifest path, got: {message}"
    );
    assert!(
        message.contains("CHEMISTRY_MODELS_DIR"),
        "the 503 must explain CHEMISTRY_MODELS_DIR, got: {message}"
    );
}

// ── Preprocessing (pure, no model) ────────────────────────────

#[test]
fn classifier_input_flattens_rgba_on_white() {
    // Left half opaque black, right half transparent red. Compositing on white
    // must turn the transparent red into white, not black.
    let png = png_rgba(100, 100, |x, _y| {
        if x < 50 {
            [0, 0, 0, 255]
        } else {
            [255, 0, 0, 0]
        }
    });

    let input = classifier_input(&png).expect("a valid RGBA PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, 3]);
    assert_eq!(
        pixel(&input, 20, 50),
        [0.0, 0.0, 0.0],
        "opaque black must stay black"
    );
    assert_eq!(
        pixel(&input, 203, 50),
        [255.0, 255.0, 255.0],
        "transparent colour must be composited on white, not black"
    );
}

#[test]
fn classifier_input_grayscales_rgb() {
    let png = png_rgb(64, 64, |_x, _y| [255, 0, 0]);

    let input = classifier_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, 3]);
    for (index, channels) in input.data.as_chunks::<3>().0.iter().enumerate() {
        assert_eq!(
            channels[0], channels[1],
            "pixel {index} must have equal R and G channels"
        );
        assert_eq!(
            channels[1], channels[2],
            "pixel {index} must have equal G and B channels"
        );
    }
    assert_eq!(
        pixel(&input, 112, 112),
        [76.0, 76.0, 76.0],
        "pure red must use the Rec.601 luma of 76"
    );
}

#[test]
fn classifier_input_preserves_aspect_ratio_and_pads_white() {
    // 100x50: longest side 100 scales to 224, so the content is 224x112 and
    // must be centered vertically on a white 224x224 canvas.
    let png = png_rgb(
        100,
        50,
        |x, _y| {
            if x < 50 {
                [255, 0, 0]
            } else {
                [0, 0, 255]
            }
        },
    );

    let input = classifier_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, 3]);
    assert!(
        row_is_all_white(&input, 0),
        "the top row must be white padding"
    );
    assert!(
        row_is_all_white(&input, 55),
        "the first 56 rows must be padding for a 224x112 content box"
    );
    assert!(
        !row_is_all_white(&input, 56),
        "content must start at row 56 (224 - 112) / 2"
    );
    assert!(
        !row_is_all_white(&input, 167),
        "content must end at row 167"
    );
    assert!(
        row_is_all_white(&input, 168),
        "the last 56 rows must be padding"
    );

    let left = pixel(&input, 10, 112);
    let right = pixel(&input, 213, 112);
    assert_eq!(left[0], left[1], "left content must be grayscale");
    assert_eq!(left[1], left[2], "left content must be grayscale");
    assert_eq!(right[0], right[1], "right content must be grayscale");
    assert_eq!(right[1], right[2], "right content must be grayscale");
    assert!(
        left[0] > right[0],
        "red (left) must stay brighter than blue (right), got {left:?} vs {right:?}"
    );
}

#[test]
fn classifier_input_uses_nhwc_float_range() {
    let png = png_rgb(
        100,
        50,
        |x, _y| {
            if x < 50 {
                [255, 0, 0]
            } else {
                [0, 0, 255]
            }
        },
    );

    let input = classifier_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, 3]);
    assert_eq!(input.data.len(), SIDE * SIDE * 3);
    assert!(
        input.data.iter().all(|value| value.is_finite()),
        "the tensor must contain only finite values"
    );
    assert!(
        input.data.iter().all(|value| (0.0..=255.0).contains(value)),
        "tensor values must stay in the float 0..=255 range"
    );
    assert_eq!(
        &input.data[0..3],
        &[255.0, 255.0, 255.0],
        "the first NHWC pixel must be the top-left white padding"
    );
}

#[test]
fn classifier_input_decodes_webp() {
    let input = classifier_input(&fixture_bytes("caffeine.webp"))
        .expect("a valid WebP image must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, 3]);
    assert_eq!(input.data.len(), SIDE * SIDE * 3);
}

#[test]
fn classifier_input_rejects_undecodable_bytes() {
    let error =
        classifier_input(b"not an image at all").expect_err("garbage bytes must be rejected");

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("decode") && message.contains("image"),
        "the error must explain the image could not be decoded, got: {message}"
    );
}

#[test]
fn classifier_input_rejects_images_over_the_side_limit() {
    // 12,001 px wide: the dimension check must fire before allocating pixels.
    let png = png_rgb(MAX_IMAGE_SIDE + 1, 1, |_x, _y| [0, 0, 0]);

    let error = classifier_input(&png).expect_err("an image wider than 12,000 px must be rejected");

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("size exceeds limit"),
        "the error must explain the dimension cap, got: {message}"
    );
}

// ── Tensor contract comparator (pure, no model) ───────────────

fn assert_axis_rejected(graph: &[i64], manifest: &[usize], axis: usize) {
    let error = validate_tensor_shape(graph, manifest)
        .expect_err("a dynamic or mismatched non-batch axis must be rejected");
    let message = error.to_string();
    assert!(
        message.contains(&format!("axis {axis}")),
        "the contract error must name axis {axis}, got: {message}"
    );
}

#[test]
fn contract_accepts_dynamic_batch_dimension() {
    validate_tensor_shape(&[-1, 224, 224, 3], &[1, 224, 224, 3])
        .expect("a dynamic batch dimension must be accepted");
}

#[test]
fn contract_rejects_dynamic_width() {
    assert_axis_rejected(&[1, -1, 224, 3], &[1, 224, 224, 3], 1);
}

#[test]
fn contract_rejects_dynamic_height() {
    assert_axis_rejected(&[1, 224, -1, 3], &[1, 224, 224, 3], 2);
}

#[test]
fn contract_rejects_dynamic_channels() {
    assert_axis_rejected(&[1, 224, 224, -1], &[1, 224, 224, 3], 3);
}

#[test]
fn contract_rejects_static_mismatch() {
    assert_axis_rejected(&[-1, 224, 112, 3], &[1, 224, 224, 3], 2);
}

#[test]
fn contract_rejects_rank_mismatch() {
    let error = validate_tensor_shape(&[-1, 224, 224], &[1, 224, 224, 3])
        .expect_err("a different rank must be rejected");
    let message = error.to_string();
    assert!(
        message.contains("rank"),
        "the contract error must explain the rank, got: {message}"
    );
}

// ── Endpoint errors and health (no model) ────────────────────

#[tokio::test]
async fn filter_rejects_unsupported_media_type() {
    let app = test_app();
    let (status, body) =
        post_bytes(&app, "/v2/filter/classify", "text/plain", b"hello".to_vec()).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.contains("image/png")
            && message.contains("image/jpeg")
            && message.contains("image/webp"),
        "the 400 must list the supported image types, got: {message}"
    );
}

#[tokio::test]
async fn filter_rejects_undecodable_image() {
    let app = test_app();
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/png",
        b"this is not a PNG".to_vec(),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let message = error_message(&body).to_lowercase();
    assert!(
        message.contains("decode") && message.contains("image"),
        "the 400 must explain the image could not be decoded, got: {message}"
    );
}

#[tokio::test]
async fn filter_rejects_oversized_body() {
    // One byte over the documented cap must be rejected before decoding.
    let app = test_app();
    let body = vec![0u8; MAX_BODY_BYTES + 1];

    let (status, response) = post_bytes(&app, "/v2/filter/classify", "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "a body over 10 MiB must be rejected with 413, got body: {response}"
    );
}

#[tokio::test]
async fn filter_decodes_bodies_at_exactly_ten_megabytes() {
    // The cap is inclusive: exactly 10,485,760 bytes must reach the decoder
    // (400) instead of being rejected as too large (413).
    let app = test_app();
    let body = vec![0u8; MAX_BODY_BYTES];

    let (status, response) = post_bytes(&app, "/v2/filter/classify", "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "exactly 10 MiB is inside the cap and must be decoded, got body: {response}"
    );
}

#[tokio::test]
async fn filter_accepts_bodies_under_the_ten_megabyte_cap() {
    // The documented cap is 10 MiB, not axum's 2 MiB default: a 3 MiB body must
    // reach the decoder (400) instead of being rejected as too large (413).
    let app = test_app();
    let body = vec![0u8; 3 * 1024 * 1024];

    let (status, response) = post_bytes(&app, "/v2/filter/classify", "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "3 MiB is below the 10 MiB cap and must be decoded, got body: {response}"
    );
}

#[tokio::test]
async fn filter_returns_503_when_model_dir_is_missing() {
    let missing = std::env::temp_dir().join(format!(
        "chemistry-draw-missing-models-{}-filter_returns_503_when_model_dir_is_missing",
        std::process::id()
    ));
    assert!(
        !missing.exists(),
        "test needs an absent model directory: {missing:?}"
    );
    let app = test_app_with_models(missing);

    // A valid image is required: validation errors (400) take precedence over
    // model availability, so only a well-formed image reaches the 503 path.
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.to_lowercase().contains("model"),
        "the 503 must say the model is unavailable, got: {message}"
    );
    assert!(
        message.contains("CHEMISTRY_MODELS_DIR"),
        "the 503 must explain how to provide the model, got: {message}"
    );
}

#[tokio::test]
async fn filter_returns_503_when_artifact_checksum_mismatches() {
    let root = TempModelRoot::new("checksum-mismatch");
    root.write_artifact(MANIFEST_ARTIFACT, b"not the pinned classifier artifact");
    root.write_manifest(&classifier_manifest(
        &"0".repeat(64),
        "runtime_default",
        [1, 224, 224, 3],
    ));

    assert_model_unavailable(&root, "sha256").await;
}

#[tokio::test]
async fn filter_returns_503_when_artifact_is_missing() {
    let root = TempModelRoot::new("missing-artifact");
    root.write_manifest(&classifier_manifest(
        ARTIFACT_SHA256,
        "runtime_default",
        [1, 224, 224, 3],
    ));

    assert_model_unavailable(&root, "missing").await;
}

#[tokio::test]
async fn filter_returns_503_when_manifest_schema_is_unsupported() {
    let root = TempModelRoot::new("unsupported-schema");
    root.write_manifest(&json!({ "schema": 2, "models": {} }));

    assert_model_unavailable(&root, "unsupported schema").await;
}

#[tokio::test]
async fn filter_returns_503_when_manifest_declares_no_classifier() {
    let root = TempModelRoot::new("no-classifier");
    root.write_manifest(&json!({ "schema": 1, "models": {} }));

    assert_model_unavailable(&root, "image-classifier").await;
}

#[tokio::test]
async fn filter_returns_503_when_preprocessing_is_unsupported() {
    let root = TempModelRoot::new("preprocessing-mismatch");
    root.write_manifest(&classifier_manifest(
        ARTIFACT_SHA256,
        "imagenet_default",
        [1, 224, 224, 3],
    ));

    assert_model_unavailable(&root, "preprocessing").await;
}

#[tokio::test]
async fn health_hides_models_whose_artifact_is_missing() {
    let root = TempModelRoot::new("health-missing-artifact");
    root.write_manifest(&classifier_manifest(
        ARTIFACT_SHA256,
        "runtime_default",
        [1, 224, 224, 3],
    ));

    let app = test_app_with_models(root.path());
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let models = body["models"]
        .as_array()
        .unwrap_or_else(|| panic!("health.models must be an array, got body: {body}"));
    assert!(
        models.is_empty(),
        "health must not list a model whose artifact is missing, got: {models:?}"
    );
}

#[tokio::test]
async fn health_reports_onnxruntime_api_generation() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let version = body["onnxruntime_version"].as_str().unwrap_or_default();
    assert!(
        version.contains("onnxruntime api 1.31.x"),
        "health must label the ONNX Runtime API generation, got: {version}"
    );
    assert!(
        version.contains("ort 2.0.0-rc.15"),
        "health must report the binding version, got: {version}"
    );
}

// ── Model contract guard (model-gated) ───────────────────────

#[test]
#[ignore = "requires local ONNX model"]
fn classifier_model_contract_matches_manifest() {
    let dir = models_dir();
    assert!(
        dir.join("manifest.json").is_file(),
        "model-gated test needs {}",
        dir.join("manifest.json").display()
    );

    let registry =
        ModelRegistry::load(&dir).expect("model registry must load models/manifest.json");
    let classifier = registry
        .classifier()
        .expect("manifest must declare the image classifier");
    let contract = classifier.contract();

    assert_eq!(contract.id, MODEL_ID);
    assert_eq!(
        contract.inputs.len(),
        3,
        "the classifier must declare exactly three inputs"
    );

    let input_2 = contract
        .inputs
        .iter()
        .find(|input| input.name == "input_2")
        .expect("contract must declare input_2");
    assert_eq!(input_2.dtype, "float32");
    assert_eq!(input_2.shape, vec![1, 224, 224, 3]);

    for auxiliary in ["45214:0", "45216:0"] {
        let input = contract
            .inputs
            .iter()
            .find(|input| input.name == auxiliary)
            .unwrap_or_else(|| panic!("contract must declare auxiliary input {auxiliary}"));
        assert_eq!(input.dtype, "float32");
        assert_eq!(input.shape, vec![1, 1, 1, 3]);
    }

    assert_eq!(contract.output.name, "Identity:0");
    assert_eq!(contract.output.dtype, "float32");
    assert_eq!(contract.output.shape, vec![1, 1]);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn filter_returns_503_when_graph_contract_mismatches_manifest() {
    let source = models_dir().join(MANIFEST_ARTIFACT);
    assert!(
        source.is_file(),
        "model-gated test needs {}",
        source.display()
    );

    let root = TempModelRoot::new("contract-mismatch");
    let artifact =
        std::fs::read(&source).unwrap_or_else(|error| panic!("could not read {source:?}: {error}"));
    root.write_artifact(MANIFEST_ARTIFACT, &artifact);
    // The real graph is 224x224; declaring 112x112 must be a contract error.
    root.write_manifest(&classifier_manifest(
        ARTIFACT_SHA256,
        "runtime_default",
        [1, 112, 112, 3],
    ));

    let (status, body) = post_caffeine(&root).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.contains("axis 1"),
        "the 503 must explain the axis mismatch, got: {message}"
    );
    assert!(
        message.contains("shape"),
        "the 503 must explain the shape mismatch, got: {message}"
    );
}

// ── Model-gated fixture tests ────────────────────────────────

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn filter_classifies_caffeine_as_structure() {
    let app = test_app_with_models(models_dir());
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["contains_molecule"], true);
    assert_eq!(body["category"], "structure");
    let score = body["score"]
        .as_f64()
        .unwrap_or_else(|| panic!("score must be a number, got body: {body}"));
    assert!(
        score <= THRESHOLD,
        "a structure must score at or below {THRESHOLD}, got {score}"
    );
    assert_eq!(body["threshold"], THRESHOLD);
    assert_eq!(body["model"], MODEL_ID);
    assert_logit_and_score(&body);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn filter_classifies_caffeine_webp_as_structure() {
    let app = test_app_with_models(models_dir());
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/webp",
        fixture_bytes("caffeine.webp"),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["contains_molecule"], true);
    assert_eq!(body["category"], "structure");
    let score = body["score"]
        .as_f64()
        .unwrap_or_else(|| panic!("score must be a number, got body: {body}"));
    assert!(
        score <= THRESHOLD,
        "a structure must score at or below {THRESHOLD}, got {score}"
    );
    assert_eq!(body["threshold"], THRESHOLD);
    assert_eq!(body["model"], MODEL_ID);
    assert_logit_and_score(&body);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn filter_classifies_chinese_character_as_non_structure() {
    let app = test_app_with_models(models_dir());
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/jpeg",
        fixture_bytes("chinese_character.jpg"),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["contains_molecule"], false);
    assert_eq!(body["category"], "no-structure");
    let score = body["score"]
        .as_f64()
        .unwrap_or_else(|| panic!("score must be a number, got body: {body}"));
    assert!(
        score > THRESHOLD,
        "a non-structure must score above {THRESHOLD}, got {score}"
    );
    assert_eq!(body["threshold"], THRESHOLD);
    assert_eq!(body["model"], MODEL_ID);
    assert_logit_and_score(&body);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn filter_classifies_scatter_plot_as_non_structure() {
    let app = test_app_with_models(models_dir());
    let (status, body) = post_bytes(
        &app,
        "/v2/filter/classify",
        "image/png",
        fixture_bytes("random_scatter_plot_64933.png"),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["contains_molecule"], false);
    assert_eq!(body["category"], "no-structure");
    let score = body["score"]
        .as_f64()
        .unwrap_or_else(|| panic!("score must be a number, got body: {body}"));
    assert!(
        score > THRESHOLD,
        "a non-structure must score above {THRESHOLD}, got {score}"
    );
    assert_eq!(body["threshold"], THRESHOLD);
    assert_eq!(body["model"], MODEL_ID);
    assert_logit_and_score(&body);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn health_lists_classifier_when_model_is_present() {
    let app = test_app_with_models(models_dir());
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let models = body["models"]
        .as_array()
        .unwrap_or_else(|| panic!("health.models must be an array, got body: {body}"));
    assert!(
        models.iter().any(|model| model.as_str() == Some(MODEL_ID)),
        "health must list {MODEL_ID}, got: {models:?}"
    );
}
