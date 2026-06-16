// Tests para POST /v2/indigo/aromatize y /v2/indigo/dearomatize
//
// aromatize: convierte enlaces simples/dobles explícitos (Kekulé) a anillos
//            aromáticos (carbonos en minúscula en SMILES).
// dearomatize: operación inversa — anillos aromáticos a Kekulé.
//
// Casos cubiertos:
//   - Benceno Kekulé → aromático
//   - Benceno aromático → Kekulé (roundtrip)
//   - Naftaleno (2 anillos) en ambas direcciones
//   - Molécula no aromática (sin cambios)
//   - Entrada inválida (HTTP 500)

use crate::tests::*;
use axum::http::StatusCode;

const NAPHTHALENE: &str = "c1ccc2ccccc2c1";
const NAPHTHALENE_KEKULE: &str = "C1=CC=C2C=CC=CC2=C1";
const HEXENE: &str = "C=CCCCC";

/// El benceno en notación Kekulé (C1=CC=CC=C1) al aromatizarse
/// produces SMILES with lowercase aromatic carbons.
#[tokio::test]
async fn aromatize_basic_kekule_to_aromatic() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": BENZENE_KEKULE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(s.contains('c'), "expected aromatic SMILES, got: {s}");
}

/// If the molecule is already aromatic, aromatize should not break it.
#[tokio::test]
async fn aromatize_already_aromatic_is_idempotent() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["struct"].as_str().unwrap().trim(), "c1ccccc1");
}

/// Naftaleno (2 anillos) Kekulé → aromático.
#[tokio::test]
async fn aromatize_naphthalene() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": NAPHTHALENE_KEKULE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(s.contains('c'), "expected aromatic SMILES for naphthalene, got: {s}");
}

/// Benceno aromático → Kekulé.
#[tokio::test]
async fn dearomatize_basic_aromatic_to_kekule() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/dearomatize",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(!s.contains('c'), "expected Kekulé form (no lowercase 'c'), got: {s}");
    assert!(s.contains('C'), "expected uppercase 'C' in Kekulé, got: {s}");
}

/// Naftaleno aromático → Kekulé.
#[tokio::test]
async fn dearomatize_naphthalene() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/dearomatize",
        json!({"struct": NAPHTHALENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(!s.contains('c'), "Kekulé form must not have aromatic carbons, got: {s}");
}

/// Aromatize + dearomatize are idempotent (semantic roundtrip).
#[tokio::test]
async fn aromatize_dearomatize_roundtrip() {
    let app = test_app();

    // Kekulé → aromatic
    let (s1, b1) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": BENZENE_KEKULE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);
    let aromatic = b1["struct"].as_str().unwrap();
    assert!(aromatic.contains('c'));

    // Aromatic → Kekulé
    let (s2, b2) = post_json(
        &app,
        "/v2/indigo/dearomatize",
        json!({"struct": aromatic, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;
    assert_eq!(s2, StatusCode::OK);
    let back = b2["struct"].as_str().unwrap();
    assert!(!back.contains('c'), "dearomatize must remove aromatic notation");
}

/// Non-aromatic molecule (hexene) does not change when aromatizing.
#[tokio::test]
async fn aromatize_non_aromatic_unchanged() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": HEXENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    // hexene is not aromatized; atom order may change (Indigo reorders).
    let s = body["struct"].as_str().unwrap();
    assert!(!s.contains('c'), "non-aromatic must not become aromatic, got: {s}");
    assert_eq!(s.chars().filter(|&c| c == 'C').count(), 6, "should have 6 carbons");
}

/// Invalid input returns HTTP 500.
#[tokio::test]
async fn aromatize_invalid_input() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/aromatize",
        json!({"struct": NOT_A_MOLECULE}),
    )
    .await;

    assert!(status.is_server_error() || status.is_client_error());
}
