//! Model registry: manifest, artifact checksum, tensor contract and session.
//!
//! `manifest.json` inside the model root is the single source of truth for a
//! model: artifact path, SHA-256, provenance id, decision threshold,
//! preprocessing name and the exact tensor contract. Nothing is guessed and
//! nothing falls back:
//!
//! - a missing manifest, artifact or checksum mismatch is a configuration
//!   error (HTTP 503);
//! - a graph whose input/output names, dtypes or static dimensions disagree
//!   with the manifest is a contract error (HTTP 503);
//! - only a validated model becomes a [`ClassifierModel`] with an ONNX runtime
//!   session.
//!
//! Dynamic graph dimensions (ONNX `-1`) are accepted **only on axis 0**
//! (batch): the manifest supplies the concrete batch the sidecar feeds. Every
//! other graph dimension must equal the manifest exactly; a negative or
//! mismatched dimension anywhere else is a contract error.
//!
//! The classifier session is created with graph optimizations at level 3, one
//! intra-op thread and the CPU execution provider only.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{TensorElementType, ValueType};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::service::ml::classifier::ClassifierModel;
use crate::service::ml::runtime;

/// Manifest schema version understood by this sidecar.
const MANIFEST_SCHEMA: u32 = 1;
/// File name of the manifest inside the model root.
const MANIFEST_FILE: &str = "manifest.json";
/// Key of the image classifier in the manifest's `models` map.
const CLASSIFIER_KEY: &str = "image-classifier";
/// Preprocessing pipeline implemented by [`super::preprocess`].
const PREPROCESSING: &str = "runtime_default";
/// Number of classifier inputs: the image plus two auxiliary zero tensors.
const CLASSIFIER_INPUTS: usize = 3;

/// Tensor contract declared by the manifest and verified against the graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorContract {
    /// Tensor name in the ONNX graph.
    pub name: String,
    /// Lowercase ONNX dtype name, for example `"float32"`.
    pub dtype: String,
    /// Static shape in the manifest, for example `[1, 224, 224, 3]`.
    pub shape: Vec<usize>,
}

/// Validated contract of the image classifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifierContract {
    /// Provenance id, for example `image-classifier@Iagea/d21f4cb`.
    pub id: String,
    /// Classifier inputs, exactly three.
    pub inputs: Vec<TensorContract>,
    /// Classifier output, exactly one.
    pub output: TensorContract,
}

/// Models declared by the manifest and available on disk.
pub struct ModelRegistry {
    classifier: Option<ClassifierModel>,
}

impl ModelRegistry {
    /// Reads `<dir>/manifest.json`, verifies the classifier artifact and opens
    /// its ONNX session.
    ///
    /// A missing directory, manifest, artifact, checksum mismatch or contract
    /// mismatch returns an actionable error. The caller maps it to HTTP 503;
    /// construction of [`crate::AppState`] never fails.
    pub fn load(dir: &Path) -> Result<Self> {
        let manifest = read_manifest(dir)?;
        if manifest.schema != MANIFEST_SCHEMA {
            bail!(
                "{}: unsupported schema {}, this sidecar understands schema {MANIFEST_SCHEMA}",
                manifest_context(dir),
                manifest.schema
            );
        }

        let Some(entry) = manifest.models.get(CLASSIFIER_KEY) else {
            return Ok(Self { classifier: None });
        };

        let classifier = load_classifier(dir, entry)?;
        Ok(Self {
            classifier: Some(classifier),
        })
    }

    /// Returns the classifier when the manifest declares one.
    pub fn classifier(&self) -> Option<&ClassifierModel> {
        self.classifier.as_ref()
    }
}

/// Lists the provenance ids the manifest declares **and** whose artifact file
/// exists on disk, without opening a session.
///
/// This is what `/v2/health` reports: a model id only appears when its artifact
/// is present. A missing or invalid manifest is not a health failure: it logs a
/// warning and yields an empty list.
pub fn available_model_ids(dir: &Path) -> Vec<String> {
    match read_manifest(dir) {
        Ok(manifest) if manifest.schema == MANIFEST_SCHEMA => manifest
            .models
            .into_values()
            .filter(|model| dir.join(&model.file).is_file())
            .map(|model| model.id)
            .collect(),
        Ok(manifest) => {
            tracing::warn!(
                "{}: unsupported schema {}, reporting no models",
                manifest_context(dir),
                manifest.schema
            );
            Vec::new()
        }
        Err(error) => {
            tracing::warn!("{error:#}");
            Vec::new()
        }
    }
}

fn load_classifier(dir: &Path, entry: &ManifestModel) -> Result<ClassifierModel> {
    let context = manifest_context(dir);

    if entry.preprocessing != PREPROCESSING {
        bail!(
            "{context}: classifier `{}` declares preprocessing `{}`, but this sidecar implements only `{PREPROCESSING}`",
            entry.id,
            entry.preprocessing
        );
    }
    if entry.inputs.len() != CLASSIFIER_INPUTS {
        bail!(
            "{context}: classifier `{}` must declare exactly {CLASSIFIER_INPUTS} inputs, found {}",
            entry.id,
            entry.inputs.len()
        );
    }

    let artifact = dir.join(&entry.file);
    if !artifact.is_file() {
        bail!(
            "{context}: classifier artifact {} is missing; download it into the model root or set CHEMISTRY_MODELS_DIR",
            artifact.display()
        );
    }

    let digest = sha256_file(&artifact).with_context(|| {
        format!(
            "{context}: could not hash classifier artifact {}",
            artifact.display()
        )
    })?;
    if !digest.eq_ignore_ascii_case(entry.artifact_sha256.trim()) {
        bail!(
            "{context}: classifier artifact {} has sha256 {digest}, expected {}; replace the corrupted file",
            artifact.display(),
            entry.artifact_sha256
        );
    }

    let session = create_session(&artifact).with_context(|| {
        format!(
            "{context}: could not open classifier artifact {}",
            artifact.display()
        )
    })?;
    validate_contract(&session, entry, &context)?;

    Ok(ClassifierModel::new(
        contract_from_manifest(entry),
        entry.threshold,
        session,
    ))
}

fn create_session(artifact: &Path) -> Result<Session> {
    let environment = runtime::environment()?;
    // `ort::Error<SessionBuilder>` is not `Send + Sync` (the builder holds raw
    // pointers), so it cannot use `?` into `anyhow::Error`; flatten it here.
    let mut builder = Session::builder(&environment)
        .map_err(|error| anyhow!("could not create the ONNX session builder: {error}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| anyhow!("could not enable graph optimizations: {error}"))?
        .with_intra_threads(1)
        .map_err(|error| anyhow!("could not set the intra-op thread count: {error}"))?;

    builder
        .commit_from_file(artifact)
        .map_err(|error| anyhow!("could not load the ONNX graph: {error}"))
}

fn contract_from_manifest(entry: &ManifestModel) -> ClassifierContract {
    ClassifierContract {
        id: entry.id.clone(),
        inputs: entry.inputs.iter().map(TensorContract::from).collect(),
        output: TensorContract::from(&entry.output),
    }
}

impl From<&ManifestTensor> for TensorContract {
    fn from(tensor: &ManifestTensor) -> Self {
        Self {
            name: tensor.name.clone(),
            dtype: tensor.dtype.clone(),
            shape: tensor.shape.clone(),
        }
    }
}

fn validate_contract(session: &Session, entry: &ManifestModel, context: &str) -> Result<()> {
    if session.inputs().len() != CLASSIFIER_INPUTS {
        bail!(
            "{context}: classifier `{}` graph has {} inputs, expected exactly {CLASSIFIER_INPUTS}",
            entry.id,
            session.inputs().len()
        );
    }
    if session.outputs().len() != 1 {
        bail!(
            "{context}: classifier `{}` graph has {} outputs, expected exactly one",
            entry.id,
            session.outputs().len()
        );
    }

    for outlet in session.inputs() {
        let declared = entry
            .inputs
            .iter()
            .find(|input| input.name == outlet.name())
            .ok_or_else(|| {
                anyhow!(
                    "{context}: classifier `{}` graph declares input `{}` that the manifest does not",
                    entry.id,
                    outlet.name()
                )
            })?;
        compare_tensor("input", outlet.name(), outlet.dtype(), declared, context)?;
    }

    let output = &session.outputs()[0];
    compare_tensor(
        "output",
        output.name(),
        output.dtype(),
        &entry.output,
        context,
    )
}

fn compare_tensor(
    direction: &str,
    name: &str,
    dtype: &ValueType,
    declared: &ManifestTensor,
    context: &str,
) -> Result<()> {
    let ValueType::Tensor { ty, shape, .. } = dtype else {
        bail!("{context}: classifier {direction} `{name}` is not a tensor");
    };

    let graph_dtype = onnx_dtype_name(*ty);
    if graph_dtype != declared.dtype {
        bail!(
            "{context}: classifier {direction} `{name}` has dtype `{graph_dtype}`, the manifest declares `{}`",
            declared.dtype
        );
    }

    validate_tensor_shape(shape, &declared.shape).with_context(|| {
        format!(
            "{context}: classifier {direction} `{name}` has shape {shape}, incompatible with the manifest shape {:?}",
            declared.shape
        )
    })?;

    Ok(())
}

/// Checks a graph shape against the manifest shape.
///
/// A graph dimension of `-1` is dynamic and accepted only on **axis 0**
/// (batch); every other axis must equal the manifest exactly. The rank must
/// match in all cases. Returns an actionable error naming the axis.
pub fn validate_tensor_shape(graph: &[i64], manifest: &[usize]) -> Result<()> {
    if graph.len() != manifest.len() {
        bail!(
            "rank {} does not match the manifest rank {}; only axis 0 may be dynamic `-1`",
            graph.len(),
            manifest.len()
        );
    }

    for (axis, (graph_dimension, manifest_dimension)) in graph.iter().zip(manifest).enumerate() {
        let manifest_dimension = i64::try_from(*manifest_dimension)
            .map_err(|_| anyhow!("manifest dimension {manifest_dimension} does not fit in i64"))?;
        if *graph_dimension == manifest_dimension {
            continue;
        }
        if axis == 0 && *graph_dimension == -1 {
            continue;
        }
        bail!(
            "axis {axis} has graph dimension {graph_dimension}, the manifest requires {manifest_dimension}; \
             only axis 0 (batch) may be dynamic `-1`"
        );
    }

    Ok(())
}

/// Converts an ONNX element type into its lowercase ONNX name (`float32`,
/// `int64`, ...). Debug variant names match the ONNX spellings.
fn onnx_dtype_name(dtype: TensorElementType) -> String {
    format!("{dtype:?}").to_lowercase()
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join(MANIFEST_FILE);
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("{} could not be read", manifest_context(dir)))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("{} is not a valid model manifest", manifest_context(dir)))
}

fn manifest_context(dir: &Path) -> String {
    format!(
        "model manifest {} (model root {}; set CHEMISTRY_MODELS_DIR to point at the model root)",
        dir.join(MANIFEST_FILE).display(),
        dir.display()
    )
}

#[derive(Debug, Deserialize)]
struct Manifest {
    schema: u32,
    models: BTreeMap<String, ManifestModel>,
}

#[derive(Debug, Deserialize)]
struct ManifestModel {
    id: String,
    file: String,
    artifact_sha256: String,
    threshold: f64,
    preprocessing: String,
    inputs: Vec<ManifestTensor>,
    output: ManifestTensor,
}

#[derive(Debug, Deserialize)]
struct ManifestTensor {
    name: String,
    dtype: String,
    shape: Vec<usize>,
}
