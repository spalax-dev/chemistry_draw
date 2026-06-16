// Tests para POST /v2/indigo/convert
//
// Converts a chemical structure between formats (SMILES, molfile, KET, etc.).
// It is the most used endpoint by Ketcher to transform structures.
//
// Casos cubiertos:
//   - SMILES → molfile conversion (default format)
//   - Conversión SMILES → SMILES explícito
//   - Conversión molfile → SMILES
//   - Alternative chemical format conversion
//   - Roundtrip (ida y vuelta sin pérdida semántica)
//   - Invalid input handling (HTTP 400)
//   - Empty string handling

use crate::tests::*;
use axum::http::StatusCode;

/// Converts benzene (aromatic SMILES) to default molfile format.
/// The molfile must contain the magic number "V2000".
#[tokio::test]
async fn smiles_to_default_molfile() {
    let app = test_app();
    let (status, body) =
        post_json(&app, "/v2/indigo/convert", json!({"struct": BENZENE})).await;

    assert_eq!(status, StatusCode::OK);
    let mol = body["struct"].as_str().unwrap();
    assert!(mol.contains("V2000"), "molfile must contain V2000 header, got: {mol}");
    assert!(mol.contains("INDIGO"), "molfile should have Indigo header");
}

/// Convierte benceno explicitamente a SMILES diurno.
/// The result must be the canonical aromatic SMILES.
#[tokio::test]
async fn smiles_to_smiles_explicit() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": BENZENE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["struct"].as_str().unwrap().trim(),
        "c1ccccc1",
        "benzene aromatic SMILES"
    );
    assert_eq!(
        body["format"].as_str().unwrap(),
        "chemical/x-daylight-smiles"
    );
}

/// Convierte ciclohexano (Kekulé) a aromatic.
/// Verifies that output_format is respected when requested.
#[tokio::test]
async fn cyclohexane_to_smiles() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": CYCLOHEXANE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(
        body["struct"].as_str().unwrap().contains("C1CCCCC1"),
        "cyclohexane should stay as cyclohexane"
    );
}

/// Convierte etanol (molécula pequeña) a SMILES.
#[tokio::test]
async fn ethanol_smiles() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": ETHANOL, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["struct"].as_str().unwrap().trim(), "CCO");
}

/// Convierte ácido acético a SMILES.
#[tokio::test]
async fn acetic_acid_smiles() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": ACETIC_ACID, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    // Indigo may reorder: CC(=O)O and CC(O)=O are the same molecule
    let s = body["struct"].as_str().unwrap();
    assert_eq!(s.len(), 7, "acetic acid SMILES should be 7 chars, got: {s}");
}

/// L-alanine (chiral) preserves the @ marker during conversion.
#[tokio::test]
async fn chiral_alanine_preserves_stereo() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": ALANINE, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let smiles = body["struct"].as_str().unwrap();
    assert!(
        smiles.contains('@'),
        "chiral center must be preserved, got: {smiles}"
    );
}

/// Convierte benceno a molfile y ese molfile de vuelta a SMILES.
/// The result is identical to the original SMILES.
#[tokio::test]
async fn roundtrip_smiles_molfile_smiles() {
    let app = test_app();

    // SMILES → molfile
    let (s1, b1) =
        post_json(&app, "/v2/indigo/convert", json!({"struct": BENZENE})).await;
    assert_eq!(s1, StatusCode::OK);
    let molfile = b1["struct"].as_str().unwrap();

    // molfile → SMILES
    let (s2, b2) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": molfile, "output_format": "chemical/x-daylight-smiles"}),
    )
    .await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(
        b2["struct"].as_str().unwrap().trim(),
        "c1ccccc1",
        "roundtrip must preserve identity"
    );
}

/// String that is not a valid molecule returns HTTP 400.
#[tokio::test]
async fn invalid_input_returns_400() {
    let app = test_app();
    let (status, body) =
        post_json(&app, "/v2/indigo/convert", json!({"struct": NOT_A_MOLECULE})).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"].as_str().unwrap().contains("load error"),
        "error should mention load failure"
    );
}

/// Empty string: Indigo may accept or reject depending on the build.
/// Verificamos que al menos no crashee (panick).
#[tokio::test]
async fn empty_input_does_not_panic() {
    let app = test_app();
    let _ = post_json(&app, "/v2/indigo/convert", json!({"struct": EMPTY})).await;
    // No assert de status code — el comportamiento exacto depende del build.
    // Lo importante es que no haya panic.
}

/// Converts to CML format (Chemical Markup Language).
#[tokio::test]
async fn convert_to_cml() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": BENZENE, "output_format": "chemical/x-cml"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(s.contains("<molecule") || s.contains("<cml"), "expected CML, got: {s}");
}

/// Converts to KET/JSON format.
#[tokio::test]
async fn convert_to_ket_json() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": BENZENE, "output_format": "chemical/x-indigo-ket"}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let s = body["struct"].as_str().unwrap();
    assert!(s.contains("root"), "KET JSON must have 'root', got: {s}");
    assert!(serde_json::from_str::<Value>(s).is_ok(), "must be valid JSON");
}
