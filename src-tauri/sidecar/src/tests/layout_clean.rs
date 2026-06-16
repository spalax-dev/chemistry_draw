// Tests para POST /v2/indigo/layout y /v2/indigo/clean
//
// layout: recalcula las coordenadas 2D de la estructura para
//         mejorar la disposición visual de átomos y enlaces.
// clean: limpia la estructura generando coordenadas 2D estándar
//        (útil para estructuras dibujadas a mano o importadas).
//
// Casos cubiertos:
//   - Benzene: layout does not alter chemical identity
//   - Ciclohexano: clean reorganiza pero preserva fórmula
//   - Ethanol (acyclic): layout and clean work on open chains

use crate::tests::*;
use axum::http::StatusCode;

/// Layout on benzene does not change connectivity.
/// The resulting SMILES still represents benzene.
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

/// Cyclohexane layout preserves the structure.
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

/// Layout on ethanol (acyclic molecule) does not break the structure.
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

/// Clean on benzene still produces benzene.
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

/// Layout + clean in sequence do not degrade the structure.
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
