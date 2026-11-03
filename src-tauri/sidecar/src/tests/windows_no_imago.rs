// Windows builds ship without Imago (no OpenCV, no OCR worker), so the
// sidecar must not advertise an image-recognition backend and must not
// register the Imago upload routes. Ketcher disables "Recognize Molecule"
// when `imago_versions` is empty.
//
// These tests only run on Windows: Linux keeps Imago.

use crate::tests::*;
use axum::http::StatusCode;
use serde_json::json;

/// `/v2/info` must report an empty `imago_versions` array so Ketcher hides
/// the image-recognition action.
#[tokio::test]
async fn windows_info_reports_empty_imago_versions() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["imago_versions"],
        json!([]),
        "Windows build must report no Imago versions"
    );
}

/// `/v2/indigo/info` is an alias of `/v2/info`; it must report the same
/// empty Imago list.
#[tokio::test]
async fn windows_indigo_info_reports_empty_imago_versions() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/indigo/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["imago_versions"], json!([]));
}

/// The Imago upload routes must not exist on Windows.
#[tokio::test]
async fn windows_imago_upload_route_is_absent() {
    let app = test_app();
    let (status, _) = post_json(&app, "/v2/imago/uploads", json!({ "file": "" })).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "Windows build must not register /v2/imago/uploads"
    );
}

/// The status/poll route must be absent as well.
#[tokio::test]
async fn windows_imago_status_route_is_absent() {
    let app = test_app();
    let (status, _) = fetch_get(
        &app,
        "/v2/imago/uploads/00000000-0000-0000-0000-000000000000",
    )
    .await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "Windows build must not register /v2/imago/uploads/{{id}}"
    );
}

/// Health is a support endpoint: on Windows it must state that no Imago
/// backend or worker exists instead of dangling a bogus path.
#[tokio::test]
async fn windows_health_reports_no_imago_backend() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["imago_versions"], json!([]));
    assert_eq!(body["imago_worker"]["found"], false);
    let path = &body["imago_worker"]["path"];
    assert!(
        path.is_null() || body["imago_worker"].get("path").is_none(),
        "Windows health must not advertise an Imago worker path, got {path}"
    );
}

/// The stub must not silently return a fake structure when someone calls it
/// directly (e.g. a future route or the worker binary).
#[test]
fn windows_imago_recognize_returns_clear_error() {
    let err = crate::ffi::imago::recognize().expect_err("Imago must be unavailable on Windows");

    assert!(
        err.to_string()
            .contains("not available in the Windows build"),
        "error must explain the limitation, got: {err}"
    );
}
