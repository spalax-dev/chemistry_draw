// Tests for GET /v2/health.
//
// The endpoint is meant for bug reports, so it must expose enough context to
// diagnose a sidecar problem without reading the app logs.

use crate::tests::*;
use axum::http::StatusCode;

#[tokio::test]
async fn health_reports_status_and_port() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["port"], 9321);
    assert!(
        body["version"].as_str().is_some_and(|v| !v.is_empty()),
        "health must report the sidecar version"
    );
    assert!(
        body["pid"].as_u64().is_some(),
        "health must report the process id"
    );
    assert!(
        body["uptime_seconds"].as_u64().is_some(),
        "health must report uptime"
    );
}

#[tokio::test]
async fn info_api_path_uses_the_real_port() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["api_path"], "http://127.0.0.1:9321/v2");
}
