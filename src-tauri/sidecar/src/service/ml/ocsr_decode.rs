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
//! A bounded **repetition guard** stops a pathological periodic tail early
//! (the parity pilot found a 302-step `C`, `=` loop that held the decoder for
//! 37.3 s). The guard only inspects the emitted ids: when the generated tail
//! ends with a short cycle repeated at least a configured number of times, the
//! loop breaks before another decoder step. The last id is not `end_id`, so the
//! decode stays incomplete and maps to the same transport error.
//!
//! [`OcsrGraphs`] abstracts the two graphs so the loop can be tested against a
//! deterministic fake decoder without ONNX.

use anyhow::{bail, Result};

use crate::service::ml::ocsr_preprocess::OcsrInput;

/// Bounds a periodic tail before it reaches `max_len`.
///
/// `max_cycle` is the longest cycle (in tokens) the detector considers and
/// `min_repeats` is the number of complete repetitions that fire it for a cycle
/// of two or more tokens. A one-token run is a legitimate alkane chain, so it
/// has its own, much higher threshold in `single_token_repeats`; that keeps a
/// long `C`, `C`, … run decodable while still bounding a decoder stuck on one
/// id. The production values are measured against the pilot300 hand-drawn split
/// and recorded in `docs/benchmarks/ocsr-tail-fix.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepetitionGuard {
    /// Longest cycle length, in tokens (two-token cycles and above).
    pub max_cycle: usize,
    /// Complete repetitions of a cycle of two or more tokens required to stop.
    pub min_repeats: usize,
    /// Complete repetitions of the same token required to stop (alkane tier).
    pub single_token_repeats: usize,
}

/// Guard used by [`greedy_decode`] in production.
///
/// Measured on the pilot300 hand-drawn split: the longest legitimate periodic
/// tail is 8 repeated tokens for a one-token cycle and 6 complete two-token
/// cycles (`hdm::CDK_Depict_1_23`, `O`, `)`); the pathological row
/// (`hdm::CDK_Depict_5_82`) repeats `C`, `=` 151 times.
pub const PRODUCTION_GUARD: RepetitionGuard = RepetitionGuard {
    max_cycle: 2,
    min_repeats: 16,
    single_token_repeats: 32,
};

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
///
/// Uses [`PRODUCTION_GUARD`]; call [`greedy_decode_with_guard`] to pin another
/// guard in a test.
pub fn greedy_decode<G: OcsrGraphs + ?Sized>(
    graphs: &mut G,
    input: &OcsrInput,
    start_id: i32,
    end_id: i32,
    max_len: usize,
) -> Result<DecodeResult> {
    greedy_decode_with_guard(graphs, input, start_id, end_id, max_len, PRODUCTION_GUARD)
}

/// Decodes `input` greedily until `end_id`, `max_len` steps or a periodic tail.
///
/// After appending a non-`end_id` token, the generated tail is checked for a
/// one-token run of `guard.single_token_repeats` tokens or a cycle of
/// `2..=guard.max_cycle` tokens repeated at least `guard.min_repeats` times. On
/// a match the loop stops with the ids generated so far; the last id is not
/// `end_id`, so the decode is incomplete. `end_id` always wins: the guard is
/// only evaluated after a non-`end_id` token.
pub fn greedy_decode_with_guard<G: OcsrGraphs + ?Sized>(
    graphs: &mut G,
    input: &OcsrInput,
    start_id: i32,
    end_id: i32,
    max_len: usize,
    guard: RepetitionGuard,
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
        if has_periodic_tail(&ids[1..], guard) {
            break;
        }
    }

    let incomplete = ids.last() != Some(&end_id);
    Ok((ids, probabilities, incomplete))
}

/// Returns `true` when `tail` ends with a cycle repeated at least its threshold:
/// one token at `guard.single_token_repeats`, or `2..=guard.max_cycle` tokens at
/// `guard.min_repeats`.
///
/// Only the shortest period is considered for a given suffix: an all-equal run
/// is a one-token cycle, not a longer one. A repeat threshold of zero disables
/// that tier.
fn has_periodic_tail(tail: &[i32], guard: RepetitionGuard) -> bool {
    if guard.max_cycle == 0 {
        return false;
    }

    if guard.single_token_repeats > 0 && tail.len() >= guard.single_token_repeats {
        let recent = &tail[tail.len() - guard.single_token_repeats..];
        if recent.iter().all(|id| *id == recent[0]) {
            return true;
        }
    }

    for cycle in 2..=guard.max_cycle {
        if guard.min_repeats == 0 {
            break;
        }
        let span = cycle * guard.min_repeats;
        if tail.len() < span {
            continue;
        }
        let recent = &tail[tail.len() - span..];
        let pattern = &recent[span - cycle..];
        if recent.chunks_exact(cycle).all(|chunk| chunk == pattern) {
            return true;
        }
    }

    false
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
