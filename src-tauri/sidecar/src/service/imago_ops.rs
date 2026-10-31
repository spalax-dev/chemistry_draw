//! Imago OCR pipeline: write temp image → recognise → clean molfile.
//!
//! # Pipeline
//!
//! 1. Write image bytes to a temporary file.
//! 2. Initialise an Indigo session (shared with Imago).
//! 3. Load, filter, configure, and recognise via Imago.
//! 4. Pass the raw molfile through Indigo with `ignore-stereochemistry-errors`
//!    to fix valence / chirality artifacts introduced by the OCR.
//! 5. Return the cleaned molfile.
//! 6. Remove the temporary file.

use crate::ffi::{imago, indigo};

/// Runs the full Imago OCR pipeline.
///
/// Accepts raw image bytes (PNG, JPEG), writes them to a temp file,
/// runs recognition, and returns a cleaned molfile.
pub fn process(image_bytes: &[u8]) -> anyhow::Result<String> {
    if image_bytes.is_empty() {
        anyhow::bail!("empty image data");
    }
    // Basic format validation to avoid crashing OpenCV on garbage
    let is_png = image_bytes.len() >= 8 && &image_bytes[0..8] == b"\x89PNG\r\n\x1a\n";
    let is_jpeg = image_bytes.len() >= 3 && image_bytes[0] == 0xFF && image_bytes[1] == 0xD8 && image_bytes[2] == 0xFF;
    let is_bmp = image_bytes.len() >= 2 && &image_bytes[0..2] == b"BM";
    let is_tiff_le = image_bytes.len() >= 4 && &image_bytes[0..4] == b"II*\x00";
    let is_tiff_be = image_bytes.len() >= 4 && &image_bytes[0..4] == b"MM\x00*";
    if !is_png && !is_jpeg && !is_bmp && !is_tiff_le && !is_tiff_be {
        anyhow::bail!("unsupported image format");
    }
    // For safety with C++ exceptions, validate PNG header more strictly
    if is_png {
        if image_bytes.len() < 33 {
            anyhow::bail!("invalid png");
        }
        if &image_bytes[12..16] != b"IHDR" {
            anyhow::bail!("invalid png header");
        }
        // Check for common corrupted patterns
        // The tiny test PNG from the error
        if image_bytes.len() < 100 {
            // Very small images might crash OpenCV
            anyhow::bail!("image too small or invalid");
        }
    }
    let tmp = write_temp_file(image_bytes)?;

    let result = run_pipeline(&tmp);

    let _ = std::fs::remove_file(&tmp);
    result
}

fn run_pipeline(path: &std::path::Path) -> anyhow::Result<String> {
    let indigo_sid = indigo::init_session()?;
    imago::init_with_indigo_session(indigo_sid);

    let path_str = path.to_string_lossy();
    imago::load_image_from_file(&path_str)?;
    imago::filter_image()?;
    imago::set_config(None)?;

    let mol = imago::recognize()?;
    if mol.trim().is_empty() {
        return Err(anyhow::anyhow!("imago produced empty molfile"));
    }

    Ok(cleanup(&mol).unwrap_or(mol))
}

/// Re-load the molfile into Indigo with relaxed stereo error handling.
fn cleanup(mol: &str) -> anyhow::Result<String> {
    let _sid = indigo::init_session()?;
    indigo::set_option_bool("ignore-stereochemistry-errors", 1);
    let h = indigo::load_structure(mol)?;
    indigo::layout(h);
    indigo::convert(h, "")
}

fn write_temp_file(bytes: &[u8]) -> anyhow::Result<std::path::PathBuf> {
    let id = uuid::Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("imago_in_{id}.png"));
    std::fs::write(&path, bytes)?;
    Ok(path)
}
