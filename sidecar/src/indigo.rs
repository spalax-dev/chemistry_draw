use std::ffi::{CStr, CString};
use std::sync::Mutex;
use libc::c_char;

thread_local! {
    static INDIGO_SESSION: Mutex<u64> = const { Mutex::new(0) };
}

extern "C" {
    // -- Sesiones (qword = u64) --
    fn indigoAllocSessionId() -> u64;
    fn indigoSetSessionId(sid: u64);
    fn indigoReleaseSessionId(sid: u64);

    // -- Moléculas --
    fn indigoLoadMoleculeFromString(str: *const c_char) -> i32;

    // -- Buffer I/O --
    fn indigoWriteBuffer() -> i32;

    // -- Operaciones --
    fn indigoAromatize(handle: i32) -> i32;
    fn indigoDearomatize(handle: i32) -> i32;
    fn indigoLayout(handle: i32);
    fn indigoClean2d(handle: i32);

    // -- Serialización --
    fn indigoToString(handle: i32) -> *const c_char;
    fn indigoMolfile(handle: i32) -> *const c_char;
    fn indigoCanonicalSmiles(handle: i32) -> *const c_char;
    fn indigoSmiles(handle: i32) -> *const c_char;
    fn indigoCml(handle: i32) -> *const c_char;
    fn indigoCdxml(handle: i32) -> *const c_char;
    fn indigoJson(handle: i32) -> *const c_char;

    // -- Propiedades (MolecularWeight etc devuelven double, GrossFormula handle) --
    fn indigoMolecularWeight(handle: i32) -> f64;
    fn indigoMostAbundantMass(handle: i32) -> f64;
    fn indigoMonoisotopicMass(handle: i32) -> f64;
    fn indigoGrossFormula(handle: i32) -> i32;
    fn indigoMassComposition(handle: i32) -> *const c_char;

    // -- Validación --
    fn indigoCheckObj(handle: i32, properties: *const c_char) -> *const c_char;

    // -- Render (requiere libindigo-renderer.so) --
    fn indigoRendererInit(sid: u64) -> i32;
    fn indigoRender(handle: i32, output: i32);

    // -- Automap y Estereoquímica --
    fn indigoAutomap(handle: i32, mode: *const c_char) -> i32;
    fn indigoAddCIPStereoDescriptors(handle: i32) -> i32;

    // -- Version --
    fn indigoVersion() -> *const c_char;

    // -- Options --
    fn indigoSetOption(name: *const c_char, value: *const c_char) -> i32;
    fn indigoSetOptionBool(name: *const c_char, value: i32) -> i32;

    // -- Error --
    fn indigoGetLastError() -> *const c_char;

    // -- Limpieza --
    fn indigoFree(handle: i32) -> i32;
}

// ─── Wrappers seguros ───

pub fn init_session() -> anyhow::Result<u64> {
    let sid = unsafe { indigoAllocSessionId() };
    unsafe { indigoSetSessionId(sid) };
    // Inicializar renderer para esta sesión (registra "render-output-format" etc)
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

pub fn load_structure(s: &str) -> anyhow::Result<i32> {
    let c_str = CString::new(s)?;
    let handle = unsafe { indigoLoadMoleculeFromString(c_str.as_ptr()) };
    if handle < 0 {
        let err = last_error();
        return Err(anyhow::anyhow!("Indigo load error: {}", err));
    }
    Ok(handle)
}

pub fn convert(handle: i32, output_format: &str) -> anyhow::Result<String> {
    let ptr = if output_format.contains("smiles") || output_format.contains("smi") {
        unsafe { indigoCanonicalSmiles(handle) }
    } else if output_format.contains("cml") {
        unsafe { indigoCml(handle) }
    } else if output_format.contains("cdxml") {
        unsafe { indigoCdxml(handle) }
    } else if output_format.contains("ket") || output_format.contains("json") {
        unsafe { indigoJson(handle) }
    } else {
        // default: molfile
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

pub fn aromatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoAromatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("aromatize failed"));
    }
    Ok(res)
}

pub fn dearomatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoDearomatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("dearomatize failed"));
    }
    Ok(res)
}

pub fn layout(handle: i32) {
    unsafe { indigoLayout(handle) };
}

pub fn clean2d(handle: i32) {
    unsafe { indigoClean2d(handle) };
}

pub fn calculate_mw(handle: i32) -> f64 {
    unsafe { indigoMolecularWeight(handle) }
}

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

pub fn calculate_cip(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoAddCIPStereoDescriptors(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("calculate_cip failed: {}", last_error()));
    }
    Ok(res)
}

pub fn automap(handle: i32, mode: &str) -> anyhow::Result<i32> {
    let c_mode = CString::new(mode)?;
    let res = unsafe { indigoAutomap(handle, c_mode.as_ptr()) };
    if res < 0 {
        return Err(anyhow::anyhow!("automap failed: {}", last_error()));
    }
    Ok(res)
}

fn last_error() -> String {
    let ptr = unsafe { indigoGetLastError() };
    if ptr.is_null() {
        return "unknown error".into();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .unwrap_or("unknown")
        .to_owned()
}
