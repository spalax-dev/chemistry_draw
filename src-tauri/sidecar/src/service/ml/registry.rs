//! Model registry: manifest, artifact checksums, tensor contracts and sessions.
//!
//! `manifest.json` inside the model root is the single source of truth for a
//! model: artifact paths, SHA-256, provenance id, decision threshold,
//! preprocessing name and the exact tensor contract. Nothing is guessed and
//! nothing falls back:
//!
//! - a missing manifest, artifact or checksum mismatch is a configuration
//!   error (HTTP 503);
//! - a graph whose input/output names, dtypes or static dimensions disagree
//!   with the manifest is a contract error (HTTP 503);
//! - only a validated model becomes a [`ClassifierModel`] or an [`OcsrModel`]
//!   with its ONNX runtime session(s).
//!
//! Dynamic graph dimensions (ONNX `-1`) are accepted **only on axis 0** (batch)
//! for the classifier; for the decoder they are also accepted on the axes the
//! manifest marks with `-1` (the decode sequence). Every other graph dimension
//! must equal the manifest exactly.
//!
//! Loading is per model family and lazy. [`ModelRegistry::load`] opens only the
//! classifier session; [`ModelRegistry::ocsr`] verifies the OCSR artifacts,
//! validates both graphs and creates the encoder/decoder pair on its first call
//! and caches the result. Startup, `/v2/health` and `/v2/filter/classify` never
//! open the ~316 MB OCSR graphs.
//!
//! Sessions are created with graph optimizations at level 3, one intra-op thread
//! and the CPU execution provider only.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{TensorElementType, ValueType};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::service::ml::classifier::ClassifierModel;
use crate::service::ml::ocsr::OcsrModel;
use crate::service::ml::ocsr_vocab;
use crate::service::ml::runtime;

/// Manifest schema version understood by this sidecar.
const MANIFEST_SCHEMA: u32 = 1;
/// File name of the manifest inside the model root.
const MANIFEST_FILE: &str = "manifest.json";
/// Key of the image classifier in the manifest's `models` map.
const CLASSIFIER_KEY: &str = "image-classifier";
/// Key of the OCSR model in the manifest's `models` map.
const OCSR_KEY: &str = "ocsr-handdrawn";
/// Preprocessing pipeline implemented by [`super::preprocess`].
const PREPROCESSING: &str = "runtime_default";
/// Preprocessing pipeline implemented by [`super::ocsr_preprocess`].
const OCSR_PREPROCESSING: &str = "decimer_ocsr";
/// Number of classifier inputs: the image plus two auxiliary zero tensors.
const CLASSIFIER_INPUTS: usize = 3;
/// Decoder-step input that carries the token sequence.
const DECODER_TOKENS: &str = "tokens";
/// Decoder-step input that carries the encoder output unchanged.
const DECODER_ENC_OUT: &str = "enc_out";
/// Dtypes a graph-declared zero input may use.
const ZERO_INPUT_DTYPES: [&str; 4] = ["float32", "float64", "int32", "int64"];

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

/// Tensor contract of one OCSR graph, signed because `-1` marks a dynamic axis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcsrTensorContract {
    /// Tensor name in the ONNX graph.
    pub name: String,
    /// Lowercase ONNX dtype name, for example `"float32"`.
    pub dtype: String,
    /// Contract shape; `-1` marks a dynamic decode-sequence axis.
    pub shape: Vec<i64>,
}

/// Validated contract of the OCSR encoder/decoder pair.
#[derive(Debug, Clone, PartialEq)]
pub struct OcsrContract {
    /// Provenance id, for example `ocsr-handdrawn@zenodo:10781330`.
    pub id: String,
    /// Encoder image input, NHWC float32 `[1, 512, 512, 3]`.
    pub encoder_input: OcsrTensorContract,
    /// Encoder feature output (`enc_out`).
    pub encoder_output: OcsrTensorContract,
    /// Decoder token input, int32 `[1, seq]` with a dynamic sequence axis.
    pub decoder_tokens: OcsrTensorContract,
    /// Decoder encoder-output input, fed unchanged.
    pub decoder_enc_out: OcsrTensorContract,
    /// Decoder probability output, `[1, seq, 156]`, already softmaxed.
    pub decoder_output: OcsrTensorContract,
    /// Additional graph inputs fed all zeros, resolved from the graph.
    pub zero_inputs: Vec<OcsrTensorContract>,
    /// First token fed to the decoder.
    pub start_id: i32,
    /// Token that terminates a complete decode.
    pub end_id: i32,
    /// Maximum decoding steps before the structure is truncated.
    pub max_len: usize,
    /// Informational confidence threshold recorded by the manifest.
    pub confidence_threshold: f64,
}

/// Models declared by the manifest and available on disk.
pub struct ModelRegistry {
    dir: PathBuf,
    classifier: Option<ClassifierModel>,
    /// OCSR entry parsed at load, or the entry parse error.
    ocsr_entry: Option<Result<ManifestOcsrModel, String>>,
    /// Lazily loaded OCSR pair; the error is cached too.
    ocsr: OnceLock<Result<Option<OcsrModel>, String>>,
}

impl ModelRegistry {
    /// Reads `<dir>/manifest.json`, verifies the classifier artifact and opens
    /// its ONNX session.
    ///
    /// A missing directory, manifest or classifier artifact, a checksum or
    /// contract mismatch is an actionable error. The caller maps it to HTTP 503;
    /// construction of [`crate::AppState`] never fails. The OCSR entry is only
    /// parsed here: its artifacts, graphs and sessions stay untouched until
    /// [`Self::ocsr`] is called, and a broken OCSR entry never breaks the
    /// classifier.
    pub fn load(dir: &Path) -> Result<Self> {
        let manifest = read_manifest(dir)?;
        if manifest.schema != MANIFEST_SCHEMA {
            bail!(
                "{}: unsupported schema {}, this sidecar understands schema {MANIFEST_SCHEMA}",
                manifest_context(dir),
                manifest.schema
            );
        }

        let classifier = match manifest.models.get(CLASSIFIER_KEY) {
            Some(value) => {
                let entry: ManifestModel =
                    serde_json::from_value(value.clone()).with_context(|| {
                        format!(
                            "{}: the `{CLASSIFIER_KEY}` entry is not a valid classifier declaration",
                            manifest_context(dir)
                        )
                    })?;
                Some(load_classifier(dir, &entry)?)
            }
            None => None,
        };

        let ocsr_entry = manifest.models.get(OCSR_KEY).map(|value| {
            serde_json::from_value::<ManifestOcsrModel>(value.clone()).map_err(|error| {
                format!(
                    "{}: the `{OCSR_KEY}` entry is not a valid OCSR declaration: {error}",
                    manifest_context(dir)
                )
            })
        });

        Ok(Self {
            dir: dir.to_path_buf(),
            classifier,
            ocsr_entry,
            ocsr: OnceLock::new(),
        })
    }

    /// Returns the classifier when the manifest declares one.
    pub fn classifier(&self) -> Option<&ClassifierModel> {
        self.classifier.as_ref()
    }

    /// Returns the OCSR model when the manifest declares one.
    ///
    /// The first call verifies the encoder, decoder and vocabulary checksums,
    /// validates both graph contracts and creates the sessions; the result is
    /// cached for the process lifetime (including the error). A manifest
    /// without the OCSR key yields `Ok(None)`; a broken entry, artifact,
    /// checksum or contract is an actionable error the caller maps to HTTP 503.
    pub fn ocsr(&self) -> Result<Option<&OcsrModel>> {
        let entry = match &self.ocsr_entry {
            None => return Ok(None),
            Some(Ok(entry)) => entry,
            Some(Err(message)) => bail!("{message}"),
        };

        let cached = self.ocsr.get_or_init(|| {
            load_ocsr(&self.dir, entry)
                .map(Some)
                .map_err(|error| format!("{error:#}"))
        });

        match cached {
            Ok(model) => Ok(model.as_ref()),
            Err(message) => Err(anyhow!("{message}")),
        }
    }
}

/// Lists the provenance ids the manifest declares **and** whose artifact files
/// exist on disk, without opening a session.
///
/// This is what `/v2/health` reports: a model id only appears when every
/// artifact it requires is present (the classifier's single file, the OCSR
/// encoder + decoder + vocabulary). A missing or invalid manifest is not a
/// health failure: it logs a warning and yields an empty list.
pub fn available_model_ids(dir: &Path) -> Vec<String> {
    match read_manifest(dir) {
        Ok(manifest) if manifest.schema == MANIFEST_SCHEMA => manifest
            .models
            .values()
            .filter_map(|entry| available_model_id(dir, entry))
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

/// Returns the id of a manifest entry whose artifacts all exist on disk.
fn available_model_id(dir: &Path, entry: &serde_json::Value) -> Option<String> {
    if let Ok(classifier) = serde_json::from_value::<ManifestModel>(entry.clone()) {
        return dir
            .join(&classifier.file)
            .is_file()
            .then_some(classifier.id);
    }

    if let Ok(ocsr) = serde_json::from_value::<ManifestOcsrModel>(entry.clone()) {
        let present = [&ocsr.encoder.file, &ocsr.decoder.file, &ocsr.vocab.file]
            .iter()
            .all(|file| dir.join(file).is_file());
        return present.then_some(ocsr.id);
    }

    tracing::warn!(
        "{}: skipping a model entry that is neither a classifier nor an OCSR declaration",
        manifest_context(dir)
    );
    None
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
    verify_artifact(&artifact, &entry.artifact_sha256, "classifier", &context)?;

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

/// Verifies one artifact exists and matches its manifest SHA-256.
fn verify_artifact(
    artifact: &Path,
    expected_sha256: &str,
    label: &str,
    context: &str,
) -> Result<()> {
    if !artifact.is_file() {
        bail!(
            "{context}: {label} artifact {} is missing; download it into the model root or set CHEMISTRY_MODELS_DIR",
            artifact.display()
        );
    }

    let digest = sha256_file(artifact).with_context(|| {
        format!(
            "{context}: could not hash {label} artifact {}",
            artifact.display()
        )
    })?;
    if !digest.eq_ignore_ascii_case(expected_sha256.trim()) {
        bail!(
            "{context}: {label} artifact {} has sha256 {digest}, expected {expected_sha256}; replace the corrupted file",
            artifact.display()
        );
    }

    Ok(())
}

fn load_ocsr(dir: &Path, entry: &ManifestOcsrModel) -> Result<OcsrModel> {
    let context = manifest_context(dir);

    if entry.preprocessing != OCSR_PREPROCESSING {
        bail!(
            "{context}: OCSR model `{}` declares preprocessing `{}`, but this sidecar implements only `{OCSR_PREPROCESSING}`",
            entry.id,
            entry.preprocessing
        );
    }
    if entry.encoder.inputs.len() != 1 {
        bail!(
            "{context}: OCSR model `{}` must declare exactly one encoder input, found {}",
            entry.id,
            entry.encoder.inputs.len()
        );
    }

    let encoder_artifact = dir.join(&entry.encoder.file);
    let decoder_artifact = dir.join(&entry.decoder.file);
    let vocab_artifact = dir.join(&entry.vocab.file);
    verify_artifact(
        &encoder_artifact,
        &entry.encoder.artifact_sha256,
        "OCSR encoder",
        &context,
    )?;
    verify_artifact(
        &decoder_artifact,
        &entry.decoder.artifact_sha256,
        "OCSR decoder",
        &context,
    )?;
    verify_artifact(
        &vocab_artifact,
        &entry.vocab.artifact_sha256,
        "OCSR vocabulary",
        &context,
    )?;

    let vocab = ocsr_vocab::load(&vocab_artifact).with_context(|| {
        format!(
            "{context}: could not load the OCSR vocabulary {}",
            vocab_artifact.display()
        )
    })?;
    validate_vocab(&vocab, entry, &vocab_artifact, &context)?;

    let encoder = create_session(&encoder_artifact).with_context(|| {
        format!(
            "{context}: could not open OCSR encoder artifact {}",
            encoder_artifact.display()
        )
    })?;
    let decoder = create_session(&decoder_artifact).with_context(|| {
        format!(
            "{context}: could not open OCSR decoder artifact {}",
            decoder_artifact.display()
        )
    })?;

    let encoder_zero_inputs =
        validate_ocsr_graph(&encoder, &entry.encoder, "encoder", entry, &context)?;
    let zero_inputs = validate_ocsr_graph(&decoder, &entry.decoder, "decoder", entry, &context)?;
    if !encoder_zero_inputs.is_empty() {
        bail!(
            "{context}: OCSR model `{}` declares zero inputs on the encoder, but the encoder is fed only its image input",
            entry.id
        );
    }

    let contract = contract_from_ocsr_manifest(entry, zero_inputs)?;
    Ok(OcsrModel::new(contract, vocab, encoder, decoder))
}

/// Checks the vocabulary's special ids and class count against the manifest.
///
/// This runs before any session is created, so a mismatched vocabulary is a
/// configuration error without paying the ~316 MB graph load.
fn validate_vocab(
    vocab: &ocsr_vocab::Vocab,
    entry: &ManifestOcsrModel,
    path: &Path,
    context: &str,
) -> Result<()> {
    if vocab.start_id != entry.start_id {
        bail!(
            "{context}: OCSR vocabulary {} declares start_id {}, the manifest declares {}; replace the mismatched vocabulary",
            path.display(),
            vocab.start_id,
            entry.start_id
        );
    }
    if vocab.end_id != entry.end_id {
        bail!(
            "{context}: OCSR vocabulary {} declares end_id {}, the manifest declares {}; replace the mismatched vocabulary",
            path.display(),
            vocab.end_id,
            entry.end_id
        );
    }

    if let Some(classes) = entry
        .decoder
        .output
        .shape
        .get(2)
        .copied()
        .filter(|dimension| *dimension > 0)
    {
        if vocab.vocab_size != classes as usize {
            bail!(
                "{context}: OCSR vocabulary {} declares vocab_size {}, but the decoder output has {classes} token classes; replace the mismatched vocabulary",
                path.display(),
                vocab.vocab_size
            );
        }
    }

    Ok(())
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

fn contract_from_ocsr_manifest(
    entry: &ManifestOcsrModel,
    zero_inputs: Vec<OcsrTensorContract>,
) -> Result<OcsrContract> {
    let context = format!("OCSR model `{}`", entry.id);
    let encoder_input = entry
        .encoder
        .inputs
        .first()
        .ok_or_else(|| anyhow!("{context}: the encoder declares no input"))?;
    let decoder_tokens = entry
        .decoder
        .inputs
        .iter()
        .find(|input| input.name == DECODER_TOKENS)
        .ok_or_else(|| {
            anyhow!("{context}: the decoder does not declare the `{DECODER_TOKENS}` input")
        })?;
    let decoder_enc_out = entry
        .decoder
        .inputs
        .iter()
        .find(|input| input.name == DECODER_ENC_OUT)
        .ok_or_else(|| {
            anyhow!("{context}: the decoder does not declare the `{DECODER_ENC_OUT}` input")
        })?;

    Ok(OcsrContract {
        id: entry.id.clone(),
        encoder_input: OcsrTensorContract::from(encoder_input),
        encoder_output: OcsrTensorContract::from(&entry.encoder.output),
        decoder_tokens: OcsrTensorContract::from(decoder_tokens),
        decoder_enc_out: OcsrTensorContract::from(decoder_enc_out),
        decoder_output: OcsrTensorContract::from(&entry.decoder.output),
        zero_inputs,
        start_id: entry.start_id,
        end_id: entry.end_id,
        max_len: entry.max_len,
        confidence_threshold: entry.confidence_threshold,
    })
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

impl From<&ManifestOcsrTensor> for OcsrTensorContract {
    fn from(tensor: &ManifestOcsrTensor) -> Self {
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

/// Validates one OCSR graph against its manifest entry and returns the
/// graph-declared zero inputs (dtype and shape) for the runtime to feed.
fn validate_ocsr_graph(
    session: &Session,
    graph: &ManifestGraph,
    label: &str,
    entry: &ManifestOcsrModel,
    context: &str,
) -> Result<Vec<OcsrTensorContract>> {
    let id = &entry.id;

    for input in &graph.inputs {
        let duplicates = graph
            .inputs
            .iter()
            .filter(|other| other.name == input.name)
            .count();
        if duplicates > 1 {
            bail!(
                "{context}: OCSR {label} `{id}` declares input `{}` more than once",
                input.name
            );
        }
    }

    for zero in &graph.zero_inputs {
        if graph.inputs.iter().any(|input| input.name == *zero) {
            bail!(
                "{context}: OCSR {label} `{id}` lists `{zero}` both as a declared input and in zero_inputs"
            );
        }
        if graph
            .zero_inputs
            .iter()
            .filter(|other| *other == zero)
            .count()
            > 1
        {
            bail!("{context}: OCSR {label} `{id}` lists `{zero}` more than once in zero_inputs");
        }
    }

    let mut zero_inputs = Vec::with_capacity(graph.zero_inputs.len());
    for outlet in session.inputs() {
        let name = outlet.name();
        if let Some(declared) = graph.inputs.iter().find(|input| input.name == name) {
            compare_ocsr_tensor("input", name, outlet.dtype(), declared, label, id, context)?;
        } else if graph.zero_inputs.iter().any(|zero| zero == name) {
            let ValueType::Tensor { ty, shape, .. } = outlet.dtype() else {
                bail!("{context}: OCSR {label} `{id}` zero input `{name}` is not a tensor");
            };
            let dtype = onnx_dtype_name(*ty);
            if !ZERO_INPUT_DTYPES.contains(&dtype.as_str()) {
                bail!(
                    "{context}: OCSR {label} `{id}` zero input `{name}` has unsupported dtype `{dtype}`"
                );
            }
            zero_inputs.push(OcsrTensorContract {
                name: name.to_string(),
                dtype,
                shape: shape
                    .iter()
                    .map(|dimension| if *dimension > 0 { *dimension } else { 1 })
                    .collect(),
            });
        } else {
            bail!(
                "{context}: OCSR {label} `{id}` graph declares input `{name}` that the manifest \
                 does not declare nor list in zero_inputs"
            );
        }
    }

    for declared in &graph.inputs {
        if !session
            .inputs()
            .iter()
            .any(|outlet| outlet.name() == declared.name)
        {
            bail!(
                "{context}: OCSR {label} `{id}` manifest declares input `{}` that the graph does not",
                declared.name
            );
        }
    }
    for zero in &graph.zero_inputs {
        if !session.inputs().iter().any(|outlet| outlet.name() == zero) {
            bail!(
                "{context}: OCSR {label} `{id}` zero_inputs lists `{zero}`, which is not a graph input"
            );
        }
    }

    if session.outputs().len() != 1 {
        bail!(
            "{context}: OCSR {label} `{id}` graph has {} outputs, expected exactly one",
            session.outputs().len()
        );
    }
    let output = &session.outputs()[0];
    if output.name() != graph.output.name {
        bail!(
            "{context}: OCSR {label} `{id}` graph output is `{}`, the manifest declares `{}`",
            output.name(),
            graph.output.name
        );
    }
    compare_ocsr_tensor(
        "output",
        output.name(),
        output.dtype(),
        &graph.output,
        label,
        id,
        context,
    )?;

    Ok(zero_inputs)
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

fn compare_ocsr_tensor(
    direction: &str,
    name: &str,
    dtype: &ValueType,
    declared: &ManifestOcsrTensor,
    label: &str,
    id: &str,
    context: &str,
) -> Result<()> {
    let ValueType::Tensor { ty, shape, .. } = dtype else {
        bail!("{context}: OCSR {label} `{id}` {direction} `{name}` is not a tensor");
    };

    let graph_dtype = onnx_dtype_name(*ty);
    if graph_dtype != declared.dtype {
        bail!(
            "{context}: OCSR {label} `{id}` {direction} `{name}` has dtype `{graph_dtype}`, the manifest declares `{}`",
            declared.dtype
        );
    }

    validate_ocsr_shape(shape, &declared.shape).with_context(|| {
        format!(
            "{context}: OCSR {label} `{id}` {direction} `{name}` has shape {shape}, incompatible with the manifest shape {:?}",
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

/// Checks an OCSR graph shape against the manifest shape.
///
/// `-1` in the graph is dynamic and accepted on axis 0 (batch) or on an axis
/// the manifest itself marks with `-1` (the decoder's decode sequence). Any
/// other graph dimension must equal the manifest exactly.
pub fn validate_ocsr_shape(graph: &[i64], manifest: &[i64]) -> Result<()> {
    if graph.len() != manifest.len() {
        bail!(
            "rank {} does not match the manifest rank {}; only the batch axis and manifest-dynamic axes may be `-1`",
            graph.len(),
            manifest.len()
        );
    }

    for (axis, (graph_dimension, manifest_dimension)) in graph.iter().zip(manifest).enumerate() {
        if *graph_dimension == *manifest_dimension {
            continue;
        }
        if *graph_dimension == -1 && (*manifest_dimension == -1 || axis == 0) {
            continue;
        }
        bail!(
            "axis {axis} has graph dimension {graph_dimension}, the manifest requires {manifest_dimension}; \
             only axis 0 (batch) and a manifest-declared `-1` axis may be dynamic"
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
    models: BTreeMap<String, serde_json::Value>,
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
struct ManifestOcsrModel {
    id: String,
    preprocessing: String,
    start_id: i32,
    end_id: i32,
    max_len: usize,
    confidence_threshold: f64,
    encoder: ManifestGraph,
    decoder: ManifestGraph,
    vocab: ManifestArtifact,
}

#[derive(Debug, Deserialize)]
struct ManifestGraph {
    file: String,
    artifact_sha256: String,
    inputs: Vec<ManifestOcsrTensor>,
    #[serde(default)]
    zero_inputs: Vec<String>,
    output: ManifestOcsrTensor,
}

#[derive(Debug, Deserialize)]
struct ManifestArtifact {
    file: String,
    artifact_sha256: String,
}

#[derive(Debug, Deserialize)]
struct ManifestTensor {
    name: String,
    dtype: String,
    shape: Vec<usize>,
}

#[derive(Debug, Deserialize)]
struct ManifestOcsrTensor {
    name: String,
    dtype: String,
    shape: Vec<i64>,
}
