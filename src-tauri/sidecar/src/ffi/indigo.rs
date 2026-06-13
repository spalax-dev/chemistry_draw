//! FFI bindings to `libindigo.so` + `libindigo-renderer.so`.
//!
//! # Conventions
//!
//! * Handles are `i32` (negative = error).
//! * Session IDs are `u64` (thread-local).
//! * Strings are `*const c_char` (null = error).
//! * Allocated handles must be freed with `indigoFree`.
//!
//! Public wrappers handle freeing internally. Callers never touch `unsafe`.

use libc::c_char;
use std::ffi::{CStr, CString};
use std::sync::Mutex;

thread_local! {
    static INDIGO_SESSION: Mutex<u64> = const { Mutex::new(0) };
}

extern "C" {
    fn indigoAllocSessionId() -> u64;
    fn indigoSetSessionId(sid: u64);
    fn _indigoReleaseSessionId(sid: u64);
    fn indigoLoadMoleculeFromString(str: *const c_char) -> i32;
    fn indigoLoadReactionFromString(str: *const c_char) -> i32;
    fn indigoWriteBuffer() -> i32;
    fn indigoAromatize(handle: i32) -> i32;
    fn indigoDearomatize(handle: i32) -> i32;
    fn indigoLayout(handle: i32);
    fn indigoClean2d(handle: i32);
    fn indigoToString(handle: i32) -> *const c_char;
    fn indigoMolfile(handle: i32) -> *const c_char;
    fn indigoRxnfile(handle: i32) -> *const c_char;
    fn indigoCanonicalSmiles(handle: i32) -> *const c_char;
    fn _indigoSmiles(handle: i32) -> *const c_char;
    fn indigoCml(handle: i32) -> *const c_char;
    fn indigoCdxml(handle: i32) -> *const c_char;
    fn indigoJson(handle: i32) -> *const c_char;
    fn indigoMolecularWeight(handle: i32) -> f64;
    fn indigoGrossFormula(handle: i32) -> i32;
    fn _indigoMostAbundantMass(handle: i32) -> f64;
    fn _indigoMonoisotopicMass(handle: i32) -> f64;
    fn _indigoMassComposition(handle: i32) -> *const c_char;
    fn indigoCheckObj(handle: i32, properties: *const c_char) -> *const c_char;
    fn indigoRendererInit(sid: u64) -> i32;
    fn indigoRender(handle: i32, output: i32);
    fn indigoAutomap(handle: i32, mode: *const c_char) -> i32;
    fn indigoAddCIPStereoDescriptors(handle: i32) -> i32;
    fn indigoVersion() -> *const c_char;
    fn indigoSetOption(name: *const c_char, value: *const c_char) -> i32;
    fn indigoSetOptionBool(name: *const c_char, value: i32) -> i32;
    fn indigoGetLastError() -> *const c_char;
    fn indigoFree(handle: i32) -> i32;
}

/// Allocates a new Indigo session and initialises the renderer.
///
/// # Errors
///
/// Returns an error if `indigoRendererInit` fails.
pub fn init_session() -> anyhow::Result<u64> {
    let sid = unsafe { indigoAllocSessionId() };
    unsafe { indigoSetSessionId(sid) };
    let r = unsafe { indigoRendererInit(sid) };
    if r < 0 {
        return Err(anyhow::anyhow!(
            "indigoRendererInit failed: {}",
            last_error()
        ));
    }
    INDIGO_SESSION.with(|s| *s.lock().unwrap() = sid);
    Ok(sid)
}

/// Sets a boolean Indigo option for the current session.
pub fn set_option_bool(name: &str, value: i32) -> i32 {
    let c_name = CString::new(name).unwrap();
    unsafe { indigoSetOptionBool(c_name.as_ptr(), value) }
}

/// Loads a molecule or reaction from a string (SMILES, molfile, etc.).
///
/// # Errors
///
/// Returns an error if the string is not valid chemistry input.
pub fn load_structure(s: &str) -> anyhow::Result<i32> {
    let c_str = CString::new(s)?;
    let handle = unsafe { indigoLoadMoleculeFromString(c_str.as_ptr()) };
    if handle < 0 {
        return Err(anyhow::anyhow!("Indigo load error: {}", last_error()));
    }
    Ok(handle)
}

/// Converts a molecule handle to the requested output format.
///
/// Takes ownership of the handle and frees it.
///
/// # Supported formats
///
/// * `chemical/x-mdl-molfile` → V2000 molfile (default)
/// * `chemical/x-daylight-smiles` → canonical SMILES
/// * `chemical/x-cml` → CML
/// * `chemical/x-cdxml` → CDXML
/// * `ket`, `json` → Ket JSON
/// * `chemical/x-mdl-rxnfile` → rxnfile
pub fn convert(handle: i32, output_format: &str) -> anyhow::Result<String> {
    let ptr = if output_format.contains("smiles") || output_format.contains("smi") {
        unsafe { indigoCanonicalSmiles(handle) }
    } else if output_format.contains("cml") {
        unsafe { indigoCml(handle) }
    } else if output_format.contains("cdxml") {
        unsafe { indigoCdxml(handle) }
    } else if output_format.contains("ket") || output_format.contains("json") {
        unsafe { indigoJson(handle) }
    } else if output_format.contains("rxn") {
        unsafe { indigoRxnfile(handle) }
    } else {
        unsafe { indigoMolfile(handle) }
    };

    if ptr.is_null() {
        let err = last_error();
        unsafe { indigoFree(handle) };
        return Err(anyhow::anyhow!("convert failed, indigo error: {}", err));
    }
    let s = unsafe { CStr::from_ptr(ptr) }.to_str()?.to_owned();
    unsafe { indigoFree(handle) };
    Ok(s)
}

/// Aromatizes a molecule (restores implicit hydrogens, detects aromaticity).
pub fn aromatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoAromatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("aromatize failed"));
    }
    Ok(res)
}

/// Dearomatizes a molecule (converts to Kekulé form).
pub fn dearomatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoDearomatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("dearomatize failed"));
    }
    Ok(res)
}

/// Lays out (arranges) the molecule's 2D coordinates.
pub fn layout(handle: i32) {
    unsafe { indigoLayout(handle) };
}

/// Cleans up the 2D layout.
pub fn clean2d(handle: i32) {
    unsafe { indigoClean2d(handle) };
}

/// Returns the molecular weight.
pub fn calculate_mw(handle: i32) -> f64 {
    unsafe { indigoMolecularWeight(handle) }
}

/// Returns the gross formula as a string.
///
/// Returns an empty string if the formula handle cannot be resolved.
pub fn calculate_gross(handle: i32) -> String {
    let formula_handle = unsafe { indigoGrossFormula(handle) };
    if formula_handle < 0 {
        return String::new();
    }
    let ptr = unsafe { indigoToString(formula_handle) };
    if ptr.is_null() {
        unsafe { indigoFree(formula_handle) };
        return String::new();
    }
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("")
        .to_owned();
    unsafe { indigoFree(formula_handle) };
    s
}

/// Checks a structure for problems (valence, stereo, overlapping atoms, etc.).
///
/// `types` is a JSON array of check names, e.g. `["valence","stereo"]`.
pub fn check_structure(s: &str, types: &str) -> anyhow::Result<String> {
    let handle = load_structure(s)?;
    let c_types = CString::new(types)?;
    let ptr = unsafe { indigoCheckObj(handle, c_types.as_ptr()) };
    unsafe { indigoFree(handle) };
    if ptr.is_null() {
        return Ok("[]".to_owned());
    }
    Ok(unsafe { CStr::from_ptr(ptr) }.to_str()?.to_owned())
}

/// Renders a molecule to a byte buffer (PNG, SVG, or PDF).
///
/// `fmt` should be `"png"`, `"svg"`, or `"pdf"`.
pub fn render_to_buffer(handle: i32, fmt: &str) -> anyhow::Result<Vec<u8>> {
    unsafe {
        indigoSetOption(
            CString::new("render-output-format").unwrap().as_ptr(),
            CString::new(fmt).unwrap().as_ptr(),
        );
    }
    let buf = unsafe { indigoWriteBuffer() };
    unsafe { indigoRender(handle, buf) };
    let ptr = unsafe { indigoToString(buf) };
    if ptr.is_null() {
        unsafe { indigoFree(buf) };
        return Err(anyhow::anyhow!("render failed: {}", last_error()));
    }
    let result = unsafe { CStr::from_ptr(ptr) }.to_bytes().to_vec();
    unsafe { indigoFree(buf) };
    Ok(result)
}

/// Returns the Indigo library version string.
pub fn version() -> String {
    let ptr = unsafe { indigoVersion() };
    if ptr.is_null() {
        return "unknown".into();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("unknown")
        .to_owned()
}

/// Assigns CIP stereo descriptors (R/S, E/Z) to the molecule.
pub fn calculate_cip(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoAddCIPStereoDescriptors(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("calculate_cip failed: {}", last_error()));
    }
    Ok(res)
}

/// Automatically maps atom-to-atom mapping in a reaction.
pub fn automap(handle: i32, mode: &str) -> anyhow::Result<i32> {
    let c_mode = CString::new(mode)?;
    let res = unsafe { indigoAutomap(handle, c_mode.as_ptr()) };
    if res < 0 {
        return Err(anyhow::anyhow!("automap failed: {}", last_error()));
    }
    Ok(res)
}

/// Loads a reaction from a string.
pub fn load_reaction(s: &str) -> anyhow::Result<i32> {
    let c_str = CString::new(s)?;
    let handle = unsafe { indigoLoadReactionFromString(c_str.as_ptr()) };
    if handle < 0 {
        return Err(anyhow::anyhow!(
            "Indigo load reaction error: {}",
            last_error()
        ));
    }
    Ok(handle)
}

/// Returns the last Indigo error message.
pub fn last_error() -> String {
    let ptr = unsafe { indigoGetLastError() };
    if ptr.is_null() {
        return "unknown error".into();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("unknown")
        .to_owned()
}
