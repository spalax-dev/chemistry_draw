//! Bindings to native chemical libraries.
//!
//! * [`indigo`] — EPAM Indigo + Indigo Renderer (load, save, render molecules).
//! * [`imago`] — EPAM Imago v2 (image-to-structure OCR). Windows builds use a
//!   stub so the sidecar compiles without Imago/OpenCV and reports no OCR
//!   backend to Ketcher.

pub mod indigo;

#[cfg(not(windows))]
pub mod imago;

#[cfg(windows)]
#[path = "imago_stub.rs"]
pub mod imago;
