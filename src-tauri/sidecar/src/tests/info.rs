// Tests para GET /v2/info y GET /v2/indigo/info
//
// Estos endpoints retornan metadatos del servicio Indigo.
// Ketcher los consulta al iniciar para verificar que el backend
// está disponible y obtener la versión de Indigo.

use crate::tests::*;
use axum::http::StatusCode;

/// Verifica que /v2/info responde con HTTP 200 y un JSON
/// que contiene el objeto "Indigo" con clave "version".
#[tokio::test]
async fn info_endpoint_returns_version() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    let version = body["Indigo"]["version"].as_str().unwrap();
    assert!(!version.is_empty(), "version string should not be empty");
    assert!(
        version.contains('.'),
        "version should contain dots, got: {version}"
    );
}

/// /v2/indigo/info returns the same as /v2/info.
/// Ketcher consulta ambas rutas dependiendo del contexto.
#[tokio::test]
async fn indigo_info_is_same_as_info() {
    let app = test_app();

    let (s1, b1) = fetch_get(&app, "/v2/info").await;
    let (s2, b2) = fetch_get(&app, "/v2/indigo/info").await;

    assert_eq!(s1, StatusCode::OK);
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b1, b2, "both info endpoints should return identical data");
}

/// Repeated consecutive calls to /v2/info return
/// la misma versión consistente.
#[tokio::test]
async fn info_idempotent() {
    let app = test_app();

    let (_, b1) = fetch_get(&app, "/v2/info").await;
    let (_, b2) = fetch_get(&app, "/v2/info").await;
    let (_, b3) = fetch_get(&app, "/v2/info").await;

    assert_eq!(b1, b2);
    assert_eq!(b1, b3, "info must be idempotent across calls");
}
