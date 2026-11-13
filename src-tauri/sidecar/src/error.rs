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
/// | `Unprocessable` | 422 | Input understood, result cannot be produced (incomplete OCSR decode) |
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

    /// The input was understood but the requested result cannot be produced.
    ///
    /// Used when an OCSR decode reaches `max_len` without its end token: an
    /// unfinished structure is not a result. The body carries the actionable
    /// cause; this is a client-facing outcome, not an internal failure, so it is
    /// logged at `warn!` level.
    #[error("unprocessable: {0}")]
    Unprocessable(String),

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
    pub fn unprocessable(e: impl std::fmt::Display) -> Self {
        Self::Unprocessable(e.to_string())
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
            AppError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m.clone()),
            AppError::ServiceUnavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m.clone()),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        match &self {
            // An incomplete decode and a missing/corrupt model are expected,
            // actionable outcomes, not internal failures: WARN with the cause so
            // the log keeps the message the body reports.
            AppError::Unprocessable(_) | AppError::ServiceUnavailable(_) => {
                tracing::warn!("{self}")
            }
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
