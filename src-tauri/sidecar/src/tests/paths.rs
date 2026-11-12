// Tests for the pure model-root resolver in `service/ml/paths.rs`.
//
// The contract (docs/architecture.md, "Model directory and manifest") is
// first match wins:
//
// 1. an explicit value (`CHEMISTRY_MODELS_DIR`), used as-is even when missing;
// 2. an existing `<repo>/models` candidate;
// 3. `models` relative to the sidecar's working directory.
//
// The resolver receives both inputs, so these tests never read or mutate the
// process environment or working directory. Only the repo candidate touches
// the filesystem, through unique temporary paths.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::service::ml::paths::resolve_models_dir;

// ── Temporary paths ──────────────────────────────────────────

/// Unique path under the system temp directory that no test creates.
fn missing_temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the UNIX epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "chemistry-draw-paths-{}-{label}-{nanos}",
        std::process::id()
    ))
}

/// Unique temporary directory, removed when the test finishes.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn create(label: &str) -> Self {
        let path = missing_temp_path(label);
        std::fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("could not create {path:?}: {error}"));
        Self { path }
    }

    fn path(&self) -> PathBuf {
        self.path.clone()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ── Precedence ───────────────────────────────────────────────

#[test]
fn explicit_env_wins_even_when_missing() {
    let explicit = PathBuf::from("/definitely/missing/models");
    let repo = missing_temp_path("explicit-repo-missing");

    let resolved = resolve_models_dir(Some(explicit.clone()), repo);

    assert_eq!(
        resolved, explicit,
        "an explicit model root must win even when it does not exist"
    );
}

#[test]
fn explicit_wins_over_existing_repo_candidate() {
    let explicit = missing_temp_path("explicit-wins");
    let repo = TempDir::create("explicit-wins-repo");

    let resolved = resolve_models_dir(Some(explicit.clone()), repo.path());

    assert_eq!(
        resolved, explicit,
        "an explicit model root must win even when an existing repo candidate is present"
    );
}

#[test]
fn existing_repo_models_wins_over_cwd() {
    let repo = TempDir::create("existing-repo");

    let resolved = resolve_models_dir(None, repo.path());

    assert_eq!(
        resolved,
        repo.path(),
        "an existing repo candidate must win over the cwd fallback"
    );
}

#[test]
fn missing_repo_models_falls_back_to_cwd_relative() {
    let repo = missing_temp_path("repo-missing");

    let resolved = resolve_models_dir(None, repo);

    assert_eq!(
        resolved,
        PathBuf::from("models"),
        "without an explicit value or a repo candidate, the cwd-relative `models` wins"
    );
}

#[test]
fn empty_explicit_path_is_treated_as_unset_and_uses_repo_candidate() {
    let repo = TempDir::create("empty-explicit-repo");

    let resolved = resolve_models_dir(Some(PathBuf::new()), repo.path());

    assert_eq!(
        resolved,
        repo.path(),
        "an empty explicit value must be treated as unset and fall through to the repo candidate"
    );
}
