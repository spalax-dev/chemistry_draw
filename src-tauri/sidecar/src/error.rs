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
/// | `BadRequest` | 400 | Invalid input (bad SMILES, etc.) |
/// | `NotFound` | 404 | Resource not found (unknown upload_id) |
/// | `Internal` | 500 | Native library error, I/O error, etc. |
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Invalid input from the client.
    #[error("bad request: {0}")]
    BadRequest(String),

    /// Requested resource does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// Unexpected backend failure. Logged at `error!` level.
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn bad_request(e: impl std::fmt::Display) -> Self {
        Self::BadRequest(e.to_string())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
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
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        if matches!(self, AppError::Internal(_)) {
            tracing::error!("{self}");
        }
        (status, Json(ErrorBody { error: msg })).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
