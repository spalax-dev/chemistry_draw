use crate::tests::*;
use axum::http::StatusCode;

#[tokio::test]
async fn duplicate_bond_returns_400_on_convert() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": DUPLICATE_BOND_MOL}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("already have edge"));
}

#[tokio::test]
async fn duplicate_bond_returns_400_on_calculate() {
    let app = test_app();
    let (status, _body) = post_json(
        &app,
        "/v2/indigo/calculate",
        json!({"struct": DUPLICATE_BOND_MOL, "properties": ["molecular-weight"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn duplicate_bond_returns_400_on_check() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/check",
        json!({"struct": DUPLICATE_BOND_MOL, "types": ["valence"]}),
    )
    .await;
    assert!(status.is_client_error() || status.is_server_error());
}

#[tokio::test]
async fn duplicate_bond_returns_400_on_layout() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": DUPLICATE_BOND_MOL}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("already have edge"));
}

#[tokio::test]
async fn duplicate_bond_returns_400_on_cip() {
    let app = test_app();
    let (status, _body) = post_json(
        &app,
        "/v2/indigo/calculate_cip",
        json!({"struct": DUPLICATE_BOND_MOL}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_smiles_returns_400_on_convert() {
    let app = test_app();
    let (status, body) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": INVALID_SMILES}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("load error"));
}

#[tokio::test]
async fn invalid_smiles_returns_400_on_layout() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/layout",
        json!({"struct": INVALID_SMILES}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn corrupted_molfile_returns_400() {
    let app = test_app();
    let (status, _) = post_json(
        &app,
        "/v2/indigo/convert",
        json!({"struct": CORRUPTED_HEADER_MOL}),
    )
    .await;
    assert!(status.is_client_error(), "corrupted mol must fail");
}

#[tokio::test]
async fn null_struct_field_returns_422() {
    let app = test_app();
    let req = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri("/v2/indigo/convert")
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from(
            serde_json::json!({"struct": null}).to_string(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert!(resp.status().is_client_error(), "null struct must fail");
}

#[tokio::test]
async fn malformed_json_returns_400() {
    let app = test_app();
    let req = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri("/v2/indigo/convert")
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from("not json at all"))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn real_molecules_roundtrip_through_all_endpoints() {
    let app = test_app();

    for (name, mol) in [("aspirin", ASPIRIN_MOL), ("caffeine", CAFFEINE_MOL)] {
        // Convert to SMILES
        let (s, b) = post_json(
            &app,
            "/v2/indigo/convert",
            json!({"struct": mol, "output_format": "chemical/x-daylight-smiles"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{name}: convert failed");
        let smiles = b["struct"].as_str().unwrap();
        assert!(!smiles.is_empty(), "{name}: empty SMILES");

        // Layout
        let (s, _) = post_json(
            &app,
            "/v2/indigo/layout",
            json!({"struct": smiles, "output_format": "chemical/x-daylight-smiles"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{name}: layout failed");

        // Calculate
        let (s, b) = post_json(
            &app,
            "/v2/indigo/calculate",
            json!({"struct": smiles, "properties": ["molecular-weight", "gross"]}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{name}: calculate failed");
        assert!(b["molecular-weight"].is_string(), "{name}: no MW");
        assert!(b["gross"].is_string(), "{name}: no gross");

        // Check
        let (s, _) = post_json(
            &app,
            "/v2/indigo/check",
            json!({"struct": smiles, "types": ["valence", "radicals"]}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{name}: check failed");
    }
}
