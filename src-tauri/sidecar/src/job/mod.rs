//! In-memory store for async Imago recognition jobs.
//!
//! Ketcher uses an upload-and-poll pattern:
//!
//! 1. `POST /v2/imago/uploads` → creates a job (Processing), returns upload_id.
//! 2. `GET /v2/imago/uploads/{id}` → polls until state becomes Success or Failure.

pub mod imago_store;
pub use imago_store::{ImagoJobStore, JobStatus};
