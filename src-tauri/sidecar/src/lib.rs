//! HTTP sidecar replacing Ketcher's WASM Indigo backend.
//!
//! Spawned by the Tauri app, this sidecar serves the Indigo REST v2 API
//! using native `libindigo.so` + `libimago.so` instead of the original
//! WASM build.
//!
//! # Architecture
//!
//! ```text
//! transport/     axum handlers, one module per domain
//! service/       business logic, orchestrates FFI
//! ffi/           extern "C" bindings to native libraries
//! job/           in-memory job store for async Imago jobs
//! error.rs       AppError → HTTP status code mapping
//! state.rs       shared app state (port, job store)
//! ```
//!
//! # Endpoints
//!
//! | Method | Path                            | Backend  |
//! |--------|----------------------------------|----------|
//! | GET    | `/v2/info`                      |          |
//! | POST   | `/v2/indigo/convert`            | Indigo   |
//! | POST   | `/v2/indigo/aromatize`          | Indigo   |
//! | POST   | `/v2/indigo/layout`             | Indigo   |
//! | POST   | `/v2/imago/uploads`             | Imago    |
//! | GET    | `/v2/imago/uploads/{id}`        |          |

pub mod error;
pub mod ffi;
pub mod job;
pub mod service;
pub mod state;
pub mod transport;

#[cfg(test)]
mod tests;

pub use job::ImagoJobStore;
pub use state::AppState;

/// Builds the full [`axum::Router`] with all routes.
pub fn build_router(state: AppState) -> axum::Router {
    use axum::{routing::get, routing::post, Router};

    let imago_routes = Router::new()
        .route("/", post(transport::imago::post_upload))
        .route("/:id", get(transport::imago::get_status));

    Router::new()
        .route("/v2/info", get(transport::info::get_info))
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
        .nest("/v2/imago/uploads", imago_routes)
        .with_state(state)
}
