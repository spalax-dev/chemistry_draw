//! Application error type.
//!
//! Each variant maps to a distinct HTTP status code via [`IntoResponse`].

use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde::Serialize;

/// Error propagated from service to transport.
///
/// | Variant | HTTP | Meaning |
/// |---------|------|---------|
/// | `BadRequest` | 400 | Invalid input (bad SMILES, undecodable image, etc.) |
/// | `NotFound` | 404 | Resource not found |
/// | `ServiceUnavailable` | 503 | Model missing, corrupt or contract mismatch |
/// | `Internal` | 500 | Native library error, I/O error, etc. |
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Invalid input from the client.
    #[error("bad request: {0}")]
    BadRequest(String),

    /// Requested resource does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// The inference model is not usable: missing, corrupt or incompatible.
    ///
    /// This is a configuration problem, not an internal failure, so it is not
    /// logged at `error!` level and keeps the actionable cause in the body.
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),

    /// Unexpected backend failure. Logged at `error!` level.
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn bad_request(e: impl std::fmt::Display) -> Self {
        Self::BadRequest(e.to_string())
    }
    pub fn service_unavailable(e: impl std::fmt::Display) -> Self {
        Self::ServiceUnavailable(e.to_string())
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::Internal(e.to_string())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match &self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            AppError::ServiceUnavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m.clone()),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        match &self {
            // A missing/corrupt model is an operator configuration problem, not
            // an internal failure: WARN with the actionable cause, so the log
            // names the manifest path and CHEMISTRY_MODELS_DIR like the body.
            AppError::ServiceUnavailable(_) => tracing::warn!("{self}"),
            AppError::Internal(_) => tracing::error!("{self}"),
            AppError::BadRequest(_) | AppError::NotFound(_) => {}
        }
        (status, Json(ErrorBody { error: msg })).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
