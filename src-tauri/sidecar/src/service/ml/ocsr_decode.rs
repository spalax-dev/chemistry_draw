//! Greedy autoregressive decoding over the OCSR encoder/decoder pair.
//!
//! The encoder runs exactly once per image and produces `enc_out`. The decoder
//! then runs once per emitted token: it is seeded with `[start_id]`, receives
//! the whole token sequence plus the unchanged `enc_out`, and its last position
//! holds the `[vocab]` probability row for the next token. The decoder output is
//! already softmaxed, so `argmax` is taken directly and softmax is never applied
//! again.
//!
//! The loop stops after appending `end_id` or after `max_len` decoding steps.
//! `incomplete` is `true` when the last id is not `end_id`, which is what the
//! transport maps to HTTP 422: a truncated structure is not a result.
//!
//! [`OcsrGraphs`] abstracts the two graphs so the loop can be tested against a
//! deterministic fake decoder without ONNX.

use anyhow::{bail, Result};

use crate::service::ml::ocsr_preprocess::OcsrInput;

/// The encoder and decoder-step graphs the greedy loop drives.
pub trait OcsrGraphs {
    /// Runs the encoder once and returns the flattened features (`enc_out`).
    fn encode(&mut self, input: &OcsrInput) -> Result<Vec<f32>>;

    /// Runs one decoder step and returns the flattened `[seq, vocab]` probabilities.
    fn decode_step(&mut self, tokens: &[i32], enc_out: &[f32]) -> Result<Vec<f32>>;
}

/// Result of a greedy decode.
pub type DecodeResult = (Vec<i32>, Vec<f32>, bool);

/// Decodes `input` greedily until `end_id` or `max_len` steps.
///
/// Returns the token ids (including `start_id`), one chosen probability per
/// generated token (including the final `end_id` step) and whether the decode
/// ended without `end_id`.
pub fn greedy_decode<G: OcsrGraphs + ?Sized>(
    graphs: &mut G,
    input: &OcsrInput,
    start_id: i32,
    end_id: i32,
    max_len: usize,
) -> Result<DecodeResult> {
    let enc_out = graphs.encode(input)?;
    let mut ids = vec![start_id];
    let mut probabilities = Vec::with_capacity(max_len);

    for _ in 0..max_len {
        let output = graphs.decode_step(&ids, &enc_out)?;
        let row = last_row(&output, ids.len())?;
        let (token, probability) = argmax(row);

        ids.push(token);
        probabilities.push(probability);
        if token == end_id {
            break;
        }
    }

    let incomplete = ids.last() != Some(&end_id);
    Ok((ids, probabilities, incomplete))
}

/// Returns the last position's probability row.
fn last_row(output: &[f32], sequence: usize) -> Result<&[f32]> {
    if sequence == 0 || output.is_empty() {
        bail!("the decoder returned no probabilities for a non-empty token sequence");
    }
    if !output.len().is_multiple_of(sequence) {
        bail!(
            "the decoder returned {} values for a sequence of {sequence}, which is not a whole \
             number of probability rows",
            output.len()
        );
    }

    let vocabulary = output.len() / sequence;
    Ok(&output[(sequence - 1) * vocabulary..])
}

/// Returns the highest-probability token id and its probability (first wins on ties).
fn argmax(row: &[f32]) -> (i32, f32) {
    let mut best_id = 0;
    let mut best_probability = f32::NEG_INFINITY;

    for (id, probability) in row.iter().enumerate() {
        if *probability > best_probability {
            best_id = id;
            best_probability = *probability;
        }
    }

    (best_id as i32, best_probability)
}
