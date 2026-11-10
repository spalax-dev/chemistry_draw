// Cross-platform absence tests for Imago.
//
// Imago is not part of the product anymore: the sidecar is Indigo-only on
// every platform. Ketcher used to toggle "Recognize Molecule" from
// `imago_versions` and to poll `/v2/imago/uploads`, so both the metadata and
// the routes must be gone everywhere — no `#[cfg(windows)]` variant is needed.
//
// These tests run on Linux and Windows CI alike.

use crate::tests::*;
use axum::http::StatusCode;
use serde_json::json;

/// `/v2/info` must not advertise an image-recognition backend, otherwise
/// Ketcher shows a Recognize control that cannot work.
#[tokio::test]
async fn info_has_no_imago_versions() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body.get("imago_versions").is_none(),
        "info must not expose imago_versions, got body: {body}"
    );
}

/// `/v2/indigo/info` is the alias Ketcher calls in some contexts; it must not
/// resurrect the removed field either.
#[tokio::test]
async fn indigo_info_has_no_imago_versions() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/indigo/info").await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body.get("imago_versions").is_none(),
        "indigo info must not expose imago_versions, got body: {body}"
    );
}

/// Health is a support endpoint: it must not mention an Imago backend or a
/// worker path that no longer ships.
#[tokio::test]
async fn health_has_no_imago_fields() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body.get("imago_versions").is_none(),
        "health must not expose imago_versions, got body: {body}"
    );
    assert!(
        body.get("imago_worker").is_none(),
        "health must not expose imago_worker, got body: {body}"
    );
}

/// The upload route must be unregistered on every platform.
#[tokio::test]
async fn imago_upload_route_is_absent() {
    let app = test_app();
    let (status, _) = post_json(&app, "/v2/imago/uploads", json!({ "file": "" })).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the sidecar must not register /v2/imago/uploads"
    );
}

/// The status/poll route must be unregistered as well.
///
/// A 404 alone is not enough: the Imago handler answers an unknown id with its
/// own JSON error, so the body must not come from that handler.
#[tokio::test]
async fn imago_status_route_is_absent() {
    let app = test_app();
    let (status, body) = fetch_get(
        &app,
        "/v2/imago/uploads/00000000-0000-0000-0000-000000000000",
    )
    .await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the sidecar must not register /v2/imago/uploads/{{id}}"
    );
    assert!(
        !body
            .get("error")
            .and_then(|error| error.as_str())
            .is_some_and(|error| error.contains("upload_id")),
        "the 404 must come from the missing route, not the Imago handler; got body: {body}"
    );
}
