// Tests para POST /v2/indigo/convert
//
// Convierte una estructura química entre formatos (SMILES, molfile, KET, etc.).
// Es el endpoint más usado por Ketcher para transformar estructuras.
//
// Casos cubiertos:
//   - Conversión SMILES → molfile (formato por defecto)
//   - Conversión SMILES → SMILES explícito
//   - Conversión molfile → SMILES
//   - Conversión de formatos químicos alternativos
//   - Roundtrip (ida y vuelta sin pérdida semántica)
//   - Manejo de entradas inválidas (HTTP 400)
//   - Manejo de string vacío

use crate::tests::*;
use axum::http::StatusCode;

/// Convierte benceno (SMILES aromático) al formato molfile por defecto.
/// El molfile debe contener el magic number "V2000".
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
/// El resultado debe ser el SMILES canónico aromático.
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
/// Verifica que el output_format se respeta al ser solicitado.
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
    // Indigo puede reordenar: CC(=O)O y CC(O)=O son la misma molécula
    let s = body["struct"].as_str().unwrap();
    assert_eq!(s.len(), 7, "acetic acid SMILES should be 7 chars, got: {s}");
}

/// L-alanina (quiral) debe preservar el marcador @ en la conversión.
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
/// El resultado debe ser idéntico al SMILES original.
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

/// String que no es una molécula válida debe devolver HTTP 400.
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

/// String vacío: Indigo puede aceptarlo o rechazarlo según el build.
/// Verificamos que al menos no crashee (panick).
#[tokio::test]
async fn empty_input_does_not_panic() {
    let app = test_app();
    let _ = post_json(&app, "/v2/indigo/convert", json!({"struct": EMPTY})).await;
    // No assert de status code — el comportamiento exacto depende del build.
    // Lo importante es que no haya panic.
}

/// Convierte a formato CML (Chemical Markup Language).
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

/// Convierte a formato KET/JSON.
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
