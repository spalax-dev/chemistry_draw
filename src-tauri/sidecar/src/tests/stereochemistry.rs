// Tests para POST /v2/indigo/calculate_cip y /v2/indigo/automap
//
// calculate_cip: asigna descriptores CIP (Cahn-Ingold-Prelog) R/S a
//                centros estereogénicos.
// automap: asigna automáticamente el mapeo átomo-a-átomo en reacciones
//          químicas (para mostrar correspondencia reactivo→producto).
//
// Casos cubiertos:
//   - Molécula quiral: verificar que el marcador @ se preserva
//   - Non-chiral molecule: must not fail or introduce false markers
//   - Reacción simple: automap en benceno→ciclohexano

use crate::tests::*;
use axum::http::StatusCode;

/// L-alanine has a chiral center with S descriptor.
/// calculate_cip preserves (or assigns) the @ / @@ marking.
#[tokio::test]
async fn cip_preserves_chiral_marker() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate_cip",
        json!({"struct": ALANINE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(
        s.contains('@'),
        "chiral marker must be present after CIP, got: {s}"
    );
}

/// Benzene has no chiral centers. calculate_cip must not fail
/// or add non-existent @ markers.
#[tokio::test]
async fn cip_on_achiral_molecule_no_error() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate_cip",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(!s.contains('@'), "achiral molecule must not gain chiral markers");
}

/// calculate_cip also works with molfile output (not only SMILES).
#[tokio::test]
async fn cip_molfile_output() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate_cip",
        json!({"struct": ALANINE}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body["struct"].as_str().unwrap().contains("V2000"),
        "CIP molfile must contain V2000 header"
    );
}

/// Automaps a simple reaction: benzene → cyclohexane (hydrogenation).
/// The result must contain reactants and products with mapping.
#[tokio::test]
async fn automap_reaction_hydrogenation() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/automap",
        json!({"struct": REACTION, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        !body["struct"].as_str().unwrap().is_empty(),
        "automap should return mapped reaction"
    );
}

/// Automapea con salida rxnfile.
#[tokio::test]
async fn automap_reaction_rxnfile_output() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/automap",
        json!({"struct": REACTION, "output_format": "chemical/x-mdl-rxnfile"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let rxn = body["struct"].as_str().unwrap();
    assert!(
        rxn.contains("$RXN") || rxn.contains("V2000"),
        "automap rxnfile output must be valid, got: {rxn}"
    );
}
