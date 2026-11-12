//! Process-wide ONNX Runtime environment and version reporting.
//!
//! ONNX Runtime allows exactly one environment per process, so the environment
//! is created once on first use and shared by every session. Initialisation is
//! lazy: the sidecar starts and serves Indigo even when `libonnxruntime` or the
//! models are missing, and only the classifier reports the problem (HTTP 503).
//!
//! The runtime is loaded **dynamically** (`ort`'s `load-dynamic` feature): the
//! sidecar never links `libonnxruntime`. Activity 7 ships the pinned 1.31.0
//! library next to the Indigo native libs; [`environment`] resolves the library
//! from `ORT_DYLIB_PATH` when it is set (the host points it at the bundled
//! copy); otherwise it passes the bare platform name (`libonnxruntime.so` /
//! `onnxruntime.dll`) so the normal loader search path (`LD_LIBRARY_PATH`,
//! `PATH`) applies. A failed load is an actionable error, never a panic, and
//! the endpoint maps it to HTTP 503.
//!
//! `ort` 2.0.0-rc.15 does not expose the exact patch version of the loaded
//! runtime through its safe API. [`version_string`] therefore reports the ONNX
//! Runtime **API generation** that `ort` targets ([`ort::MINOR_VERSION`], for
//! example `1.31`) plus the binding version. It is not the loaded binary's
//! exact patch version; a compatible `1.<minor>.x` build is accepted by the
//! loader.

use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;

/// Environment variable that points at the ONNX Runtime shared library.
const ORT_DYLIB_PATH_ENV: &str = "ORT_DYLIB_PATH";
/// The `ort` binding release, echoed by health for bug reports.
const ORT_BINDING_VERSION: &str = "2.0.0-rc.15";
/// ONNX Runtime's major version. `ort::MINOR_VERSION` is the API generation,
/// which maps 1:1 onto the ONNX Runtime minor version (API 31 -> runtime 1.31).
const ONNX_RUNTIME_MAJOR: u32 = 1;
/// Platform shared-library name used when `ORT_DYLIB_PATH` is not set.
const DYLIB_NAME: &str = if cfg!(windows) {
    "onnxruntime.dll"
} else {
    "libonnxruntime.so"
};

type EnvironmentResult = std::result::Result<ort::environment::Environment, String>;

static ENVIRONMENT: OnceLock<EnvironmentResult> = OnceLock::new();

/// Returns the process-wide ONNX Runtime environment, creating it on first use.
///
/// A failed load is cached too: retrying cannot fix a missing
/// `libonnxruntime`, and every caller gets the same actionable message.
pub fn environment() -> Result<ort::environment::Environment> {
    ENVIRONMENT
        .get_or_init(|| {
            let path = dylib_path();
            let builder = ort::init_from(&path).map_err(|error| {
                format!(
                    "could not load ONNX Runtime from `{}` (ort {ORT_BINDING_VERSION}): {error}. \
                     The packaged app ships the runtime under its native lib directory; for \
                     development install it with scripts/fetch-onnxruntime.sh, point \
                     {ORT_DYLIB_PATH_ENV} at a compatible ONNX Runtime 1.{}.x shared library, or \
                     make `{DYLIB_NAME}` visible on the loader search path.",
                    path.display(),
                    ort::MINOR_VERSION
                )
            })?;

            builder
                .with_name("chemistry-draw")
                .with_telemetry(false)
                .build()
                .map_err(|error| {
                    format!(
                        "could not create the ONNX Runtime environment from `{}`: {error}",
                        path.display()
                    )
                })
        })
        .clone()
        .map_err(anyhow::Error::msg)
}

/// Resolves the ONNX Runtime shared library to load.
///
/// `ORT_DYLIB_PATH` wins when set; otherwise the bare platform name is used so
/// the operating-system loader search path applies.
fn dylib_path() -> PathBuf {
    match std::env::var_os(ORT_DYLIB_PATH_ENV) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(DYLIB_NAME),
    }
}

/// Describes the ONNX Runtime API generation the sidecar was built against.
///
/// It is intentionally not a probe of the loaded binary: `ort` 2.0.0-rc.15 has
/// no safe API for that, and the truthful, stable answer is the API generation
/// the binding targets. The value is non-empty even when no session was created.
pub fn version_string() -> String {
    format!(
        "onnxruntime api {ONNX_RUNTIME_MAJOR}.{}.x (ort {ORT_BINDING_VERSION})",
        ort::MINOR_VERSION
    )
}
