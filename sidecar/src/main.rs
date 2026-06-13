mod handlers;
mod imago;
mod imago_jobs;
mod indigo;
mod models;

#[cfg(test)]
mod tests;

use axum::{routing::get, Router};
use handlers::AppState;
use imago_jobs::ImagoJobStore;
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_thread_ids(false)
        .with_line_number(true)
        .compact()
        .init();

    let port: u16 = std::env::var("INDIGO_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9321);

    let state = AppState {
        _port: port,
        imago_store: ImagoJobStore::new(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Sub-router para /v2/imago/uploads: POST / y GET /{id}
    let imago_routes = Router::new()
        .route("/", axum::routing::post(handlers::post_imago_upload))
        .route("/:id", get(handlers::get_imago_status));

    let app = Router::new()
        .route("/v2/info", get(handlers::get_info))
        .route("/v2/indigo/info", get(handlers::get_info))
        .route(
            "/v2/indigo/convert",
            axum::routing::post(handlers::post_convert),
        )
        .route(
            "/v2/indigo/aromatize",
            axum::routing::post(handlers::post_aromatize),
        )
        .route(
            "/v2/indigo/dearomatize",
            axum::routing::post(handlers::post_dearomatize),
        )
        .route(
            "/v2/indigo/layout",
            axum::routing::post(handlers::post_layout),
        )
        .route(
            "/v2/indigo/clean",
            axum::routing::post(handlers::post_clean),
        )
        .route(
            "/v2/indigo/render",
            axum::routing::post(handlers::post_render),
        )
        .route(
            "/v2/indigo/calculate",
            axum::routing::post(handlers::post_calculate),
        )
        .route(
            "/v2/indigo/check",
            axum::routing::post(handlers::post_check),
        )
        .route(
            "/v2/indigo/calculate_cip",
            axum::routing::post(handlers::post_calculate_cip),
        )
        .route(
            "/v2/indigo/automap",
            axum::routing::post(handlers::post_automap),
        )
        .nest("/v2/imago/uploads", imago_routes)
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("indigo-server listening on http://{}", addr);

    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}
