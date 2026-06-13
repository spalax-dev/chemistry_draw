//! Entry point. Reads `INDIGO_PORT` (default 9321), starts axum with CORS.

use std::net::SocketAddr;

use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use indigo_server::{build_router, AppState, ImagoJobStore};

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

    let app = build_router(state).layer(cors);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("indigo-server listening on http://{addr}");

    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}
