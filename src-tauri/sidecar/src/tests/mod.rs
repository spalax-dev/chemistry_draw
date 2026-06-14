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
mod structural_errors;

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

// ── Molfiles reales ────────────────────────────────────────────

/// Aspirina (ácido acetilsalicílico) en V2000
pub const ASPIRIN_MOL: &str = "\n  -INDIGO-06132615352D\n\n 21 21  0  0  1  0  0  0  0  0999 V2000\n   -0.4230   -1.2970    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.4230   -1.2970    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.8460   -0.4880    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.4230    0.3210    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.4230    0.3210    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.8460   -0.4880    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.8460    1.2380    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    1.8120    1.2380    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n    0.4230    2.1560    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.4230    2.1560    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    1.8120   -0.4880    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n    1.8120    0.3210    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.8460    1.2380    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.4230   -1.9620    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n    0.8460   -1.9620    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n   -1.8120   -0.4880    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n   -1.8120    1.2380    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n   -0.8460    2.8210    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n    0.8460    2.8210    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n    2.3120   -1.2480    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n    2.4780    0.3210    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n  1  2  2  0  0  0  0\n  2  3  1  0  0  0  0\n  3  4  2  0  0  0  0\n  4  5  1  0  0  0  0\n  5  6  2  0  0  0  0\n  1  6  1  0  0  0  0\n  4  7  1  0  0  0  0\n  7  8  2  0  0  0  0\n  7  9  1  0  0  0  0\n  9 10  1  0  0  0  0\n 10 13  1  0  0  0  0\n  3 11  1  0  0  0  0\n 11 12  2  0  0  0  0\n  1 14  1  0  0  0  0\n  2 15  1  0  0  0  0\n  6 16  1  0  0  0  0\n 13 17  1  0  0  0  0\n 10 18  1  0  0  0  0\n  9 19  1  0  0  0  0\n 11 20  1  0  0  0  0\n 12 21  1  0  0  0  0\nM  END\n";

/// Cafeína en V2000
pub const CAFFEINE_MOL: &str = "\n  -INDIGO-06132617352D\n\n 14 15  0  0  1  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.0000    1.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0\n    1.0000    1.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    2.0000    1.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0\n    2.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    1.0000   -0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    0.0000    2.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -1.0000    1.5000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0\n    3.0000    1.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    3.0000   -0.5000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n    1.0000   -1.5000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n   -1.0000    2.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -1.0000    0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n   -2.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n  1  2  1  0  0  0  0\n  2  3  1  0  0  0  0\n  3  4  2  0  0  0  0\n  4  5  1  0  0  0  0\n  5  6  2  0  0  0  0\n  1  6  1  0  0  0  0\n  2  7  1  0  0  0  0\n  7  8  1  0  0  0  0\n  8 13  2  0  0  0  0\n 13  1  1  0  0  0  0\n  3  9  1  0  0  0  0\n  5 10  2  0  0  0  0\n  6 11  1  0  0  0  0\n  8 12  1  0  0  0  0\n 13 14  1  0  0  0  0\nM  END\n";

// ── Estructuras inválidas ──────────────────────────────────────

/// Molfile con enlace duplicado entre átomos 1 y 2
pub const DUPLICATE_BOND_MOL: &str = "\n  test\n\n  3  3  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    1.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n    2.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n  1  2  1  0     0  0\n  1  2  1  0     0  0\n  2  3  1  0     0  0\nM  END\n";

/// Molfile con header corrupto (no es V2000/V3000)
pub const CORRUPTED_HEADER_MOL: &str = "\n  test\n\n  garbage\n    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n  1  1  1  0     0  0\nM  END\n";

/// SMILES con anillo sin cerrar (inválido)
pub const INVALID_SMILES: &str = "C1CC";
