//! Image-classifier inference: one image tensor, two zero tensors, one logit.
//!
//! [`ClassifierModel`] owns the ONNX session that [`super::registry`] created
//! and contract-validated. `ort::Session::run` needs `&mut Session` while the
//! registry is shared through [`crate::AppState`] for the process lifetime, so
//! the session lives behind a [`Mutex`]: concurrent requests serialize on
//! inference instead of cloning a session or reaching for `unsafe`.
//!
//! The graph takes exactly three float32 inputs:
//!
//! - `input_2`, shape `[1, 224, 224, 3]`: the preprocessed image;
//! - `45214:0` and `45216:0`, shape `[1, 1, 1, 3]`: auxiliary zeros.
//!
//! The single float32 output `Identity:0` is one logit. Post-processing is
//! fixed: `score = sigmoid(logit)` and the image is `structure` when
//! `score <= threshold`, with the threshold read from `manifest.json`.

use std::sync::Mutex;
use std::time::Instant;

use ort::session::Session;
use ort::value::Tensor;

use crate::service::ml::preprocess::ClassifierInput;
use crate::service::ml::registry::ClassifierContract;

/// Main image input tensor of the classifier graph.
const IMAGE_INPUT: &str = "input_2";
/// Auxiliary zero inputs of the classifier graph.
const AUXILIARY_INPUTS: [&str; 2] = ["45214:0", "45216:0"];
/// Shape of each auxiliary zero tensor.
const AUXILIARY_SHAPE: [usize; 4] = [1, 1, 1, 3];

/// Result of one classifier run.
#[derive(Debug, Clone, Copy)]
pub struct Classification {
    /// Raw float32 logit emitted by `Identity:0`.
    pub logit: f32,
    /// `sigmoid(logit)` as `f64`.
    pub score: f64,
    /// `true` when `score <= threshold`, otherwise `false`.
    pub contains_molecule: bool,
}

/// A classifier failure classified by its HTTP consequence.
#[derive(Debug, thiserror::Error)]
pub enum ClassifyError {
    /// The graph no longer honours the manifest's tensor contract (HTTP 503).
    #[error("{0}")]
    Contract(String),
    /// The session could not run or returned no usable output (HTTP 500).
    #[error("{0}")]
    Inference(String),
}

/// A validated classifier: manifest contract, threshold and ONNX session.
///
/// The session is created once and cached for the process lifetime; the mutex
/// only serializes calls because `ort` requires exclusive access per run.
pub struct ClassifierModel {
    contract: ClassifierContract,
    threshold: f64,
    session: Mutex<Session>,
}

impl ClassifierModel {
    /// Wraps a contract-validated session as a reusable classifier.
    pub(crate) fn new(contract: ClassifierContract, threshold: f64, session: Session) -> Self {
        Self {
            contract,
            threshold,
            session: Mutex::new(session),
        }
    }

    /// Returns the validated tensor contract.
    pub fn contract(&self) -> &ClassifierContract {
        &self.contract
    }

    /// Returns the decision threshold declared in the manifest.
    pub fn threshold(&self) -> f64 {
        self.threshold
    }

    /// Runs the classifier on one preprocessed image.
    ///
    /// `score = sigmoid(logit)`; `structure` means `score <= threshold`.
    pub fn classify(&self, input: ClassifierInput) -> Result<Classification, ClassifyError> {
        let started = Instant::now();

        let image = Tensor::from_array((input.shape, input.data)).map_err(|error| {
            ClassifyError::Inference(format!(
                "could not build the classifier image tensor: {error}"
            ))
        })?;
        let auxiliary = || -> Result<Tensor<f32>, ClassifyError> {
            Tensor::from_array((
                AUXILIARY_SHAPE,
                vec![0.0_f32; AUXILIARY_SHAPE.iter().product()],
            ))
            .map_err(|error| {
                ClassifyError::Inference(format!(
                    "could not build an auxiliary classifier tensor: {error}"
                ))
            })
        };

        let inputs = ort::inputs![
            IMAGE_INPUT => image,
            AUXILIARY_INPUTS[0] => auxiliary()?,
            AUXILIARY_INPUTS[1] => auxiliary()?,
        ];

        let mut session = self
            .session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let outputs = session.run(inputs).map_err(|error| {
            ClassifyError::Inference(format!("classifier inference failed: {error}"))
        })?;

        let output_name = self.contract.output.name.as_str();
        let output = outputs.get(output_name).ok_or_else(|| {
            ClassifyError::Contract(format!(
                "classifier graph did not return the manifest output `{output_name}`; \
                 the model artifact does not match the manifest"
            ))
        })?;
        let logit = output.try_extract_scalar::<f32>().map_err(|error| {
            ClassifyError::Contract(format!(
                "classifier output `{output_name}` must be exactly one float32 logit: {error}"
            ))
        })?;

        let score = sigmoid(f64::from(logit));
        let contains_molecule = score <= self.threshold;

        tracing::info!(
            "classifier inference {:.1} ms: logit {logit:.4}, score {score:.8}, {}",
            started.elapsed().as_secs_f64() * 1000.0,
            if contains_molecule {
                "structure"
            } else {
                "no-structure"
            }
        );

        Ok(Classification {
            logit,
            score,
            contains_molecule,
        })
    }
}

/// Maps a logit to a probability in `0.0..=1.0`.
fn sigmoid(logit: f64) -> f64 {
    1.0 / (1.0 + (-logit).exp())
}
