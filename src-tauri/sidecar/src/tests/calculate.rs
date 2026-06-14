// Tests para POST /v2/indigo/calculate
//
// Calcula propiedades moleculares: peso molecular, fórmula bruta,
// masa monoisotópica, masa más abundante, composición másica.
//
// Casos cubiertos:
//   - Benceno: peso molecular y fórmula bruta con precisión
//   - Etanol: molécula pequeña con oxígeno
//   - Ácido acético: molécula con grupo carboxilo
//   - Alanina (quiral): no debe afectar el cálculo
//   - Múltiples propiedades en una sola llamada
//   - Propiedades desconocidas (ignoradas sin error)

use crate::tests::*;
use axum::http::StatusCode;

/// El peso molecular del benceno (C6H6) debe ser ~78.11 g/mol.
/// Verificamos con tolerancia de 0.01 para diferencias de redondeo.
#[tokio::test]
async fn benzene_molecular_weight() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["molecular-weight"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let mw: f64 = body["molecular-weight"].as_str().unwrap().parse().unwrap();
    assert!((mw - 78.114).abs() < 0.01, "benzene MW ~78.114, got {mw}");
}

/// La fórmula bruta del benceno debe ser C6 H6.
#[tokio::test]
async fn benzene_gross_formula() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["gross"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let gross = body["gross"].as_str().unwrap();
    assert!(
        gross.contains("C6") || gross.contains("C 6"),
        "expected C6, got: {gross}"
    );
    assert!(
        gross.contains("H6") || gross.contains("H 6"),
        "expected H6, got: {gross}"
    );
}

/// Etanol (C2H6O): MW ~46.07. Verifica moléculas con oxígeno.
#[tokio::test]
async fn ethanol_molecular_weight() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": ETHANOL, "properties": ["molecular-weight"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let mw: f64 = body["molecular-weight"].as_str().unwrap().parse().unwrap();
    assert!((mw - 46.069).abs() < 0.1, "ethanol MW ~46.07, got {mw}");
}

/// Ácido acético (C2H4O2): MW ~60.05. Verifica moléculas con
/// carbonilo e hidroxilo que podrían tener pesos atómicos distintos.
#[tokio::test]
async fn acetic_acid_molecular_weight() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": ACETIC_ACID, "properties": ["molecular-weight"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let mw: f64 = body["molecular-weight"].as_str().unwrap().parse().unwrap();
    assert!((mw - 60.052).abs() < 0.1, "acetic acid MW ~60.05, got {mw}");
}

/// La quiralidad no debe afectar el peso molecular.
/// Alanina debe tener el mismo MW con o sin @.
#[tokio::test]
async fn chiral_molecule_mw_unaffected() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": ALANINE, "properties": ["molecular-weight"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let mw: f64 = body["molecular-weight"].as_str().unwrap().parse().unwrap();
    // Alanina C3H7NO2: MW ~89.09
    assert!((mw - 89.094).abs() < 0.2, "alanine MW ~89.09, got {mw}");
}

/// Pide múltiples propiedades a la vez. El endpoint debe devolver
/// las que estén disponibles sin error.
#[tokio::test]
async fn multiple_properties_at_once() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["molecular-weight", "gross"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["molecular-weight"].is_string(), "MW should be present");
    assert!(body["gross"].is_string(), "gross should be present");
}

/// Pedir una propiedad no soportada no debe causar error.
/// Simplemente se ignora y no aparece en la respuesta.
#[tokio::test]
async fn unknown_property_ignored() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["this-does-not-exist"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(!body.as_object().unwrap().contains_key("this-does-not-exist"));
}

// ─── Nuevas propiedades ────────────────────────────────────────

/// Benceno: most-abundant-mass debe ser ~78.046 (C6H6).
#[tokio::test]
async fn benzene_most_abundant_mass() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["most-abundant-mass"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let m: f64 = body["most-abundant-mass"].as_str().unwrap().parse().unwrap();
    assert!((m - 78.046).abs() < 0.01, "benzene most-abundant-mass ~78.046, got {m}");
}

/// Benceno: monoisotopic-mass debe ser ~78.046.
#[tokio::test]
async fn benzene_monoisotopic_mass() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["monoisotopic-mass"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let m: f64 = body["monoisotopic-mass"].as_str().unwrap().parse().unwrap();
    assert!((m - 78.046).abs() < 0.01, "benzene monoisotopic-mass ~78.046, got {m}");
}

/// Benceno: mass-composition debe contener C y H con porcentajes.
#[tokio::test]
async fn benzene_mass_composition() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": BENZENE, "properties": ["mass-composition"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let s = body["mass-composition"].as_str().unwrap();
    assert!(s.contains('C'), "must contain carbon: {s}");
    assert!(s.contains('H'), "must contain hydrogen: {s}");
}

/// Todas las propiedades en una sola llamada.
#[tokio::test]
async fn all_properties_at_once() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": ETHANOL, "properties": [
            "molecular-weight", "gross", "most-abundant-mass",
            "monoisotopic-mass", "mass-composition"
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["molecular-weight"].is_string());
    assert!(body["gross"].is_string());
    assert!(body["most-abundant-mass"].is_string());
    assert!(body["monoisotopic-mass"].is_string());
    assert!(body["mass-composition"].is_string());
}

/// Calcular propiedades desde aspirina (SMILES).
/// La aspirina tiene 9 C, 8 H, 4 O.
#[tokio::test]
async fn calculate_aspirin_smiles() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": "CC(=O)Oc1ccccc1C(=O)O", "properties": [
            "molecular-weight", "gross"
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mw: f64 = body["molecular-weight"].as_str().unwrap().parse().unwrap();
    assert!((mw - 180.16).abs() < 0.2, "aspirin MW ~180.16, got {mw}");
    let gross = body["gross"].as_str().unwrap();
    assert!(gross.contains("C9"), "aspirin C9H8O4: {gross}");
    assert!(gross.contains('O'), "aspirin C9H8O4: {gross}");
}
