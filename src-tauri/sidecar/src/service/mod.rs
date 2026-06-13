//! Business logic layer.
//!
//! Each module orchestrates [`ffi`](crate::ffi) calls and maps errors to
//! [`AppError`](crate::error::AppError).

pub mod imago_ops;
pub mod indigo_ops;
pub mod types;
