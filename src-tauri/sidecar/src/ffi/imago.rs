//! FFI bindings to `libimago.so` (EPAM Imago v2).
//!
//! Imago converts images of chemical structures into molfiles.
//!
//! # Session
//!
//! Imago reuses the Indigo session — call [`init_with_indigo_session`]
//! after `indigo::init_session` instead of using the native
//! `imagoAllocSessionId` (which crashes on Rust-FFI boundaries).
//!
//! # Pipeline
//!
//! 1. [`init_with_indigo_session`]
//! 2. [`load_image_from_file`]
//! 3. [`filter_image`]
//! 4. [`set_config`] (pass `None` for auto-detect)
//! 5. [`recognize`]
//!
//! # Known limitations
//!
//! Imago v2 (2013) uses template-matching OCR. Characters like `CH3`
//! are often misrecognised as `CHl` on low-resolution screenshots.

use libc::c_char;
use std::ffi::{CStr, CString};

extern "C" {
    fn imagoSetSessionId(sid: u64);
    fn imagoLoadImageFromFile(filename: *const c_char) -> i32;
    fn imagoFilterImage() -> i32;
    fn imagoSetConfig(name: *const c_char) -> i32;
    fn imagoRecognize(warnings: *mut i32) -> i32;
    fn imagoGetMol() -> *const c_char;
    fn imagoGetLastError() -> *const c_char;
}

/// Returns the Imago version identifiers reported to Ketcher.
///
/// Ketcher reads `imagoVersions[1]` as the default version, so the
/// array must contain at least two elements.
pub fn versions() -> Vec<String> {
    vec!["1".into(), "2".into()]
}

/// Attaches Imago to an existing Indigo session.
///
/// Must be called once before any other Imago function in this thread.
pub fn init_with_indigo_session(indigo_sid: u64) {
    unsafe { imagoSetSessionId(indigo_sid) };
}

/// Loads an image from disk (OpenCV `imread`, supports JPEG and PNG).
///
/// # Errors
///
/// Returns an error if the file does not exist or cannot be decoded.
pub fn load_image_from_file(path: &str) -> anyhow::Result<()> {
    let c_path = CString::new(path)?;
    let res = unsafe { imagoLoadImageFromFile(c_path.as_ptr()) };
    if res < 0 {
        return Err(anyhow::anyhow!(
            "imago load image failed: {}",
            last_error()
        ));
    }
    Ok(())
}

/// Binarises and preprocesses the loaded image.
///
/// Equivalent to binarize + deskew + denoise. Must be called after
/// [`load_image_from_file`] and before [`set_config`].
pub fn filter_image() -> anyhow::Result<()> {
    let res = unsafe { imagoFilterImage() };
    if res < 0 {
        return Err(anyhow::anyhow!(
            "imago filter failed: {}",
            last_error()
        ));
    }
    Ok(())
}

/// Sets Imago configuration. Pass `None` for auto-detection.
pub fn set_config(config: Option<&str>) -> anyhow::Result<()> {
    let c_config = config.map(|s| CString::new(s).unwrap());
    let ptr = c_config
        .as_ref()
        .map(|c| c.as_ptr())
        .unwrap_or(std::ptr::null());
    let res = unsafe { imagoSetConfig(ptr) };
    if res < 0 {
        return Err(anyhow::anyhow!(
            "imago set config failed: {}",
            last_error()
        ));
    }
    Ok(())
}

/// Runs OCR recognition and returns the resulting molfile.
///
/// The returned molfile may have valence or chirality errors — downstream
/// callers should pass it through Indigo with `ignore-stereochemistry-errors`
/// for cleanup.
pub fn recognize() -> anyhow::Result<String> {
    let mut warnings: i32 = 0;
    let res = unsafe { imagoRecognize(&mut warnings) };
    if res < 0 {
        return Err(anyhow::anyhow!(
            "imago recognize failed: {}",
            last_error()
        ));
    }
    let ptr = unsafe { imagoGetMol() };
    if ptr.is_null() {
        return Err(anyhow::anyhow!("imago returned null molfile"));
    }
    Ok(unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("")
        .to_owned())
}

fn last_error() -> String {
    let ptr = unsafe { imagoGetLastError() };
    if ptr.is_null() {
        return "unknown error".into();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("unknown")
        .to_owned()
}
