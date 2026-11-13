//! `vocab.json` loading and detokenization for the OCSR decoder.
//!
//! The vocabulary is the `decimer-tokenizer-v1` export: two maps
//! (`token_to_id` and `id_to_token`) plus the special token ids. Decoding skips
//! the pad, start and end ids, concatenates the remaining tokens and applies
//! DECIMER's digit remap **after** token lookup: `! $ ^ < > ? £ ¢ € §` become
//! `1 2 3 4 5 6 7 8 9 0`. The remap changes the SMILES text only; it never
//! changes token ids.
//!
//! A corrupted, truncated or substituted vocabulary is a configuration error
//! (HTTP 503): the manifest records its SHA-256 and [`super::registry`] verifies
//! it before this module reads the file. Malformed JSON here is reported with
//! the file path in the error.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

/// Token emitted when an id is absent from `id_to_token`, mirroring the runtime.
const UNKNOWN_TOKEN: &str = "<unk>";

/// A loaded `decimer-tokenizer-v1` vocabulary.
#[derive(Debug, Clone)]
pub struct Vocab {
    /// Token text by id.
    pub id_to_token: HashMap<i32, String>,
    /// Token id by text.
    pub token_to_id: HashMap<String, i32>,
    /// Padding token id, skipped when decoding.
    pub pad_id: i32,
    /// Start-of-sequence token id, skipped when decoding.
    pub start_id: i32,
    /// End-of-sequence token id, skipped when decoding.
    pub end_id: i32,
    /// Unknown token id, kept for parity with the exported vocabulary.
    pub unk_id: i32,
    /// Declared vocabulary size.
    pub vocab_size: usize,
}

impl Vocab {
    /// Reads and parses a `vocab.json` file.
    ///
    /// The error names the file for every failure (unreadable, invalid JSON, a
    /// missing map or a non-numeric id key).
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("could not read vocabulary {}", path.display()))?;
        let file: VocabFile = serde_json::from_str(&raw).with_context(|| {
            format!(
                "could not parse vocabulary {} as a decimer-tokenizer-v1 vocabulary",
                path.display()
            )
        })?;

        let mut id_to_token = HashMap::with_capacity(file.id_to_token.len());
        for (key, token) in file.id_to_token {
            let id: i32 = key.parse().with_context(|| {
                format!(
                    "vocabulary {}: id_to_token key `{key}` is not a token id",
                    path.display()
                )
            })?;
            id_to_token.insert(id, token);
        }

        Ok(Self {
            id_to_token,
            token_to_id: file.token_to_id,
            pad_id: file.pad_id,
            start_id: file.start_id,
            end_id: file.end_id,
            unk_id: file.unk_id,
            vocab_size: file.vocab_size,
        })
    }

    /// Detokenizes generated ids into SMILES text.
    ///
    /// Pad, start and end ids are skipped; a digit remap is applied to the
    /// concatenated result.
    pub fn decode_ids(&self, ids: &[i32]) -> String {
        let special = [self.pad_id, self.start_id, self.end_id];
        let mut text = String::new();
        for id in ids {
            if special.contains(id) {
                continue;
            }
            text.push_str(
                self.id_to_token
                    .get(id)
                    .map(String::as_str)
                    .unwrap_or(UNKNOWN_TOKEN),
            );
        }
        remap_digits(&text)
    }
}

/// Reads and parses a `vocab.json` file. See [`Vocab::load`].
pub fn load(path: &Path) -> Result<Vocab> {
    Vocab::load(path)
}

/// Applies DECIMER's post-lookup digit remap.
fn remap_digits(text: &str) -> String {
    text.chars()
        .map(|token| match token {
            '!' => '1',
            '$' => '2',
            '^' => '3',
            '<' => '4',
            '>' => '5',
            '?' => '6',
            '£' => '7',
            '¢' => '8',
            '€' => '9',
            '§' => '0',
            other => other,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct VocabFile {
    token_to_id: HashMap<String, i32>,
    id_to_token: HashMap<String, String>,
    pad_id: i32,
    start_id: i32,
    end_id: i32,
    #[serde(default = "default_unknown_id")]
    unk_id: i32,
    #[serde(default)]
    vocab_size: usize,
}

fn default_unknown_id() -> i32 {
    1
}
