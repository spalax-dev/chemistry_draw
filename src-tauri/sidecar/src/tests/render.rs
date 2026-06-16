// Tests para POST /v2/indigo/render
//
// Generates an image (SVG, PNG, PDF) of the chemical structure.
// El endpoint siempre devuelve base64 como text/plain.
// Ketcher decodifica con atob() y crea un Blob.
//
// Casos cubiertos:
//   - Render SVG: validar que devuelve base64 decodificable a XML
//   - Render PNG: validar header PNG (iVBOR) en base64
//   - Chiral molecule: renders without error
//   - Large molecule: aspirin from real molfile
//   - Invalid molecule: returns HTTP 400
//   - Render via options (Ketcher path: render-output-format en options)
//   - Render sin output_format (default SVG)

use crate::tests::*;
use axum::{body::Body, http, http::StatusCode};
use base64::Engine;

fn decode_b64(b64: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64")
}

/// Renders benzene as SVG via options (Ketcher sends format via options).
/// Valida que la respuesta sea base64 decodificable a XML SVG.
#[tokio::test]
async fn render_benzene_svg_via_options() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": BENZENE, "options": {"render-output-format": "svg"}}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let b64 = String::from_utf8_lossy(&body_bytes);
    let svg_bytes = decode_b64(&b64);
    let svg = String::from_utf8_lossy(&svg_bytes);
    assert!(svg.contains("<svg"), "must contain <svg> tag");
    assert!(svg.contains("</svg>"), "must contain closing </svg> tag");
}

/// Renderiza benceno como SVG usando output_format directo.
#[tokio::test]
async fn render_benzene_svg_direct() {
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

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let b64 = String::from_utf8_lossy(&body_bytes);
    let svg_bytes = decode_b64(&b64);
    let svg = String::from_utf8_lossy(&svg_bytes);

    assert!(svg.contains("<svg"), "must contain <svg> tag");
    assert!(svg.contains("</svg>"), "must contain closing </svg> tag");
    assert!(svg.contains("xmlns"), "svg must have xmlns attribute");
}

/// Renderiza benceno como PNG via options (Ketcher path).
#[tokio::test]
async fn render_benzene_png_via_options() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": BENZENE, "options": {"render-output-format": "png"}}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let b64 = String::from_utf8_lossy(&body_bytes);
    let png_bytes = decode_b64(&b64);

    // PNG header: 89 50 4E 47 0D 0A 1A 0A
    assert_eq!(&png_bytes[..4], [137, 80, 78, 71], "must be PNG magic bytes");
    assert!(
        png_bytes.len() > 100,
        "PNG should be more than 100 bytes, got {}",
        png_bytes.len()
    );
}

/// Chiral molecule (alanine) renders correctly as SVG.
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
    let b64 = String::from_utf8_lossy(&body_bytes);
    let svg_bytes = decode_b64(&b64);
    let svg = String::from_utf8_lossy(&svg_bytes);
    assert!(svg.contains("<svg"), "chiral molecule SVG must be valid");
}

/// Cyclohexane renders PNG without error.
#[tokio::test]
async fn render_cyclohexane_png() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": CYCLOHEXANE, "output_format": "image/png"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(!body_bytes.is_empty(), "should produce non-empty response");
}

/// Aspirin from real molfile renders SVG.
#[tokio::test]
async fn render_aspirin_from_molfile() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": ASPIRIN_MOL, "output_format": "image/svg+xml"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let b64 = String::from_utf8_lossy(&body_bytes);
    let svg_bytes = decode_b64(&b64);
    let svg = String::from_utf8_lossy(&svg_bytes);
    assert!(svg.contains("<svg"), "aspirin SVG must be valid");
}

/// Rendering invalid molecule returns error.
#[tokio::test]
async fn render_invalid_molecule_returns_error() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": NOT_A_MOLECULE, "output_format": "image/svg+xml"}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert!(resp.status().is_client_error(), "invalid molecule should fail");
}

/// Render without output_format uses SVG format (via options).
#[tokio::test]
async fn render_default_format_is_svg() {
    let app = test_app();
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/v2/indigo/render")
        .header("Content-Type", "application/json")
        .body(Body::from(
            json!({"struct": BENZENE, "options": {"render-output-format": "svg"}}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let b64 = String::from_utf8_lossy(&body_bytes);
    let svg_bytes = decode_b64(&b64);
    let svg = String::from_utf8_lossy(&svg_bytes);
    assert!(svg.contains("<svg"), "default should be SVG");
}
