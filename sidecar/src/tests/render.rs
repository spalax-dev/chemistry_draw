// Tests para POST /v2/indigo/render
//
// Genera una imagen (SVG, PNG, PDF) de la estructura química.
// Soporta salida binaria directa y codificación base64.
//
// Casos cubiertos:
//   - Render SVG: validar XML y tags esperados
//   - Render PNG base64: verificar estructura del JSON
//   - Molécula quiral: verificar que se renderiza sin error
//   - Molécula grande: ciclohexano con múltiples átomos

use crate::tests::*;
use axum::{body::Body, http, http::StatusCode};

/// Renderiza benceno como SVG y verifica que la respuesta
/// contenga los tags XML esperados.
#[tokio::test]
async fn render_benzene_svg() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": BENZENE, "output_format": "image/svg+xml"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let ct = resp
        .headers()
        .get(http::header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ct.contains("svg"), "content-type should be svg, got: {ct}");

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let svg = String::from_utf8_lossy(&body_bytes);
    assert!(svg.contains("<svg"), "must contain <svg> tag");
    assert!(svg.contains("</svg>"), "must contain closing </svg> tag");
    assert!(
        svg.contains("xmlns"),
        "svg must have xmlns attribute"
    );
}

/// Renderiza benceno como PNG en base64.
/// La respuesta debe ser JSON con campo "data" y "content-type".
#[tokio::test]
async fn render_benzene_png_base64() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/render",
        json!({"struct": BENZENE, "output_format": "image/png;base64"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["data"].is_string(), "must have base64 data field");
    assert!(
        body["content-type"].as_str().unwrap().contains("png"),
        "content-type must be png"
    );
    // PNG files start with iVBORw0KGgo in base64
    let data = body["data"].as_str().unwrap();
    assert!(
        data.starts_with("iVBOR"),
        "PNG base64 should start with iVBOR, got: {data}"
    );
}

/// Molécula quiral (alanina) debe renderizarse correctamente.
#[tokio::test]
async fn render_chiral_molecule_svg() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": ALANINE, "output_format": "image/svg+xml"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let svg = String::from_utf8_lossy(&body_bytes);
    assert!(svg.contains("<svg"), "chiral molecule SVG must be valid");
}

/// Ciclohexano (6 átomos, no aromático) debe renderizarse.
#[tokio::test]
async fn render_cyclohexane_svg() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": CYCLOHEXANE, "output_format": "image/svg+xml"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(!body_bytes.is_empty(), "cyclohexane should produce non-empty SVG");
}

/// Render sin output_format debe usar el default (SVG).
#[tokio::test]
async fn render_default_format_is_svg() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(json!({"struct": BENZENE}).to_string()))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let svg = String::from_utf8_lossy(&body_bytes);
    assert!(svg.contains("<svg"), "default format should be SVG");
}
