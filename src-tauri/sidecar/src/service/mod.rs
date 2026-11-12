//! Business logic layer.
//!
//! Each module orchestrates [`ffi`](crate::ffi) calls and maps errors to
//! [`AppError`](crate::error::AppError).

pub mod indigo_ops;
pub mod ml;
pub mod types;
