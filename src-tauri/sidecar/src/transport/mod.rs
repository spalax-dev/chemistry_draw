//! Axum handlers grouped by domain.

pub mod health;
#[cfg(not(windows))]
pub mod imago;
pub mod indigo;
pub mod info;
