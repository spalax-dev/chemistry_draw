//! Bundled model catalog (B3): what to download and how it maps to the
//! installed manifest.
//!
//! The catalog is compiled into the sidecar from `model-catalog.json`; it is
//! the source of truth for artifact URLs, sizes, SHA-256 values, provenance,
//! licenses, preprocessing settings and tensor contracts. The *installed*
//! `manifest.json` stays the source of truth for **loading** a model
//! ([`super::registry`]), and the downloader generates it from this catalog
//! after every artifact verifies.
//!
//! Parsing is strict because every path is joined to the model root: an
//! absolute path or a `..` component is a catalog error, never a file written
//! outside the root. The bundled file is valid by construction (the test suite
//! pins its values); `CHEMISTRY_MODEL_CATALOG` may override it for tests, and
//! an unreadable or invalid override is surfaced as an actionable error by the
//! model routes while Indigo keeps serving.
//!
//! Helpers in this module are cheap filesystem existence checks only: no
//! artifact is hashed here, so `/v2/models`, `/v2/info` and `/v2/health` never
//! read hundreds of megabytes.

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// File name of the generated manifest inside the model root.
pub const MANIFEST_FILE: &str = "manifest.json";

/// Schema version of the generated manifest. The registry understands this
/// value; the catalog adds `catalog_version` at the top level.
pub const MANIFEST_SCHEMA: u32 = 1;

/// Hard upper bound for the sum of declared artifact sizes. The catalog can be
/// overridden by `CHEMISTRY_MODEL_CATALOG`, so a hostile or corrupted document
/// must be rejected before the downloader trusts an absurd byte count.
pub const MAX_CATALOG_BYTES: u64 = 1 << 40; // 1 TiB

/// The compiled-in catalog.
static BUNDLED_CATALOG: OnceLock<Catalog> = OnceLock::new();

/// Returns the bundled catalog, parsing it on first use.
///
/// The file is part of the crate, so a parse failure is a build/contract bug;
/// the test suite pins every value before a release.
pub fn bundled_catalog() -> &'static Catalog {
    BUNDLED_CATALOG.get_or_init(|| {
        Catalog::from_json(include_str!("model-catalog.json"))
            .expect("the bundled model catalog must be valid")
    })
}

/// Root catalog document.
#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    /// Monotonic catalog version. A download installs, repairs and updates
    /// when this is newer than the installed manifest's value; a newer
    /// installed catalog is never downgraded.
    pub catalog_version: u64,
    /// Models keyed by their manifest key (`image-classifier`,
    /// `ocsr-handdrawn`). `BTreeMap` keeps the documented catalog order.
    pub models: BTreeMap<String, CatalogModel>,
}

impl Catalog {
    /// Parses and validates a catalog document.
    ///
    /// The error chain names the offending model, artifact path or URL, so the
    /// model routes can return it verbatim.
    pub fn from_json(raw: &str) -> Result<Self> {
        let catalog: Self = serde_json::from_str(raw)
            .context("the model catalog is not valid JSON for the documented schema")?;
        catalog.validate()?;
        Ok(catalog)
    }

    /// Sum of every declared artifact size.
    pub fn total_bytes(&self) -> u64 {
        self.models
            .values()
            .flat_map(|model| &model.artifacts)
            .map(|artifact| artifact.size)
            .sum()
    }

    /// Every artifact in catalog order (models first, then artifact order).
    pub fn artifacts(&self) -> impl Iterator<Item = &CatalogArtifact> {
        self.models
            .values()
            .flat_map(|model| model.artifacts.iter())
    }

    fn validate(&self) -> Result<()> {
        if self.catalog_version == 0 {
            bail!("model catalog: catalog_version must be at least 1");
        }
        if self.models.is_empty() {
            bail!("model catalog: at least one model is required");
        }

        let mut paths = HashSet::new();
        for (key, model) in &self.models {
            model.validate(key)?;
            for artifact in &model.artifacts {
                validate_artifact_path(key, &artifact.path)?;
                if !paths.insert(artifact.path.clone()) {
                    bail!(
                        "model catalog: artifact path `{}` is declared more than once",
                        artifact.path
                    );
                }
            }
        }

        let total = self
            .artifacts()
            .try_fold(0_u64, |total, artifact| total.checked_add(artifact.size))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "model catalog: the declared artifact sizes overflow a 64-bit byte count"
                )
            })?;
        if total > MAX_CATALOG_BYTES {
            bail!(
                "model catalog: the declared artifact sizes total {total} bytes, more than the \
                 supported maximum of {MAX_CATALOG_BYTES} bytes"
            );
        }

        Ok(())
    }
}

/// One model family in the catalog.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogModel {
    /// Provenance id, for example `image-classifier@Iagea/d21f4cb`.
    pub id: String,
    /// Upstream version, for example `Iagea/d21f4cb`.
    pub version: String,
    /// SPDX license identifier.
    pub license: String,
    /// Upstream repository the artifacts come from.
    pub source: String,
    /// Preprocessing pipeline name understood by the sidecar.
    pub preprocessing: String,
    /// Classifier decision threshold.
    #[serde(default)]
    pub threshold: Option<f64>,
    /// First token fed to the OCSR decoder.
    #[serde(default)]
    pub start_id: Option<i32>,
    /// Token that terminates an OCSR decode.
    #[serde(default)]
    pub end_id: Option<i32>,
    /// Maximum OCSR decoding steps.
    #[serde(default)]
    pub max_len: Option<usize>,
    /// Informational OCSR confidence threshold.
    #[serde(default)]
    pub confidence_threshold: Option<f64>,
    /// Artifacts of this model, in download order.
    pub artifacts: Vec<CatalogArtifact>,
}

impl CatalogModel {
    /// Sum of this model's declared artifact sizes.
    pub fn total_bytes(&self) -> u64 {
        self.artifacts.iter().map(|artifact| artifact.size).sum()
    }

    /// Returns the artifact with `role`, when declared.
    pub fn artifact(&self, role: ArtifactRole) -> Option<&CatalogArtifact> {
        self.artifacts.iter().find(|artifact| artifact.role == role)
    }

    fn validate(&self, key: &str) -> Result<()> {
        if key.trim().is_empty() {
            bail!("model catalog: a model key must not be empty");
        }
        for (name, value) in [
            ("id", &self.id),
            ("version", &self.version),
            ("license", &self.license),
            ("source", &self.source),
            ("preprocessing", &self.preprocessing),
        ] {
            if value.trim().is_empty() {
                bail!("model catalog: model `{key}` requires a non-empty `{name}`");
            }
        }
        if self.artifacts.is_empty() {
            bail!("model catalog: model `{key}` declares no artifacts");
        }

        let mut roles = HashSet::new();
        for artifact in &self.artifacts {
            if !roles.insert(artifact.role) {
                bail!(
                    "model catalog: model `{key}` declares the `{}` role more than once",
                    artifact.role
                );
            }
        }

        let classifier = roles.contains(&ArtifactRole::Classifier);
        let ocsr = roles.contains(&ArtifactRole::Encoder)
            || roles.contains(&ArtifactRole::Decoder)
            || roles.contains(&ArtifactRole::Vocab);

        if classifier {
            if self.artifacts.len() != 1 {
                bail!(
                    "model catalog: model `{key}` declares `classifier` together with another role; \
                     the classifier entry is a single-file model"
                );
            }
            if self.threshold.is_none() {
                bail!("model catalog: classifier model `{key}` requires `threshold`");
            }
        } else if ocsr {
            for role in [
                ArtifactRole::Encoder,
                ArtifactRole::Decoder,
                ArtifactRole::Vocab,
            ] {
                if !roles.contains(&role) {
                    bail!("model catalog: OCSR model `{key}` requires the `{role}` role");
                }
            }
            for (name, present) in [
                ("start_id", self.start_id.is_some()),
                ("end_id", self.end_id.is_some()),
                ("max_len", self.max_len.is_some()),
                ("confidence_threshold", self.confidence_threshold.is_some()),
            ] {
                if !present {
                    bail!("model catalog: OCSR model `{key}` requires `{name}`");
                }
            }
        } else {
            bail!("model catalog: model `{key}` declares no recognized artifact role");
        }

        for artifact in &self.artifacts {
            artifact.validate(key)?;
        }

        Ok(())
    }
}

/// One downloadable artifact and its manifest contract.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogArtifact {
    /// Manifest slot this artifact fills.
    pub role: ArtifactRole,
    /// Path relative to the model root.
    pub path: String,
    /// Absolute download URL.
    pub url: String,
    /// Exact artifact size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256 of the artifact.
    pub sha256: String,
    /// Graph inputs for `classifier`, `encoder` and `decoder` artifacts.
    #[serde(default)]
    pub inputs: Vec<TensorContract>,
    /// Graph output for `classifier`, `encoder` and `decoder` artifacts.
    #[serde(default)]
    pub output: Option<TensorContract>,
    /// Graph inputs fed all zeros; only the decoder declares these.
    #[serde(default)]
    pub zero_inputs: Vec<String>,
}

impl CatalogArtifact {
    fn validate(&self, model: &str) -> Result<()> {
        if self.size == 0 {
            bail!(
                "model catalog: model `{model}` artifact `{}` declares size 0",
                self.path
            );
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!(
                "model catalog: model `{model}` artifact `{}` declares an invalid sha256 `{}` \
                 (expected 64 hex characters)",
                self.path,
                self.sha256
            );
        }
        validate_url(model, &self.path, &self.url)?;

        match self.role {
            ArtifactRole::Vocab => {}
            ArtifactRole::Classifier | ArtifactRole::Encoder | ArtifactRole::Decoder => {
                if self.inputs.is_empty() {
                    bail!(
                        "model catalog: model `{model}` {} artifact `{}` requires `inputs`",
                        self.role,
                        self.path
                    );
                }
                if self.output.is_none() {
                    bail!(
                        "model catalog: model `{model}` {} artifact `{}` requires `output`",
                        self.role,
                        self.path
                    );
                }
            }
        }

        Ok(())
    }
}

/// Manifest slot selected by an artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactRole {
    /// Single-file image classifier.
    Classifier,
    /// OCSR encoder graph.
    Encoder,
    /// OCSR decoder-step graph.
    Decoder,
    /// OCSR vocabulary.
    Vocab,
}

impl std::fmt::Display for ArtifactRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Classifier => "classifier",
            Self::Encoder => "encoder",
            Self::Decoder => "decoder",
            Self::Vocab => "vocab",
        };
        formatter.write_str(name)
    }
}

/// Tensor contract copied from the catalog into the generated manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct TensorContract {
    /// Tensor name in the ONNX graph.
    pub name: String,
    /// Lowercase ONNX dtype name.
    pub dtype: String,
    /// Contract shape; `-1` marks a dynamic axis.
    pub shape: Vec<i64>,
}

fn validate_artifact_path(model: &str, path: &str) -> Result<()> {
    if path.trim().is_empty() {
        bail!("model catalog: model `{model}` declares an empty artifact path");
    }

    let windows_prefix = path
        .get(..2)
        .is_some_and(|prefix| prefix.as_bytes().get(1) == Some(&b':'));
    if path.starts_with('/') || path.starts_with('\\') || windows_prefix {
        bail!(
            "model catalog: artifact path `{path}` is absolute; artifact paths must be relative \
             to the model root"
        );
    }
    if Path::new(path).is_absolute() {
        bail!(
            "model catalog: artifact path `{path}` is absolute; artifact paths must be relative \
             to the model root"
        );
    }

    for component in Path::new(path).components() {
        match component {
            Component::Normal(_) => {}
            Component::ParentDir => bail!(
                "model catalog: artifact path `{path}` contains `..`; artifact paths must stay \
                 inside the model root"
            ),
            Component::CurDir => {
                bail!("model catalog: artifact path `{path}` must not contain `.` components")
            }
            Component::RootDir | Component::Prefix(_) => bail!(
                "model catalog: artifact path `{path}` is absolute; artifact paths must be \
                 relative to the model root"
            ),
        }
    }

    Ok(())
}

fn validate_url(model: &str, path: &str, url: &str) -> Result<()> {
    match reqwest::Url::parse(url) {
        Ok(parsed)
            if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some() =>
        {
            Ok(())
        }
        Ok(_) => bail!(
            "model catalog: model `{model}` artifact `{path}` URL `{url}` must use http or https"
        ),
        Err(error) => bail!(
            "model catalog: model `{model}` artifact `{path}` URL `{url}` is not valid: {error}"
        ),
    }
}

/// Absolute path of the generated manifest inside `root`.
pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

/// Returns the parsed manifest, or `None` when it is missing or unparsable.
pub fn read_manifest(root: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(manifest_path(root)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// True when `<root>/manifest.json` exists and parses as JSON.
pub fn manifest_present(root: &Path) -> bool {
    read_manifest(root).is_some()
}

/// Catalog version recorded by the installed manifest, when present.
pub fn installed_catalog_version(root: &Path) -> Option<u64> {
    read_manifest(root)?.get("catalog_version")?.as_u64()
}

/// True when every catalog artifact exists under `root` (cheap existence
/// check; no hashing).
pub fn all_artifacts_present(root: &Path, catalog: &Catalog) -> bool {
    catalog
        .artifacts()
        .all(|artifact| root.join(&artifact.path).is_file())
}

/// True when the installed manifest is schema 1 and declares a usable entry
/// for every catalog model: the classifier's `file`/`artifact_sha256` and the
/// OCSR `encoder`/`decoder`/`vocab` slots must carry a non-empty file and a
/// 64-hex SHA-256. A syntactically valid but empty or foreign manifest (`{}`)
/// is not usable: it must not make the install look ready or advertise models
/// the registry cannot load. This is still a metadata-only check; no artifact
/// is hashed.
pub fn manifest_is_usable(root: &Path, catalog: &Catalog) -> bool {
    let Some(models) = usable_manifest_models(root) else {
        return false;
    };

    catalog.models.iter().all(|(key, model)| {
        let Some(entry) = models.get(key) else {
            return false;
        };
        model
            .artifacts
            .iter()
            .all(|artifact| manifest_slot(entry, artifact.role).is_some_and(manifest_slot_usable))
    })
}

/// True when the manifest is usable and its slots name the active catalog's
/// artifact paths and SHA-256 values. The explicit download uses this for its
/// no-op decision, so a stale manifest is rewritten even when the files match.
pub fn manifest_is_current(root: &Path, catalog: &Catalog) -> bool {
    if installed_catalog_version(root) != Some(catalog.catalog_version) {
        return false;
    }
    let Some(models) = usable_manifest_models(root) else {
        return false;
    };

    catalog.models.iter().all(|(key, model)| {
        let Some(entry) = models.get(key) else {
            return false;
        };
        model.artifacts.iter().all(|artifact| {
            manifest_slot(entry, artifact.role)
                .is_some_and(|slot| manifest_slot_matches(slot, artifact))
        })
    })
}

/// True when the manifest is usable and every catalog artifact exists. This is
/// the capability gate for `/v2/info` and the `ready` flag.
pub fn models_ready(root: &Path, catalog: &Catalog) -> bool {
    manifest_is_usable(root, catalog) && all_artifacts_present(root, catalog)
}

/// Returns the manifest's `models` map when the document is schema 1.
fn usable_manifest_models(root: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let manifest = read_manifest(root)?;
    if manifest.get("schema").and_then(serde_json::Value::as_u64)
        != Some(u64::from(MANIFEST_SCHEMA))
    {
        return None;
    }
    manifest
        .get("models")
        .and_then(serde_json::Value::as_object)
        .cloned()
}

fn manifest_slot(entry: &serde_json::Value, role: ArtifactRole) -> Option<&serde_json::Value> {
    match role {
        ArtifactRole::Classifier => Some(entry),
        ArtifactRole::Encoder => entry.get("encoder"),
        ArtifactRole::Decoder => entry.get("decoder"),
        ArtifactRole::Vocab => entry.get("vocab"),
    }
}

fn manifest_slot_usable(slot: &serde_json::Value) -> bool {
    slot.get("file")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|file| !file.trim().is_empty())
        && slot
            .get("artifact_sha256")
            .and_then(serde_json::Value::as_str)
            .is_some_and(valid_sha256)
}

fn manifest_slot_matches(slot: &serde_json::Value, artifact: &CatalogArtifact) -> bool {
    slot.get("file")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|path| path == artifact.path)
        && slot
            .get("artifact_sha256")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|sha| sha.eq_ignore_ascii_case(&artifact.sha256))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Provenance ids whose catalog artifacts all exist under `root`, in catalog
/// order. Used by `/v2/health` as the fallback when there is no manifest.
pub fn installed_model_ids(root: &Path, catalog: &Catalog) -> Vec<String> {
    catalog
        .models
        .values()
        .filter(|model| {
            model
                .artifacts
                .iter()
                .all(|artifact| root.join(&artifact.path).is_file())
        })
        .map(|model| model.id.clone())
        .collect()
}
