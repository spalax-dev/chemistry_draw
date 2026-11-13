//! HTTP sidecar replacing Ketcher's WASM Indigo backend.
//!
//! Spawned by the Tauri app, this sidecar serves the Indigo REST v2 API using
//! native Indigo on every platform. Phase B1 adds an ONNX Runtime image
//! classifier that gates non-structure images; Phase B2 adds OCSR inference
//! (image to SMILES) through the encoder/decoder pair.
//!
//! # Architecture
//!
//! ```text
//! transport/     axum handlers, one module per domain
//! service/       business logic, orchestrates FFI and ML inference
//! service/ml/    ONNX runtime, model registry, preprocessing, classifier, OCSR
//! ffi/           extern "C" bindings to native libraries
//! error.rs       AppError → HTTP status code mapping
//! state.rs       shared app state (port)
//! ```
//!
//! # Endpoints
//!
//! | Method | Path                            | Backend                |
//! |--------|----------------------------------|------------------------|
//! | GET    | `/v2/info`                      |                        |
//! | GET    | `/v2/health`                    |                        |
//! | POST   | `/v2/indigo/convert`            | Indigo                 |
//! | POST   | `/v2/indigo/aromatize`          | Indigo                 |
//! | POST   | `/v2/indigo/layout`             | Indigo                 |
//! | POST   | `/v2/filter/classify`           | ONNX Runtime classifier|
//! | POST   | `/v2/ocsr/recognize`            | ONNX Runtime OCSR      |
//! | POST   | `/v2/imago/uploads`             | compatibility shim     |
//! | GET    | `/v2/imago/uploads/{id}`        | recognition job store  |

pub mod error;
pub mod ffi;
pub mod service;
pub mod state;
pub mod transport;

#[cfg(test)]
mod tests;

pub use state::AppState;

/// Builds the full [`axum::Router`] with all routes.
pub fn build_router(state: AppState) -> axum::Router {
    use axum::{extract::DefaultBodyLimit, routing::get, routing::post, Router};

    Router::new()
        .route("/v2/info", get(transport::info::get_info))
        .route("/v2/health", get(transport::health::get_health))
        .route("/v2/indigo/info", get(transport::indigo::get_indigo_info))
        .route("/v2/indigo/convert", post(transport::indigo::post_convert))
        .route(
            "/v2/indigo/aromatize",
            post(transport::indigo::post_aromatize),
        )
        .route(
            "/v2/indigo/dearomatize",
            post(transport::indigo::post_dearomatize),
        )
        .route("/v2/indigo/layout", post(transport::indigo::post_layout))
        .route("/v2/indigo/clean", post(transport::indigo::post_clean))
        .route("/v2/indigo/render", post(transport::indigo::post_render))
        .route(
            "/v2/indigo/calculate",
            post(transport::indigo::post_calculate),
        )
        .route("/v2/indigo/check", post(transport::indigo::post_check))
        .route(
            "/v2/indigo/calculate_cip",
            post(transport::indigo::post_calculate_cip),
        )
        .route("/v2/indigo/automap", post(transport::indigo::post_automap))
        .route("/v2/filter/classify", transport::filter::route())
        .route("/v2/ocsr/recognize", transport::ocsr::route())
        .route(
            "/v2/imago/uploads",
            post(transport::imago::post_upload)
                .layer(DefaultBodyLimit::max(transport::filter::MAX_BODY_BYTES)),
        )
        .route("/v2/imago/uploads/:id", get(transport::imago::get_upload))
        .with_state(state)
}
