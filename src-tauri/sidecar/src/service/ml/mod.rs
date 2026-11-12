//! Machine-learning inference service.
//!
//! Phase B1 ships the ONNX Runtime foundation, the `runtime_default`
//! preprocessing and the structure classifier. This module keeps the pieces
//! that do not depend on HTTP:
//!
//! - [`preprocess`] turns decoded image bytes into the classifier tensor.
//! - [`registry`] verifies `manifest.json`, the artifact checksum and the
//!   tensor contract, then creates the CPU session.
//! - [`runtime`] owns the process-wide, dynamically loaded ONNX Runtime
//!   environment.
//! - [`classifier`] runs the validated session and applies the sigmoid and the
//!   manifest threshold.
//!
//! Models are never bundled: the root comes from `CHEMISTRY_MODELS_DIR` (debug
//! default: `<repo>/models`) and a missing or invalid model store is reported
//! as an unavailable service, never a panic. ONNX Runtime itself is loaded
//! dynamically from `ORT_DYLIB_PATH` (or the loader search path) and is not
//! linked or bundled in B1.

pub mod classifier;
pub mod preprocess;
pub mod registry;
pub mod runtime;
