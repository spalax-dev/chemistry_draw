// Tests para POST /v2/indigo/layout y /v2/indigo/clean
//
// layout: recalcula las coordenadas 2D de la estructura para
//         mejorar la disposición visual de átomos y enlaces.
// clean: limpia la estructura generando coordenadas 2D estándar
//        (útil para estructuras dibujadas a mano o importadas).
//
// Casos cubiertos:
//   - Benceno: layout no debe alterar la identidad química
//   - Ciclohexano: clean reorganiza pero preserva fórmula
//   - Etanol (acíclico): layout y clean funcionan en cadenas abiertas

use crate::tests::*;
use axum::http::StatusCode;

/// Layout en benceno no debe cambiar la conectividad.
/// El SMILES resultante debe seguir representando benceno.
#[tokio::test]
async fn layout_preserves_benzene() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["struct"].as_str().unwrap().trim(), "c1ccccc1");
}

/// Layout en ciclohexano debe preservar la estructura.
#[tokio::test]
async fn layout_preserves_cyclohexane() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": CYCLOHEXANE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body["struct"].as_str().unwrap().contains("C1CCCCC1"),
        "cyclohexane should be preserved"
    );
}

/// Layout en etanol (molécula acíclica) no debe romper la estructura.
#[tokio::test]
async fn layout_preserves_ethanol() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": ETHANOL, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["struct"].as_str().unwrap().trim(), "CCO");
}

/// Clean en ciclohexano produce una estructura con 6 átomos de carbono.
#[tokio::test]
async fn clean_cyclohexane() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/clean",
        json!({"struct": CYCLOHEXANE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body["struct"].as_str().unwrap().contains("C1CCCCC1"),
        "clean must preserve cyclohexane"
    );
}

/// Clean en benceno debe seguir produciendo benceno.
#[tokio::test]
async fn clean_benzene() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/clean",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["struct"].as_str().unwrap().trim(), "c1ccccc1");
}

/// Layout + clean en secuencia no deben degradar la estructura.
#[tokio::test]
async fn layout_then_clean_roundtrip() {
    let app = test_app();

    // Layout
    let (s1, b1) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);

    // Clean sobre el resultado del layout
    let (s2, b2) = post_json(
        &app,
        "/v2/indigo/clean",
        json!({"struct": b1["struct"].as_str().unwrap(), "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b2["struct"].as_str().unwrap().trim(), "c1ccccc1");
}
