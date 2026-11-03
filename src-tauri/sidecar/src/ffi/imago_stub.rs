//! Windows stub for the Imago bindings.
//!
//! Windows builds ship native Indigo only: Imago and its OpenCV dependency are
//! not packaged. This module mirrors the public API of the real bindings so
//! callers compile unchanged, but recognition fails with an actionable error
//! and [`versions`] stays empty so Ketcher disables image recognition.

fn unavailable() -> anyhow::Error {
    anyhow::anyhow!("Imago image recognition is not available in the Windows build")
}

/// Returns the Imago version identifiers reported to Ketcher.
///
/// Always empty on Windows: Ketcher disables "Recognize Molecule" when the
/// `imago_versions` array has no entries.
pub fn versions() -> Vec<String> {
    Vec::new()
}

/// No-op: there is no Imago session to attach on Windows.
pub fn init_with_indigo_session(_indigo_sid: u64) {}

/// Fails: loading an image requires Imago/OpenCV, which Windows omits.
pub fn load_image_from_file(_path: &str) -> anyhow::Result<()> {
    Err(unavailable())
}

/// Fails: image filtering requires Imago/OpenCV, which Windows omits.
pub fn filter_image() -> anyhow::Result<()> {
    Err(unavailable())
}

/// Fails: OCR configuration requires Imago, which Windows omits.
pub fn set_config(_config: Option<&str>) -> anyhow::Result<()> {
    Err(unavailable())
}

/// Fails: OCR requires Imago, which Windows omits.
pub fn recognize() -> anyhow::Result<String> {
    Err(unavailable())
}
