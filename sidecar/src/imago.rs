use std::ffi::{CStr, CString};

extern "C" {
    fn imagoSetSessionId(sid: u64);

    fn imagoLoadImageFromFile(filename: *const libc::c_char) -> i32;

    fn imagoFilterImage() -> i32;

    fn imagoSetConfig(name: *const libc::c_char) -> i32;

    fn imagoRecognize(warnings: *mut i32) -> i32;
    fn imagoGetMol() -> *const libc::c_char;
    fn imagoGetLastError() -> *const libc::c_char;
}

// ─── Wrappers seguros ───

pub fn versions() -> Vec<String> {
    vec!["1".into(), "2".into()]
}

pub fn init_with_indigo_session(indigo_sid: u64) {
    // SAFETY: imagoSetSessionId is a C function with no side effects
    unsafe { imagoSetSessionId(indigo_sid) };
}

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
