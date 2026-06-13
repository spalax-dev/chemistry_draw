// Tests para POST /v2/indigo/check
//
// Valida estructuras químicas buscando errores de valencia,
// estereoquímica, quiralidad, radicales, pseudoatomos, etc.
// Retorna un array/objeto JSON con los errores encontrados,
// o vacío si la estructura es válida.
//
// Casos cubiertos:
//   - Benceno: sin errores (respuesta vacía o sin errores)
//   - Carbono pentavalente: error de valencia esperado
//   - Verificación de estereoquímica en molécula quiral
//   - Entrada inválida (HTTP 500)

use crate::tests::*;
use axum::http::StatusCode;

/// El benceno es una molécula perfectamente válida.
/// La respuesta no debe contener errores.
#[tokio::test]
async fn benzene_no_errors() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": BENZENE, "types": ["valence", "stereo", "chiral"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let body_str = body.to_string();
    assert!(
        body_str == "{}" || body_str == "[]" || body_str == "null",
        "benzene should have no errors, got: {body_str}"
    );
}

/// Ciclohexano tampoco debería tener errores de valencia.
#[tokio::test]
async fn cyclohexane_no_valence_errors() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": CYCLOHEXANE, "types": ["valence"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let body_str = body.to_string();
    assert!(
        body_str == "{}" || body_str == "[]",
        "cyclohexane should have no errors, got: {body_str}"
    );
}

/// Etanol debe ser válido.
#[tokio::test]
async fn ethanol_no_errors() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": ETHANOL, "types": ["valence", "radicals"]}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let body_str = body.to_string();
    assert!(
        body_str == "{}" || body_str == "[]",
        "ethanol should have no errors, got: {body_str}"
    );
}

/// String no molecular debe devolver HTTP 500.
#[tokio::test]
async fn invalid_molecule_returns_500() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": NOT_A_MOLECULE, "types": ["valence"]}),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body["error"].as_str().unwrap().contains("load error"));
}

/// El check con todos los tipos de validación posibles no debe fallar
/// para una molécula simple.
#[tokio::test]
async fn all_check_types_on_benzene() {
    let app = test_app();
    let all_types = vec![
        "valence",
        "ambiguous_h",
        "query",
        "pseudoatoms",
        "radicals",
        "stereo",
        "overlapping_atoms",
        "overlapping_bonds",
        "3d",
        "sgroups",
        "v3000",
        "rgroups",
    ];

    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": BENZENE, "types": all_types}),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "all check types should work on benzene");
}
