//! Model-root resolution.
//!
//! Models are never bundled or committed. The sidecar resolves their root with
//! first-match-wins precedence:
//!
//! 1. a non-empty explicit value (`CHEMISTRY_MODELS_DIR`), used as-is even when
//!    it does not exist, so the operator's configuration is never rewritten;
//! 2. the repository candidate (`<repo>/models`) when that directory exists;
//! 3. `models` relative to the process working directory.
//!
//! The repository candidate is a compile-time path baked into every build,
//! release included. It is only meaningful on a developer machine: on an end
//! user's machine that checkout path usually does not exist, so the `is_dir`
//! check fails and resolution falls back to the cwd-relative `models`. Model
//! delivery is Phase B3; the fallback keeps a standalone sidecar usable when
//! `models/` sits next to the working directory.

use std::path::PathBuf;

/// Resolves the model root. See the module docs for the precedence.
///
/// `Some(PathBuf::new())` is treated as unset, matching an empty environment
/// variable.
pub fn resolve_models_dir(explicit: Option<PathBuf>, repo_models: PathBuf) -> PathBuf {
    if let Some(path) = explicit.filter(|path| !path.as_os_str().is_empty()) {
        return path;
    }

    if repo_models.is_dir() {
        return repo_models;
    }

    PathBuf::from("models")
}
