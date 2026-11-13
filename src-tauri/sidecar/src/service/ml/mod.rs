//! Machine-learning inference service.
//!
//! Phase B1 ships the ONNX Runtime foundation, the `runtime_default`
//! preprocessing and the structure classifier. Phase B2 adds the `decimer_ocsr`
//! pipeline and OCSR inference. This module keeps the pieces that do not depend
//! on HTTP:
//!
//! - [`preprocess`] turns decoded image bytes into the classifier tensor.
//! - [`ocsr_preprocess`] turns decoded image bytes into the normalized OCSR
//!   tensor.
//! - [`ocsr_vocab`] loads `vocab.json` and detokenizes ids with the digit remap.
//! - [`ocsr_decode`] runs the greedy encoder/decoder loop over abstract graphs.
//! - [`ocsr`] owns the OCSR sessions and runs the validated pair.
//! - [`registry`] verifies `manifest.json`, the artifact checksums and the
//!   tensor contracts, then creates the CPU sessions.
//! - [`runtime`] owns the process-wide, dynamically loaded ONNX Runtime
//!   environment.
//! - [`classifier`] runs the validated session and applies the sigmoid and the
//!   manifest threshold.
//! - [`paths`] resolves the model root (explicit value, repo candidate, cwd).
//!
//! Models are never bundled: the root is the first match of
//! `CHEMISTRY_MODELS_DIR`, an existing `<repo>/models` (the debug host injects
//! it as an absolute path) and `models` in the working directory. A missing or
//! invalid model store is reported as an unavailable service, never a panic.
//! ONNX Runtime itself is never linked: it is loaded dynamically from
//! `ORT_DYLIB_PATH` (or the loader search path). Activity 7 ships the pinned
//! 1.31.0 library next to the Indigo native libs and the host points
//! `ORT_DYLIB_PATH` at that copy.

pub mod classifier;
pub mod ocsr;
pub mod ocsr_decode;
pub mod ocsr_preprocess;
pub mod ocsr_vocab;
pub mod paths;
pub mod preprocess;
pub mod registry;
pub mod runtime;
