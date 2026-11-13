//! Recognize Molecule end-to-end flow: the Ketcher-compatible
//! `/v2/imago/uploads` job protocol, the in-memory job store, the
//! filter → OCSR → molfile outcome mapping and the synthetic
//! `imago_versions` capability.
//!
//! This module replaces the old `imago_absent` contract: the real Imago
//! backend, worker and libraries stay absent on every platform, while the
//! compatibility routes and the synthetic capability are now part of the
//! product. No `#[cfg(windows)]` variant is needed.
//!
//! The suite has three tiers, like the classifier and OCSR suites:
//!
//! - always run: the info/health compatibility contract, upload validation,
//!   the job store (with an injected clock, never a wall-clock sleep) and the
//!   pure pipeline outcome mapping;
//! - always run, staged: the HTTP terminal-state shapes, staged through the
//!   job store instead of a real pipeline;
//! - model-gated (`#[ignore = "requires local ONNX model"]`): the real
//!   caffeine SUCCESS and non-structure FAILURE; they self-skip when the
//!   artifacts are absent.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::service::indigo_ops;
use crate::service::jobs::{JobStatus, JobStore, TTL};
use crate::service::ml::ocsr::OcsrPrediction;
use crate::service::recognition::{accept_conversion, accept_prediction, RecognitionFailure};
use crate::tests::*;
use crate::transport::filter::MAX_BODY_BYTES;
use crate::transport::imago::spawn_processing_with;

// ── Constants ─────────────────────────────────────────────────

/// Provenance note: the compatibility shim runs the local OCSR model, so the
/// capability list Ketcher sees has exactly one synthetic entry.
const SYNTHETIC_IMAGO_VERSIONS: [&str; 1] = ["local-ocsr"];
/// Provisional in-domain confidence threshold recorded by the manifest.
const CONFIDENCE_THRESHOLD: f64 = 0.901;
/// Exact SMILES the real model decodes from `caffeine.png`.
const CAFFEINE_SMILES: &str = "CN1C=NC2=C1C(=O)N(C)C(=O)N2C";
/// Indigo's SMILES output format, as used by `/v2/indigo/convert`.
const SMILES_FORMAT: &str = "chemical/x-daylight-smiles";

/// Documented FAILURE copy, asserted exactly because the UI matches it.
const NO_MOLECULE_MESSAGE: &str = "No molecule was detected in this image.";
const LOW_CONFIDENCE_MESSAGE: &str =
    "The structure could not be read confidently. Try a sharper or larger image.";
const UNSUPPORTED_IMAGE_MESSAGE: &str = "Unsupported image. Use a PNG, JPEG or WebP file.";
const MODEL_UNAVAILABLE_MESSAGE: &str =
    "Recognition models are not available. Check the model setup.";
const CONVERSION_MESSAGE: &str =
    "The recognized structure could not be prepared for the editor. Try again.";
const TIMEOUT_MESSAGE: &str = "Recognition timed out. Try again.";

/// Classifier artifact path inside the model root.
const CLASSIFIER_ARTIFACT: &str = "image-classifier-fp16/classifier.fp16.onnx";
/// OCSR encoder artifact path inside the model root.
const ENCODER_ARTIFACT: &str = "ocsr-handdrawn-fp32/encoder.onnx";
/// OCSR decoder-step artifact path inside the model root.
const DECODER_ARTIFACT: &str = "ocsr-handdrawn-fp32/decoder_step.onnx";
/// OCSR vocabulary artifact path inside the model root.
const VOCAB_ARTIFACT: &str = "ocsr-handdrawn-fp32/vocab.json";

// ── Helpers ───────────────────────────────────────────────────

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

/// A model root that must not exist, so the worker resolves a configuration
/// error instead of loading the developer's real models.
fn missing_model_root(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the UNIX epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "chemistry-draw-recognition-{}-{label}-{nanos}",
        std::process::id()
    ));
    assert!(
        !path.exists(),
        "test needs an absent model directory: {path:?}"
    );
    path
}

/// Reads the `upload_id` of an accepted upload.
fn upload_id(body: &Value) -> &str {
    body["upload_id"]
        .as_str()
        .unwrap_or_else(|| panic!("the upload response must carry a string upload_id, got: {body}"))
}

/// Polls a job until it leaves `PENDING`, failing the test after `timeout`.
///
/// The poll interval is short (the real client uses 500 ms), but the timeout is
/// a bound on the pipeline, not a fixed sleep.
async fn poll_job(app: &axum::Router, id: &str, timeout: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let path = format!("/v2/imago/uploads/{id}");
        let (status, body) = fetch_get(app, &path).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "polling job {id} must answer 200, got body: {body}"
        );
        if body["state"] != "PENDING" {
            return body;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "job {id} stayed PENDING for {timeout:?}; last body: {body}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A model-gated test needs the manifest plus the listed artifacts; otherwise
/// it logs the missing file and returns `None` so the test self-skips.
fn gated_model_root(required: &[&str]) -> Option<PathBuf> {
    let dir = models_dir();
    let manifest = dir.join("manifest.json");
    if !manifest.is_file() {
        eprintln!("skipping: {} is missing", manifest.display());
        return None;
    }
    for relative in required {
        let path = dir.join(relative);
        if !path.is_file() {
            eprintln!("skipping: model artifact {} is missing", path.display());
            return None;
        }
    }
    Some(dir)
}

fn prediction(smiles: &str, confidence: f64, incomplete: bool) -> OcsrPrediction {
    OcsrPrediction {
        smiles: smiles.to_string(),
        confidence,
        incomplete,
    }
}

// ── Info compatibility (no model) ─────────────────────────────

/// Ketcher recomputes the Recognize control's `disabled` state from this list
/// after `GET /v2/info`: exactly one synthetic entry enables the shim.
#[tokio::test]
async fn info_advertises_the_synthetic_imago_capability() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["imago_versions"],
        json!(SYNTHETIC_IMAGO_VERSIONS),
        "info must advertise exactly the synthetic local-ocsr capability, got: {body}"
    );
    assert!(
        body["indigo_version"]
            .as_str()
            .is_some_and(|version| !version.is_empty()),
        "info must keep reporting the Indigo version, got: {body}"
    );
    assert_eq!(
        body["api_path"], "http://127.0.0.1:9321/v2",
        "info must keep reporting the real api_path, got: {body}"
    );
    assert!(
        body.get("imago_worker").is_none() && body.get("imago").is_none(),
        "the only Imago-looking field is the synthetic capability list, got: {body}"
    );
}

/// `/v2/indigo/info` is the alias Ketcher calls in some contexts; it must
/// advertise the same synthetic capability.
#[tokio::test]
async fn indigo_info_alias_advertises_the_synthetic_imago_capability() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/indigo/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["imago_versions"],
        json!(SYNTHETIC_IMAGO_VERSIONS),
        "the alias must advertise the same synthetic capability, got: {body}"
    );
    assert!(
        body.get("imago_worker").is_none(),
        "the alias must not expose a real Imago backend, got: {body}"
    );
}

/// Health is a support endpoint: it must not mention an Imago backend or a
/// worker path that does not ship.
#[tokio::test]
async fn health_exposes_no_imago_backend_fields() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body.get("imago_versions").is_none(),
        "health must not expose the capability list, got: {body}"
    );
    assert!(
        body.get("imago_worker").is_none(),
        "health must not expose imago_worker, got: {body}"
    );
}

// ── Upload protocol (no model) ────────────────────────────────

/// The handler must accept the body and return an id even when no model is
/// installed: model errors resolve in the worker, never as a synchronous 503.
#[tokio::test]
async fn upload_returns_an_id() {
    let app = test_app_with_models(missing_model_root("upload-id"));

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;

    assert_eq!(
        status,
        StatusCode::OK,
        "POST must accept the upload before resolving any model, got body: {body}"
    );
    assert!(
        !upload_id(&body).is_empty(),
        "the upload id must be a non-empty string, got: {body}"
    );
    assert!(
        body.get("error").is_none(),
        "an accepted upload must not carry an error, got: {body}"
    );
}

/// Ketcher sends the dialog's Imago version as `?version=`; one local model
/// serves every request, so the query is accepted and ignored.
#[tokio::test]
async fn upload_accepts_the_version_query() {
    let app = test_app_with_models(missing_model_root("upload-version"));

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads?version=local-ocsr",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert!(
        !upload_id(&body).is_empty(),
        "the version query must not prevent the upload, got: {body}"
    );
}

/// An unknown job id answers with the route's JSON error; a missing route would
/// answer 404 with an empty body, so the body is what proves the shim exists.
#[tokio::test]
async fn unknown_upload_returns_404() {
    let app = test_app();

    let (status, body) = fetch_get(
        &app,
        "/v2/imago/uploads/00000000-0000-0000-0000-000000000000",
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        !error_message(&body).is_empty(),
        "the 404 must come from the compatibility route and carry {{ error }}, got: {body}"
    );
}

#[tokio::test]
async fn upload_rejects_unsupported_media_type() {
    let app = test_app_with_models(missing_model_root("upload-media-type"));

    let (status, body) =
        post_bytes(&app, "/v2/imago/uploads", "text/plain", b"hello".to_vec()).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.contains("image/png")
            && message.contains("image/jpeg")
            && message.contains("image/webp"),
        "the 400 must list the supported image types, got: {message}"
    );
    assert!(
        body.get("upload_id").is_none(),
        "a rejected media type must not create a job, got: {body}"
    );
}

/// One byte over the documented cap must be rejected by the route limit before
/// the handler runs; the body is axum's plain text, not `{ "error": ... }`.
#[tokio::test]
async fn upload_rejects_oversized_body() {
    let app = test_app_with_models(missing_model_root("upload-oversized"));
    let body = vec![0u8; MAX_BODY_BYTES + 1];

    let (status, response) = post_bytes(&app, "/v2/imago/uploads", "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "a body over 10 MiB must be rejected with 413, got body: {response}"
    );
}

/// The cap is inclusive: exactly 10,485,760 bytes must reach the handler.
#[tokio::test]
async fn upload_accepts_bodies_at_exactly_ten_megabytes() {
    let app = test_app_with_models(missing_model_root("upload-exact-cap"));
    let body = vec![0u8; MAX_BODY_BYTES];

    let (status, response) = post_bytes(&app, "/v2/imago/uploads", "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "exactly 10 MiB is inside the inclusive cap and must be accepted, got body: {response}"
    );
    assert!(
        !upload_id(&response).is_empty(),
        "an accepted body must produce an upload id, got: {response}"
    );
}

/// POST stores the bytes without decoding them: an undecodable body is a job
/// FAILURE later, never a synchronous 400. The decode runs before the model
/// registry, so the documented unsupported-image copy is reported even when no
/// model is installed.
#[tokio::test]
async fn undecodable_upload_fails_with_the_unsupported_image_message() {
    let app = test_app_with_models(missing_model_root("upload-undecodable"));

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        b"this is not a PNG".to_vec(),
    )
    .await;

    assert_eq!(
        status,
        StatusCode::OK,
        "POST must not decode the image, got body: {body}"
    );
    let id = upload_id(&body).to_string();
    let job = poll_job(&app, &id, Duration::from_secs(10)).await;

    assert_eq!(job["state"], "FAILURE", "job: {job}");
    assert_eq!(
        job["error"], UNSUPPORTED_IMAGE_MESSAGE,
        "undecodable bytes must resolve with the documented unsupported-image copy, got: {job}"
    );
    assert!(
        job.get("metadata").is_none(),
        "an undecodable image must not carry a molfile, got: {job}"
    );
}

/// A missing model root must resolve in the worker: POST returns an id and the
/// job fails with the documented model-unavailable copy plus the setup hint.
#[tokio::test]
async fn upload_fails_when_models_are_missing() {
    let app = test_app_with_models(missing_model_root("upload-missing-models"));

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;

    assert_eq!(
        status,
        StatusCode::OK,
        "the handler must accept the upload even when models are missing, got body: {body}"
    );
    let id = upload_id(&body).to_string();
    let job = poll_job(&app, &id, Duration::from_secs(10)).await;

    assert_eq!(job["state"], "FAILURE", "job: {job}");
    let message = job["error"]
        .as_str()
        .unwrap_or_else(|| panic!("a FAILURE must carry a string error, got: {job}"));
    assert!(
        message.starts_with(MODEL_UNAVAILABLE_MESSAGE),
        "the FAILURE must start with the documented model-unavailable copy, got: {message}"
    );
    assert!(
        message.contains("CHEMISTRY_MODELS_DIR"),
        "the FAILURE must keep the actionable model-root hint, got: {message}"
    );
    assert!(
        job.get("metadata").is_none(),
        "a FAILURE must not carry metadata, got: {job}"
    );
}

// ── Job store (pure state machine, injected clock) ────────────

#[test]
fn job_store_ttl_is_ten_minutes() {
    assert_eq!(
        TTL,
        Duration::from_secs(600),
        "the documented job TTL is 10 minutes"
    );
}

#[test]
fn job_store_reports_a_new_job_as_pending() {
    let store = JobStore::new();
    let now = Instant::now();

    let id = store.create(b"raw image bytes".to_vec(), now);

    assert!(!id.is_empty(), "the job id must not be empty");
    assert_eq!(
        store.get(&id, now),
        Some(JobStatus::Pending),
        "a created job must be PENDING"
    );
}

#[test]
fn job_store_reports_success_with_the_molfile() {
    let store = JobStore::new();
    let now = Instant::now();
    let id = store.create(b"raw image bytes".to_vec(), now);

    assert!(
        store.succeed(&id, CAFFEINE_MOL.to_string(), now),
        "completing a known PENDING job must be accepted"
    );

    assert_eq!(
        store.get(&id, now + Duration::from_secs(1)),
        Some(JobStatus::Success {
            molfile: CAFFEINE_MOL.to_string(),
        }),
        "a successful job must expose the molfile for polling"
    );
}

#[test]
fn job_store_reports_failure_with_the_message() {
    let store = JobStore::new();
    let now = Instant::now();
    let id = store.create(b"raw image bytes".to_vec(), now);

    assert!(
        store.fail(&id, NO_MOLECULE_MESSAGE.to_string(), now),
        "failing a known PENDING job must be accepted"
    );

    assert_eq!(
        store.get(&id, now + Duration::from_secs(1)),
        Some(JobStatus::Failure {
            error: NO_MOLECULE_MESSAGE.to_string(),
        }),
        "a failed job must expose the actionable message for polling"
    );
}

#[test]
fn job_store_returns_none_for_an_unknown_id() {
    let store = JobStore::new();

    assert_eq!(
        store.get("00000000-0000-0000-0000-000000000000", Instant::now()),
        None,
        "an unknown id must be unknown, so the handler can answer 404"
    );
}

#[test]
fn job_store_rejects_completion_of_an_unknown_id() {
    let store = JobStore::new();
    let now = Instant::now();

    assert!(
        !store.succeed("unknown", "molfile".to_string(), now),
        "completing an unknown job must report false"
    );
    assert!(
        !store.fail("unknown", "error".to_string(), now),
        "failing an unknown job must report false"
    );
}

#[test]
fn job_store_creates_unique_ids() {
    let store = JobStore::new();
    let now = Instant::now();

    let first = store.create(b"first image".to_vec(), now);
    let second = store.create(b"second image".to_vec(), now);

    assert_ne!(first, second, "two uploads must get distinct ids");
    assert_eq!(store.get(&first, now), Some(JobStatus::Pending));
    assert_eq!(store.get(&second, now), Some(JobStatus::Pending));
}

#[test]
fn job_store_reports_a_pending_job_as_timed_out_at_the_ttl() {
    let store = JobStore::new();
    let created = Instant::now();
    let id = store.create(b"raw image bytes".to_vec(), created);

    assert_eq!(
        store.get(&id, created + TTL - Duration::from_secs(1)),
        Some(JobStatus::Pending),
        "one second before the TTL the job must still be PENDING"
    );

    match store.get(&id, created + TTL) {
        Some(JobStatus::Failure { error }) => assert_eq!(
            error, TIMEOUT_MESSAGE,
            "a PENDING job at the TTL boundary becomes the timeout FAILURE"
        ),
        other => panic!("expected the timeout FAILURE at the TTL, got: {other:?}"),
    }
}

#[test]
fn job_store_forgets_a_resolved_job_after_the_ttl() {
    let store = JobStore::new();
    let created = Instant::now();
    let resolved_at = created + Duration::from_secs(5);
    let id = store.create(b"raw image bytes".to_vec(), created);
    assert!(
        store.succeed(&id, CAFFEINE_MOL.to_string(), resolved_at),
        "completing a known PENDING job must be accepted"
    );

    // An early purge keeps the job: the TTL runs from the resolution.
    store.purge(resolved_at);
    assert_eq!(
        store.get(&id, resolved_at + TTL - Duration::from_secs(1)),
        Some(JobStatus::Success {
            molfile: CAFFEINE_MOL.to_string(),
        }),
        "a resolved job must be reachable until resolved_at + TTL"
    );

    store.purge(resolved_at + TTL);
    assert!(
        store.get(&id, resolved_at + TTL).is_none(),
        "a resolved job must be discarded at resolved_at + TTL, so a later poll is 404"
    );
}

#[test]
fn job_store_forgets_a_timed_out_job_after_the_ttl() {
    let store = JobStore::new();
    let created = Instant::now();
    let id = store.create(b"raw image bytes".to_vec(), created);
    let timed_out_at = created + TTL;

    assert!(
        matches!(
            store.get(&id, timed_out_at),
            Some(JobStatus::Failure { .. })
        ),
        "the PENDING job must report the timeout FAILURE on its first late poll"
    );

    store.purge(timed_out_at + TTL);
    assert!(
        store.get(&id, timed_out_at + TTL).is_none(),
        "the timed-out job resolves at the TTL and must be pruned one TTL later"
    );
}

/// `get` returning `None` is not enough: the expired entry must leave the map,
/// otherwise the store grows for the process lifetime. `len` makes the removal
/// observable.
#[test]
fn job_store_purge_removes_resolved_and_timed_out_entries() {
    let store = JobStore::new();
    let created = Instant::now();
    let resolved = store.create(b"resolved image".to_vec(), created);
    let abandoned = store.create(b"abandoned image".to_vec(), created);
    assert!(
        store.succeed(&resolved, CAFFEINE_MOL.to_string(), created),
        "resolving the staged job must be accepted"
    );
    assert_eq!(store.len(), 2, "both jobs must be stored before the purge");

    // The resolved job is past resolved_at + TTL; the abandoned one times out
    // as the purge observes it, so it is not pruned yet.
    store.purge(created + TTL);
    assert_eq!(
        store.len(),
        1,
        "the resolved job must be removed from the map, not just hidden from get"
    );
    assert!(
        store.get(&resolved, created + TTL).is_none(),
        "the pruned job must be unknown to get"
    );
    assert!(
        matches!(
            store.get(&abandoned, created + TTL),
            Some(JobStatus::Failure { .. })
        ),
        "the pending job resolves as the timeout FAILURE during the purge"
    );

    store.purge(created + TTL * 2);
    assert!(
        store.is_empty(),
        "the timed-out job must be pruned one TTL after it resolved"
    );
}

// ── Pipeline outcome mapping (pure, no model) ─────────────────

/// The filter is a hard gate: a confident OCSR prediction must not rescue a
/// `no-structure` verdict.
#[test]
fn recognition_rejects_a_non_structure_before_the_ocsr_gate() {
    let failure = accept_prediction(
        false,
        &prediction(CAFFEINE_SMILES, 0.999, false),
        CONFIDENCE_THRESHOLD,
    )
    .expect_err("a no-structure verdict must fail the job");

    assert_eq!(failure, RecognitionFailure::NoMolecule);
    assert_eq!(failure.message(), NO_MOLECULE_MESSAGE);
}

/// A truncated SMILES is never converted, even when the confidence is high.
#[test]
fn recognition_rejects_an_incomplete_decode_despite_high_confidence() {
    let failure = accept_prediction(true, &prediction("C", 0.99, true), CONFIDENCE_THRESHOLD)
        .expect_err("an incomplete decode must fail the job");

    assert_eq!(failure, RecognitionFailure::LowConfidence);
    assert_eq!(failure.message(), LOW_CONFIDENCE_MESSAGE);
}

#[test]
fn recognition_rejects_confidence_below_the_threshold() {
    let failure = accept_prediction(true, &prediction("C", 0.9009, false), CONFIDENCE_THRESHOLD)
        .expect_err("a confidence below 0.901 must fail the job");

    assert_eq!(failure, RecognitionFailure::LowConfidence);
}

#[test]
fn recognition_accepts_confidence_exactly_at_the_threshold() {
    let smiles = accept_prediction(true, &prediction("C", 0.901, false), CONFIDENCE_THRESHOLD)
        .expect("the threshold is inclusive: 0.901 passes");

    assert_eq!(smiles, "C");
}

#[test]
fn recognition_accepts_a_confident_complete_prediction() {
    let smiles = accept_prediction(
        true,
        &prediction(CAFFEINE_SMILES, 0.995, false),
        CONFIDENCE_THRESHOLD,
    )
    .expect("a confident complete prediction must pass both gates");

    assert_eq!(
        smiles, CAFFEINE_SMILES,
        "the gate must hand the recognized SMILES to the conversion stage"
    );
}

#[test]
fn recognition_maps_an_indigo_conversion_failure() {
    let failure = accept_conversion(Err(AppError::bad_request(
        "Indigo cannot load the recognized SMILES",
    )))
    .expect_err("a conversion failure must fail the job");

    assert_eq!(failure, RecognitionFailure::Conversion);
    assert_eq!(failure.message(), CONVERSION_MESSAGE);
}

#[test]
fn recognition_accepts_a_converted_molfile() {
    let molfile = accept_conversion(Ok(CAFFEINE_MOL.to_string()))
        .expect("a successfully converted molfile must pass the last gate");

    assert_eq!(molfile, CAFFEINE_MOL);
}

/// The exact strings are the UI's matching contract; every branch is pinned.
#[test]
fn recognition_failure_messages_match_the_ui_contract() {
    for (failure, expected) in [
        (RecognitionFailure::NoMolecule, NO_MOLECULE_MESSAGE),
        (RecognitionFailure::LowConfidence, LOW_CONFIDENCE_MESSAGE),
        (
            RecognitionFailure::UnsupportedImage,
            UNSUPPORTED_IMAGE_MESSAGE,
        ),
        (
            RecognitionFailure::ModelUnavailable,
            MODEL_UNAVAILABLE_MESSAGE,
        ),
        (RecognitionFailure::Conversion, CONVERSION_MESSAGE),
        (RecognitionFailure::Timeout, TIMEOUT_MESSAGE),
    ] {
        assert_eq!(
            failure.message(),
            expected,
            "the UI matches this message verbatim"
        );
    }
}

// ── Ketcher polling contract (staged, no model) ──────────────

/// The exact client sequence with no usable model: POST the blob, read
/// `upload_id`, GET it, and receive a `state` + `error` FAILURE with HTTP 200.
#[tokio::test]
async fn ketcher_polling_contract_ends_in_failure_without_models() {
    let app = test_app_with_models(missing_model_root("ketcher-failure"));

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let id = upload_id(&body).to_string();

    let job = poll_job(&app, &id, Duration::from_secs(10)).await;

    assert_eq!(job["state"], "FAILURE", "job: {job}");
    assert!(
        job["error"].as_str().is_some_and(|error| !error.is_empty()),
        "the FAILURE must carry a non-empty error string, got: {job}"
    );
    assert!(
        job.get("metadata").is_none(),
        "the FAILURE must not carry metadata, got: {job}"
    );
    assert_eq!(
        job.as_object().map(|object| object.len()),
        Some(2),
        "the FAILURE body is exactly state + error, got: {job}"
    );
}

/// Terminal SUCCESS shape, staged through the store because the real pipeline
/// needs models. Ketcher parses `metadata.mol_str` and adds it to the canvas;
/// no SMILES is ever sent to the client.
#[tokio::test]
async fn ketcher_polling_contract_serializes_a_success_job() {
    let (app, state) = test_app_and_state(missing_model_root("ketcher-success"));
    let jobs = state.jobs();
    let now = Instant::now();
    let id = jobs.create(fixture_bytes("caffeine.png"), now);
    assert!(
        jobs.succeed(&id, CAFFEINE_MOL.to_string(), now),
        "staging a resolved job must succeed"
    );

    let (status, job) = fetch_get(&app, &format!("/v2/imago/uploads/{id}")).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["state"], "SUCCESS", "job: {job}");
    assert_eq!(
        job["metadata"]["mol_str"], CAFFEINE_MOL,
        "the client must receive the staged V2000 molfile, got: {job}"
    );
    assert!(
        job.get("error").is_none(),
        "a SUCCESS must not carry an error, got: {job}"
    );
    assert_eq!(
        job.as_object().map(|object| object.len()),
        Some(2),
        "the SUCCESS body is exactly state + metadata, got: {job}"
    );
    assert_eq!(
        job["metadata"].as_object().map(|object| object.len()),
        Some(1),
        "metadata carries exactly mol_str, got: {job}"
    );
}

/// Both handlers prune before answering, so a long-lived process cannot
/// accumulate expired jobs: a stale resolved job is removed by the next poll
/// and by the next upload.
#[tokio::test]
async fn upload_and_poll_handlers_prune_expired_jobs() {
    let (app, state) = test_app_and_state(missing_model_root("handler-prune"));
    let jobs = state.jobs();
    let Some(stale_created) = Instant::now().checked_sub(TTL * 2) else {
        eprintln!("skipping: this clock cannot represent 20 minutes ago");
        return;
    };

    let stale = jobs.create(b"stale image".to_vec(), stale_created);
    assert!(
        jobs.succeed(&stale, CAFFEINE_MOL.to_string(), stale_created),
        "resolving the stale job must be accepted"
    );
    assert_eq!(jobs.len(), 1, "the stale job must be staged");

    let (status, _) = fetch_get(&app, "/v2/imago/uploads/unknown").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        jobs.is_empty(),
        "a poll must purge the expired job from the store"
    );

    let stale = jobs.create(b"stale image".to_vec(), stale_created);
    assert!(jobs.succeed(&stale, CAFFEINE_MOL.to_string(), stale_created));
    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(
        jobs.len(),
        1,
        "an upload must purge the expired job and keep only the new one"
    );
}

/// The worker bound is a separate timeout from the store TTL: a pipeline that
/// outlives it resolves the job as the documented timeout FAILURE. The bound is
/// injected so the test does not wait the production 120 s.
#[tokio::test]
async fn worker_timeout_resolves_the_job_as_the_timeout_failure() {
    let (app, state) = test_app_and_state(missing_model_root("worker-timeout"));
    let jobs = state.jobs();
    let id = jobs.create(b"raw image bytes".to_vec(), Instant::now());
    let (release, blocked) = std::sync::mpsc::channel::<()>();

    spawn_processing_with(
        state.clone(),
        id.clone(),
        b"raw image bytes".to_vec(),
        Duration::from_millis(20),
        move |_, _| {
            // Hold the blocking pipeline open until the timeout arm resolved
            // the job; the test releases it afterwards.
            let _ = blocked.recv();
            Ok(CAFFEINE_MOL.to_string())
        },
    );

    let job = poll_job(&app, &id, Duration::from_secs(10)).await;
    release
        .send(())
        .expect("the fake worker must still be blocked");

    assert_eq!(job["state"], "FAILURE", "job: {job}");
    assert_eq!(
        job["error"], TIMEOUT_MESSAGE,
        "a pipeline over the bound must use the documented timeout copy, got: {job}"
    );
    assert!(
        job.get("metadata").is_none(),
        "a timed-out job must not carry a molfile, got: {job}"
    );
}

// ── Model-gated end-to-end tests ─────────────────────────────

/// A real image inserts a structure: the job resolves SUCCESS with a V2000
/// molfile that Indigo reads back as caffeine. The filter and OCSR pair are
/// both required, so the test self-skips when either is absent.
#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn caffeine_upload_recognizes_to_molfile() {
    let Some(dir) = gated_model_root(&[
        CLASSIFIER_ARTIFACT,
        ENCODER_ARTIFACT,
        DECODER_ARTIFACT,
        VOCAB_ARTIFACT,
    ]) else {
        return;
    };
    let app = test_app_with_models(dir);

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/png",
        fixture_bytes("caffeine.png"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let id = upload_id(&body).to_string();

    // The first recognition loads the ~316 MB OCSR pair, hence the long bound.
    let job = poll_job(&app, &id, Duration::from_secs(90)).await;

    assert_eq!(
        job["state"], "SUCCESS",
        "the real pipeline must recognize the caffeine fixture, got: {job}"
    );
    let molfile = job["metadata"]["mol_str"].as_str().unwrap_or_else(|| {
        panic!("a SUCCESS job must carry metadata.mol_str as a string, got: {job}")
    });
    assert!(
        molfile.contains("V2000"),
        "the client needs a V2000 molfile, got: {molfile}"
    );
    assert!(
        molfile.contains("M  END"),
        "the molfile must be complete, got: {molfile}"
    );
    let counts_line = molfile
        .lines()
        .find(|line| line.contains("V2000"))
        .unwrap_or_else(|| panic!("the molfile must have a V2000 counts line, got: {molfile}"));
    assert!(
        counts_line.trim_start().starts_with("14 15"),
        "the counts line must declare caffeine's 14 atoms and 15 bonds, got: {counts_line}"
    );

    // Comparing canonical SMILES through Indigo proves the molfile encodes
    // caffeine without pinning Indigo's aromatic spelling of the output.
    let expected = indigo_ops::convert(CAFFEINE_SMILES, SMILES_FORMAT)
        .expect("Indigo must canonicalize the expected caffeine SMILES");
    let actual = indigo_ops::convert(molfile, SMILES_FORMAT)
        .expect("Indigo must parse the recognized molfile");
    assert_eq!(
        actual.trim(),
        expected.trim(),
        "the molfile must encode the caffeine structure, got: {molfile}"
    );
}

/// A non-structure image is rejected by the filter gate with the documented
/// copy. Only the classifier is needed: the filter fails before OCSR loads.
#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn non_structure_upload_fails() {
    let Some(dir) = gated_model_root(&[CLASSIFIER_ARTIFACT]) else {
        return;
    };
    let app = test_app_with_models(dir);

    let (status, body) = post_bytes(
        &app,
        "/v2/imago/uploads",
        "image/jpeg",
        fixture_bytes("chinese_character.jpg"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {body}");
    let id = upload_id(&body).to_string();

    let job = poll_job(&app, &id, Duration::from_secs(30)).await;

    assert_eq!(job["state"], "FAILURE", "job: {job}");
    assert_eq!(
        job["error"], NO_MOLECULE_MESSAGE,
        "a filter rejection must use the documented no-molecule copy, got: {job}"
    );
    assert!(
        job.get("metadata").is_none(),
        "a rejected image must not return a molfile, got: {job}"
    );
}
