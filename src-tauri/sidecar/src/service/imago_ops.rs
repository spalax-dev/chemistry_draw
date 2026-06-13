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
