//! Recognize Molecule pipeline: filter gate → OCSR → SMILES → V2000 molfile.
//!
//! Ketcher's built-in Recognize control speaks the Imago job protocol, so the
//! sidecar runs the local models behind that route pair. This module owns the
//! decision logic between the ML stages and Indigo:
//!
//! 1. the classifier's binary verdict is a hard gate — `no-structure` fails
//!    with [`RecognitionFailure::NoMolecule`] before OCSR runs;
//! 2. an incomplete decode or a confidence below the manifest threshold fails
//!    with [`RecognitionFailure::LowConfidence`]; a truncated SMILES is never
//!    converted;
//! 3. Indigo converts the SMILES to a V2000 molfile; a conversion error fails
//!    with [`RecognitionFailure::Conversion`].
//!
//! The pure gates ([`accept_prediction`], [`accept_conversion`]) are separated
//! from inference so the outcome mapping is unit-tested without a model. Every
//! failure message is UI copy: the frontend matches the documented strings
//! verbatim, so they must not drift.

use std::path::Path;
use std::sync::Arc;

use crate::error::AppError;
use crate::service::indigo_ops;
use crate::service::jobs::TIMEOUT_MESSAGE;
use crate::service::ml::ocsr::OcsrPrediction;
use crate::service::ml::ocsr_preprocess::ocsr_input;
use crate::service::ml::preprocess::classifier_input;
use crate::service::ml::registry::ModelRegistry;

/// Indigo output format of the molfile Ketcher receives.
const MOLFILE_FORMAT: &str = "chemical/x-mdl-molfile";

/// Why the Recognize pipeline could not produce a molfile.
///
/// Each variant maps to one documented UI string; the frontend matches the
/// message verbatim, so a new variant requires a UI mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecognitionFailure {
    /// The classifier decided the image contains no chemical structure.
    NoMolecule,
    /// The OCSR decode was truncated or its confidence is below the threshold.
    LowConfidence,
    /// The classifier or OCSR model is missing, corrupt or unusable.
    ModelUnavailable,
    /// Indigo could not turn the recognized SMILES into a molfile.
    Conversion,
    /// The bytes could not be decoded as a bounded PNG, JPEG or WebP image.
    UnsupportedImage,
    /// The job stayed pending until its TTL expired.
    Timeout,
}

impl RecognitionFailure {
    /// Returns the documented user-facing message for this failure.
    pub fn message(&self) -> &'static str {
        match self {
            Self::NoMolecule => "No molecule was detected in this image.",
            Self::LowConfidence => {
                "The structure could not be read confidently. Try a sharper or larger image."
            }
            Self::ModelUnavailable => {
                "Recognition models are not available. Check the model setup."
            }
            Self::Conversion => {
                "The recognized structure could not be prepared for the editor. Try again."
            }
            Self::UnsupportedImage => "Unsupported image. Use a PNG, JPEG or WebP file.",
            Self::Timeout => TIMEOUT_MESSAGE,
        }
    }
}

/// Builds the model-unavailable job error: the documented copy plus the
/// actionable model-root hint.
///
/// The base sentence is the UI contract; the hint names `CHEMISTRY_MODELS_DIR`
/// because that is the only way an operator can point the sidecar at a valid
/// model store.
pub fn model_unavailable_message(models_dir: &Path) -> String {
    format!(
        "{} Set CHEMISTRY_MODELS_DIR to a model root that declares the image-classifier \
         and OCSR models (current model root: {}).",
        RecognitionFailure::ModelUnavailable.message(),
        models_dir.display()
    )
}

/// Applies the filter gate and the OCSR confidence gate to one prediction.
///
/// The filter is checked first: a confident OCSR result must never rescue a
/// `no-structure` verdict. The threshold is inclusive.
pub fn accept_prediction(
    contains_molecule: bool,
    prediction: &OcsrPrediction,
    threshold: f64,
) -> Result<String, RecognitionFailure> {
    if !contains_molecule {
        return Err(RecognitionFailure::NoMolecule);
    }
    if prediction.incomplete || prediction.confidence < threshold {
        return Err(RecognitionFailure::LowConfidence);
    }
    Ok(prediction.smiles.clone())
}

/// Maps the SMILES → molfile conversion result to the last pipeline gate.
pub fn accept_conversion(result: Result<String, AppError>) -> Result<String, RecognitionFailure> {
    match result {
        Ok(molfile) => Ok(molfile),
        Err(error) => {
            tracing::warn!("recognition could not convert the SMILES to a molfile: {error}");
            Err(RecognitionFailure::Conversion)
        }
    }
}

/// Runs the full pipeline on one uploaded image.
///
/// Blocking: ONNX Runtime and Indigo are synchronous, so callers run this
/// inside [`tokio::task::spawn_blocking`]. The bytes are decoded twice on
/// purpose (classifier and OCSR need different preprocessing); a decode failure
/// is [`RecognitionFailure::UnsupportedImage`], and the filter gate fails
/// before the OCSR pair is loaded.
///
/// `load_registry` is called only after the image decodes, so malformed input is
/// reported as the unsupported image even when no model is installed. That
/// mirrors the single-image endpoints, which validate the image before
/// resolving the model.
pub fn recognize<F>(image: &[u8], load_registry: F) -> Result<String, RecognitionFailure>
where
    F: FnOnce() -> Result<Arc<ModelRegistry>, RecognitionFailure>,
{
    let classifier_input = classifier_input(image).map_err(|error| {
        tracing::warn!("recognition could not decode the image: {error:#}");
        RecognitionFailure::UnsupportedImage
    })?;

    let registry = load_registry()?;
    let classifier = registry
        .classifier()
        .ok_or(RecognitionFailure::ModelUnavailable)?;
    let classification = classifier.classify(classifier_input).map_err(|error| {
        tracing::warn!("recognition classifier is unusable: {error}");
        RecognitionFailure::ModelUnavailable
    })?;
    if !classification.contains_molecule {
        return Err(RecognitionFailure::NoMolecule);
    }

    let ocsr_input = ocsr_input(image).map_err(|error| {
        tracing::warn!("recognition could not preprocess the image for OCSR: {error:#}");
        RecognitionFailure::UnsupportedImage
    })?;
    let ocsr = registry
        .ocsr()
        .map_err(|error| {
            tracing::warn!("recognition OCSR model is unusable: {error:#}");
            RecognitionFailure::ModelUnavailable
        })?
        .ok_or(RecognitionFailure::ModelUnavailable)?;
    let prediction = ocsr.predict(&ocsr_input).map_err(|error| {
        tracing::warn!("recognition OCSR inference failed: {error}");
        RecognitionFailure::ModelUnavailable
    })?;

    let smiles = accept_prediction(
        classification.contains_molecule,
        &prediction,
        ocsr.contract().confidence_threshold,
    )?;

    accept_conversion(indigo_ops::convert(&smiles, MOLFILE_FORMAT))
}
