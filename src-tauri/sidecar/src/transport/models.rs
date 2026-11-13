//! Model delivery routes (B3): `GET /v2/models`, `POST /v2/models/download`,
//! `POST /v2/models/download/cancel` and `POST /v2/models/verify`.
//!
//! Handlers only resolve the active catalog, map downloader outcomes to HTTP
//! and serialize the service DTOs. `GET /v2/models` answers `200` even with no
//! model root, manifest or models; a broken `CHEMISTRY_MODEL_CATALOG` override
//! is the documented `500`. Downloads never block the handler: the worker runs
//! in the background and the client polls `GET /v2/models`.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};

use crate::error::AppError;
use crate::service::ml::download::{ModelsStatus, StartError, StartOutcome, VerifyReport};
use crate::state::AppState;

/// `GET /v2/models` — catalog and download status.
pub async fn get_models(State(state): State<AppState>) -> Result<Json<ModelsStatus>, AppError> {
    tracing::info!("GET /v2/models");
    let catalog = state.catalog().map_err(AppError::internal)?;
    Ok(Json(
        state.downloads().models_status(&state.models_dir, &catalog),
    ))
}

/// `POST /v2/models/download` — starts or resumes a run (`202`), or is a
/// no-op when the install is already current (`200`).
pub async fn post_download(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<ModelsStatus>), AppError> {
    tracing::info!("POST /v2/models/download");
    let catalog = state.catalog().map_err(AppError::internal)?;

    let outcome = state
        .downloads()
        .start(state.models_dir.clone(), Arc::clone(&catalog))
        .await
        .map_err(start_error)?;

    let status = state.downloads().models_status(&state.models_dir, &catalog);
    let code = match outcome {
        StartOutcome::Started => StatusCode::ACCEPTED,
        StartOutcome::Noop => StatusCode::OK,
    };
    Ok((code, Json(status)))
}

/// `POST /v2/models/download/cancel` — requests cancellation (`202`) or
/// conflicts when nothing is downloading (`409`).
pub async fn post_cancel(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<ModelsStatus>), AppError> {
    tracing::info!("POST /v2/models/download/cancel");
    let catalog = state.catalog().map_err(AppError::internal)?;

    state.downloads().cancel().map_err(start_error)?;

    Ok((
        StatusCode::ACCEPTED,
        Json(state.downloads().models_status(&state.models_dir, &catalog)),
    ))
}

/// `POST /v2/models/verify` — hashes the installed artifacts and returns the
/// report; a running download is a conflict (`409`).
pub async fn post_verify(State(state): State<AppState>) -> Result<Json<VerifyReport>, AppError> {
    tracing::info!("POST /v2/models/verify");
    let catalog = state.catalog().map_err(AppError::internal)?;

    if state.downloads().is_active() {
        return Err(AppError::conflict(
            "a model download is running; wait for it to finish or POST \
             /v2/models/download/cancel",
        ));
    }

    let report = state
        .downloads()
        .verify(&state.models_dir, &catalog)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(report))
}

fn start_error(error: StartError) -> AppError {
    match error {
        StartError::Conflict(message) => AppError::conflict(message),
        StartError::Other(error) => AppError::internal(error),
    }
}
