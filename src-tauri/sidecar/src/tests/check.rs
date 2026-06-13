// Tests para POST /v2/indigo/check — cada tipo de validación por separado.
//
// Ketcher envía estos tipos: valence, radicals, pseudoatoms, stereo, query,
// overlapping_atoms, overlapping_bonds, rgroups, chiral, 3d, chiral_flag.
//
// Cada test verifica que el tipo individual no crashea el sidecar (HTTP != 500)
// y que devuelve JSON válido (sea {} o [] o string).

use crate::tests::*;
use axum::http::StatusCode;
use serde_json::Value;

async fn check_type_does_not_crash(app: &Router, struct_smiles: &str, check_type: &str) {
    let (status, body) = post_json(
        app,
        "/v2/indigo/check",
        json!({"struct": struct_smiles, "types": [check_type]}),
    )
    .await;

    if status.is_server_error() {
        let err = body["error"].as_str().unwrap_or("no error field");
        panic!("check '{}' crashed with HTTP {}: {}", check_type, status, err);
    }
    if body.is_null() {
        panic!("check '{}' returned null (possible segfault)", check_type);
    }
}

// ─── Tests individuales: cada tipo que Ketcher envía ───────────

#[tokio::test]
async fn check_valence_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "valence").await;
}

#[tokio::test]
async fn check_radicals_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "radicals").await;
}

#[tokio::test]
async fn check_pseudoatoms_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "pseudoatoms").await;
}

#[tokio::test]
async fn check_stereo_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "stereo").await;
}

#[tokio::test]
async fn check_query_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "query").await;
}

#[tokio::test]
async fn check_overlapping_atoms_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "overlapping_atoms").await;
}

#[tokio::test]
async fn check_overlapping_bonds_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "overlapping_bonds").await;
}

#[tokio::test]
async fn check_rgroups_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "rgroups").await;
}

#[tokio::test]
async fn check_chiral_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "chiral").await;
}

#[tokio::test]
async fn check_3d_does_not_crash() {
    check_type_does_not_crash(&test_app(), BENZENE, "3d").await;
}

#[tokio::test]
async fn check_chiral_flag_does_not_crash() {
    // Nota: Ketcher puede enviar "chiral_flag" aunque no esté en nuestra lista default
    check_type_does_not_crash(&test_app(), BENZENE, "chiral_flag").await;
}

// ─── End-to-end: el batch exacto que Ketcher envía ─────────────

#[tokio::test]
async fn check_ketcher_full_batch_does_not_crash() {
    let app = test_app();
    let ketcher_types = [
        "radicals",
        "pseudoatoms",
        "stereo",
        "query",
        "overlapping_atoms",
        "overlapping_bonds",
        "rgroups",
        "chiral",
        "3d",
    ];

    let types_json: Vec<Value> = ketcher_types.iter().map(|t| Value::String(t.to_string())).collect();

    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": BENZENE, "types": types_json}),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "full Ketcher batch must not crash");
}

// ─── Casos con moléculas reales ─────────────────────────────────

/// Molécula con radical: metilo ·CH3.
/// Indigo correctamente reporta el radical.
#[tokio::test]
async fn check_radical_molecule() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": "[CH3]", "types": ["radicals"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // [CH3] tiene un electrón desapareado → Indigo debe reportar radical
    let s = body.to_string();
    assert!(
        s.contains("radical"),
        "CH3 should be reported as radical, got: {s}"
    );
}

/// Molécula con centro estereogénico
#[tokio::test]
async fn check_stereo_on_chiral_molecule() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": ALANINE, "types": ["stereo", "chiral"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// Molécula 3D (con coordenadas Z)
#[tokio::test]
async fn check_3d_molecule() {
    let app = test_app();
    // Molfile con coordenadas 3D
    let mol3d = "\n  -INDIGO-061326003D\n\n  3  2  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    1.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    2.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n  1  2  1  0  0  0  0\n  2  3  2  0  0  0  0\nM  END";
    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": mol3d, "types": ["3d"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// Verifica que una molécula con M END no tenga errores de rgroups.
#[tokio::test]
async fn check_rgroups_on_plain_molecule() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": BENZENE, "types": ["rgroups"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
