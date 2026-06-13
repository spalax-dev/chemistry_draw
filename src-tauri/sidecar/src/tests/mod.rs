// Utilidades compartidas para los tests de integración del sidecar.
// Cada archivo en este directorio prueba un grupo de endpoints.

mod aromatize;
mod calculate;
mod check;
mod convert;
mod imago_integration;
mod info;
mod layout_clean;
mod render;
mod stereochemistry;

use axum::{
    body::Body,
    http::{self, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Once;
use tower::ServiceExt;

use crate::{build_router, AppState, ImagoJobStore};

static INIT: Once = Once::new();

fn init_tracing() {
    INIT.call_once(|| {
        tracing_subscriber::fmt()
            .with_test_writer()
            .with_max_level(tracing::Level::INFO)
            .init();
    });
}

/// Construye una app de test con todas las rutas, sin CORS.
pub fn test_app() -> axum::Router {
    init_tracing();
    let state = AppState {
        _port: 9321,
        imago_store: ImagoJobStore::new(),
    };
    build_router(state)
}

pub async fn post_json(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(http::Method::POST)
        .uri(path)
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = if body_bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body_bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

pub async fn fetch_get(app: &axum::Router, path: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(http::Method::GET)
        .uri(path)
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    (status, body)
}

// ── Moléculas de prueba ────────────────────────────────────────

pub const BENZENE: &str = "c1ccccc1";
pub const BENZENE_KEKULE: &str = "C1=CC=CC=C1";
pub const CYCLOHEXANE: &str = "C1CCCCC1";
pub const ETHANOL: &str = "CCO";
pub const ACETIC_ACID: &str = "CC(=O)O";
pub const ALANINE: &str = "C[C@H](N)C(=O)O"; // quiral, L-alanina
pub const NOT_A_MOLECULE: &str = "not a molecule at all";
pub const EMPTY: &str = "";
pub const REACTION: &str = "C1=CC=CC=C1>>C1CCCCC1";
