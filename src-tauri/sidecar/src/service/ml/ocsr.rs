//! OCSR inference: one encoder graph, one autoregressive decoder-step graph.
//!
//! [`OcsrModel`] owns the two sessions [`super::registry`] created and
//! contract-validated, plus the detokenizer. `ort::Session::run` needs
//! `&mut Session` while the registry is shared for the process lifetime, so
//! each session lives behind a [`Mutex`]: concurrent requests serialize on
//! inference instead of cloning a session or reaching for `unsafe`.
//!
//! Tensor contract (see `docs/architecture.md` section 6):
//!
//! - encoder input `image` float32 `[1, 512, 512, 3]`; output `Identity:0`
//!   float32 `[1, 256, 512]` (`enc_out`);
//! - decoder inputs `tokens` int32 `[1, seq]`, `enc_out` float32
//!   `[1, 256, 512]` and the graph-declared zero inputs; output `Identity:0`
//!   float32 `[1, seq, 156]`, already softmaxed.
//!
//! Post-processing is fixed: greedy decode ([`greedy_decode`]), detokenization,
//! digit remap, and `confidence` as the arithmetic mean of the chosen-token
//! probabilities including the final `end_id` step. Activity 8 records the
//! manifest's `confidence_threshold` but does not gate on it.

use std::sync::Mutex;
use std::time::Instant;

use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;

use crate::service::ml::ocsr_decode::{greedy_decode, OcsrGraphs};
use crate::service::ml::ocsr_preprocess::OcsrInput;
use crate::service::ml::ocsr_vocab::Vocab;
use crate::service::ml::registry::{OcsrContract, OcsrTensorContract};

/// Result of one OCSR run.
#[derive(Debug, Clone, PartialEq)]
pub struct OcsrPrediction {
    /// Detokenized, digit-remapped SMILES.
    pub smiles: String,
    /// Arithmetic mean of the chosen-token probabilities.
    pub confidence: f64,
    /// `true` when the decoder reached `max_len` without `end_id`.
    pub incomplete: bool,
}

/// An OCSR failure classified by its HTTP consequence.
#[derive(Debug, thiserror::Error)]
pub enum OcsrError {
    /// A graph no longer honours the manifest's tensor contract (HTTP 503).
    #[error("{0}")]
    Contract(String),
    /// The session could not run or returned no usable output (HTTP 500).
    #[error("{0}")]
    Inference(String),
}

/// A validated OCSR model: contract, vocabulary and both ONNX sessions.
///
/// The sessions are created once and cached for the process lifetime; the
/// mutexes only serialize calls because `ort` requires exclusive access per run.
pub struct OcsrModel {
    contract: OcsrContract,
    vocab: Vocab,
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
}

impl OcsrModel {
    /// Wraps two contract-validated sessions and a loaded vocabulary.
    pub(crate) fn new(
        contract: OcsrContract,
        vocab: Vocab,
        encoder: Session,
        decoder: Session,
    ) -> Self {
        Self {
            contract,
            vocab,
            encoder: Mutex::new(encoder),
            decoder: Mutex::new(decoder),
        }
    }

    /// Returns the validated two-graph tensor contract.
    pub fn contract(&self) -> &OcsrContract {
        &self.contract
    }

    /// Recognizes the structure in one preprocessed image.
    ///
    /// An incomplete decode is a successful prediction with
    /// [`OcsrPrediction::incomplete`] set; the transport turns it into HTTP 422.
    pub fn predict(&self, input: &OcsrInput) -> Result<OcsrPrediction, OcsrError> {
        let started = Instant::now();

        let mut encoder = self
            .encoder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut decoder = self
            .decoder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut graphs = GraphRunner {
            encoder: &mut encoder,
            decoder: &mut decoder,
            contract: &self.contract,
        };

        let (ids, probabilities, incomplete) = greedy_decode(
            &mut graphs,
            input,
            self.contract.start_id,
            self.contract.end_id,
            self.contract.max_len,
        )
        .map_err(|error| match error.downcast::<OcsrError>() {
            Ok(error) => error,
            Err(error) => OcsrError::Inference(format!("{error:#}")),
        })?;

        let smiles = self.vocab.decode_ids(&ids);
        let confidence = mean_confidence(&probabilities);

        tracing::info!(
            "OCSR inference {:.1} ms: {} tokens, confidence {confidence:.4}, {}",
            started.elapsed().as_secs_f64() * 1000.0,
            ids.len(),
            if incomplete { "incomplete" } else { "complete" }
        );

        Ok(OcsrPrediction {
            smiles,
            confidence,
            incomplete,
        })
    }
}

/// Mean of the chosen-token probabilities, including the final `end_id` step.
///
/// An empty decode (no generated token) has confidence `0`.
pub(crate) fn mean_confidence(probabilities: &[f32]) -> f64 {
    if probabilities.is_empty() {
        return 0.0;
    }
    probabilities
        .iter()
        .map(|probability| f64::from(*probability))
        .sum::<f64>()
        / probabilities.len() as f64
}

/// Borrowed view of both sessions that implements [`OcsrGraphs`].
struct GraphRunner<'a> {
    encoder: &'a mut Session,
    decoder: &'a mut Session,
    contract: &'a OcsrContract,
}

impl OcsrGraphs for GraphRunner<'_> {
    fn encode(&mut self, input: &OcsrInput) -> anyhow::Result<Vec<f32>> {
        let image = Tensor::from_array((input.shape, input.data.clone())).map_err(|error| {
            OcsrError::Inference(format!("could not build the OCSR image tensor: {error}"))
        })?;
        let inputs: Vec<(String, SessionInputValue)> =
            vec![(self.contract.encoder_input.name.clone(), image.into())];

        let outputs = self.encoder.run(inputs).map_err(|error| {
            OcsrError::Inference(format!("OCSR encoder inference failed: {error}"))
        })?;

        let name = self.contract.encoder_output.name.as_str();
        let output = outputs.get(name).ok_or_else(|| {
            OcsrError::Contract(format!(
                "the OCSR encoder did not return the manifest output `{name}`; the model \
                 artifact does not match the manifest"
            ))
        })?;
        let (_, data) = output.try_extract_tensor::<f32>().map_err(|error| {
            OcsrError::Contract(format!(
                "the OCSR encoder output `{name}` must be float32 `{:?}`: {error}",
                self.contract.encoder_output.shape
            ))
        })?;

        let expected = element_count(&self.contract.encoder_output.shape);
        if data.len() != expected {
            return Err(OcsrError::Contract(format!(
                "the OCSR encoder output `{name}` has {} values, the manifest requires {expected}",
                data.len()
            ))
            .into());
        }

        Ok(data.to_vec())
    }

    fn decode_step(&mut self, tokens: &[i32], enc_out: &[f32]) -> anyhow::Result<Vec<f32>> {
        if tokens.is_empty() {
            return Err(OcsrError::Inference(
                "the OCSR decoder must be seeded with the start id".to_string(),
            )
            .into());
        }

        let tokens_tensor = Tensor::from_array(([1_usize, tokens.len()], tokens.to_vec()))
            .map_err(|error| {
                OcsrError::Inference(format!("could not build the OCSR token tensor: {error}"))
            })?;
        let enc_shape: Vec<usize> = self
            .contract
            .decoder_enc_out
            .shape
            .iter()
            .map(|dimension| positive_dimension(*dimension))
            .collect();
        let enc_out_tensor =
            Tensor::from_array((enc_shape, enc_out.to_vec())).map_err(|error| {
                OcsrError::Inference(format!(
                    "could not build the OCSR encoder-output tensor: {error}"
                ))
            })?;

        let mut inputs: Vec<(String, SessionInputValue)> = vec![
            (
                self.contract.decoder_tokens.name.clone(),
                tokens_tensor.into(),
            ),
            (
                self.contract.decoder_enc_out.name.clone(),
                enc_out_tensor.into(),
            ),
        ];
        for zero in &self.contract.zero_inputs {
            inputs.push((zero.name.clone(), zero_tensor(zero)?));
        }

        let outputs = self.decoder.run(inputs).map_err(|error| {
            OcsrError::Inference(format!("OCSR decoder inference failed: {error}"))
        })?;

        let name = self.contract.decoder_output.name.as_str();
        let output = outputs.get(name).ok_or_else(|| {
            OcsrError::Contract(format!(
                "the OCSR decoder did not return the manifest output `{name}`; the model \
                 artifact does not match the manifest"
            ))
        })?;
        let (_, data) = output.try_extract_tensor::<f32>().map_err(|error| {
            OcsrError::Contract(format!(
                "the OCSR decoder output `{name}` must be float32 `{:?}`: {error}",
                self.contract.decoder_output.shape
            ))
        })?;

        if !data.len().is_multiple_of(tokens.len()) {
            return Err(OcsrError::Contract(format!(
                "the OCSR decoder returned {} values for a sequence of {}, which is not a whole \
                 number of probability rows",
                data.len(),
                tokens.len()
            ))
            .into());
        }
        let vocabulary = data.len() / tokens.len();
        if let Some(expected) = self
            .contract
            .decoder_output
            .shape
            .get(2)
            .copied()
            .filter(|dimension| *dimension > 0)
            .map(|dimension| dimension as usize)
        {
            if vocabulary != expected {
                return Err(OcsrError::Contract(format!(
                    "the OCSR decoder output `{name}` has {vocabulary} classes per token, the \
                     manifest requires {expected}"
                ))
                .into());
            }
        }

        Ok(data.to_vec())
    }
}

/// Builds an all-zero tensor with the dtype and shape the graph declares.
fn zero_tensor(contract: &OcsrTensorContract) -> Result<SessionInputValue<'static>, OcsrError> {
    let shape: Vec<usize> = contract
        .shape
        .iter()
        .map(|dimension| positive_dimension(*dimension))
        .collect();
    let elements: usize = shape.iter().product();

    let input: SessionInputValue = match contract.dtype.as_str() {
        "float32" => Tensor::from_array((shape, vec![0.0_f32; elements]))
            .map_err(|error| zero_input_error(contract, error))?
            .into(),
        "int32" => Tensor::from_array((shape, vec![0_i32; elements]))
            .map_err(|error| zero_input_error(contract, error))?
            .into(),
        "int64" => Tensor::from_array((shape, vec![0_i64; elements]))
            .map_err(|error| zero_input_error(contract, error))?
            .into(),
        "float64" => Tensor::from_array((shape, vec![0.0_f64; elements]))
            .map_err(|error| zero_input_error(contract, error))?
            .into(),
        other => {
            return Err(OcsrError::Contract(format!(
                "the OCSR decoder zero input `{}` declares unsupported dtype `{other}`",
                contract.name
            )));
        }
    };

    Ok(input)
}

fn zero_input_error(contract: &OcsrTensorContract, error: impl std::fmt::Display) -> OcsrError {
    OcsrError::Inference(format!(
        "could not build the OCSR zero input `{}`: {error}",
        contract.name
    ))
}

/// Product of the static dimensions of a contract shape.
fn element_count(shape: &[i64]) -> usize {
    shape
        .iter()
        .map(|dimension| positive_dimension(*dimension))
        .product()
}

/// Resolves a graph dimension for tensor construction (`-1` becomes `1`).
fn positive_dimension(dimension: i64) -> usize {
    if dimension > 0 {
        dimension as usize
    } else {
        1
    }
}
