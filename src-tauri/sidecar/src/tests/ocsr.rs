// Tests for OCSR inference (`POST /v2/ocsr/recognize`), the `decimer_ocsr`
// preprocessing pipeline, the vocabulary/detokenizer and greedy decoding.
//
// The 316 MB encoder/decoder pair is gitignored and absent in CI, so the suite
// keeps the same two-tier split as the classifier:
//
// - always run (no model): preprocessing units, vocabulary parsing and greedy
//   decoding against a deterministic fake decoder, plus the 400/413/503
//   endpoint paths and the health presence rules;
// - model-gated (`#[ignore = "requires local ONNX model"]`): the two-graph
//   tensor contract, a real structure fixture and health listing both ids.
//   Because the OCSR artifacts can be absent while the classifier is present,
//   each gated test self-skips at runtime when the three files are missing.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use axum::response::IntoResponse;
use image::{GrayImage, Luma};
use png::{BitDepth, ColorType};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::service::ml::ocsr::{mean_confidence, OcsrModel, OcsrPrediction};
use crate::service::ml::ocsr_decode::{greedy_decode, OcsrGraphs};
use crate::service::ml::ocsr_preprocess::{crop_empty_borders, ocsr_input, OcsrInput};
use crate::service::ml::ocsr_vocab::{load as load_vocab, Vocab};
use crate::service::ml::preprocess::MAX_IMAGE_SIDE;
use crate::service::ml::registry::{validate_ocsr_shape, ModelRegistry};
use crate::tests::*;
use crate::transport::ocsr::{ensure_complete, MAX_BODY_BYTES};

// ── Constants ─────────────────────────────────────────────────

/// Side length of the square OCSR input tensor.
const SIDE: usize = 512;
/// Number of colour channels of the OCSR input tensor.
const CHANNELS: usize = 3;
/// Vocabulary size declared by the decoder output (`[1, seq, 156]`).
const VOCAB_SIZE: usize = 156;
/// Flattened length of the encoder output `[1, 256, 512]`.
const ENCODER_OUTPUT_LEN: usize = 256 * 512;
/// First token fed to the decoder.
const START_ID: i32 = 13;
/// Token that terminates a complete decode.
const END_ID: i32 = 14;
/// Maximum number of decoding steps before the structure is truncated.
const MAX_DECODE_STEPS: usize = 302;
/// ImageNet mean used by the `decimer_ocsr` normalization step.
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet standard deviation used by the `decimer_ocsr` normalization step.
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Provenance id echoed by the endpoint and reported by health.
const OCSR_MODEL_ID: &str = "ocsr-handdrawn@zenodo:10781330";
/// Exact SMILES the real model decodes from `caffeine.png`.
const CAFFEINE_SMILES: &str = "CN1C=NC2=C1C(=O)N(C)C(=O)N2C";
/// Classifier provenance id reported by health.
const CLASSIFIER_MODEL_ID: &str = "image-classifier@Iagea/d21f4cb";
/// Classifier artifact path inside the model root.
const CLASSIFIER_ARTIFACT: &str = "image-classifier-fp16/classifier.fp16.onnx";
/// OCSR encoder artifact path inside the model root.
const ENCODER_ARTIFACT: &str = "ocsr-handdrawn-fp32/encoder.onnx";
/// OCSR decoder-step artifact path inside the model root.
const DECODER_ARTIFACT: &str = "ocsr-handdrawn-fp32/decoder_step.onnx";
/// OCSR vocabulary artifact path inside the model root.
const VOCAB_ARTIFACT: &str = "ocsr-handdrawn-fp32/vocab.json";

// ── Helpers ───────────────────────────────────────────────────

fn encode_png(width: u32, height: u32, color: ColorType, data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(color);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .expect("in-memory PNG header must encode");
        writer
            .write_image_data(data)
            .expect("in-memory PNG data must encode");
    }
    bytes
}

fn png_rgb(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&pixel(x, y));
        }
    }
    encode_png(width, height, ColorType::Rgb, &data)
}

fn png_rgba(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&pixel(x, y));
        }
    }
    encode_png(width, height, ColorType::Rgba, &data)
}

/// Reads one NHWC pixel from the preprocessed tensor.
fn pixel(input: &OcsrInput, x: usize, y: usize) -> [f32; 3] {
    let index = (y * SIDE + x) * CHANNELS;
    [
        input.data[index],
        input.data[index + 1],
        input.data[index + 2],
    ]
}

/// Recovers the `0..=255` channel value the pipeline produced before the
/// ImageNet normalization.
fn unnormalize(value: f32, channel: usize) -> f32 {
    (value * IMAGENET_STD[channel] + IMAGENET_MEAN[channel]) * 255.0
}

fn unnormalized(pixel: [f32; 3]) -> [f32; 3] {
    [
        unnormalize(pixel[0], 0),
        unnormalize(pixel[1], 1),
        unnormalize(pixel[2], 2),
    ]
}

/// A pixel the final canvas painted white.
fn is_white(pixel: [f32; 3]) -> bool {
    unnormalized(pixel).iter().all(|value| *value > 240.0)
}

/// A pixel the pipeline mapped to black.
fn is_black(pixel: [f32; 3]) -> bool {
    unnormalized(pixel).iter().all(|value| *value < 80.0)
}

/// Loads a fixture committed under `src-tauri/sidecar/fixtures/`.
fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("missing fixture {path:?}: {error}"))
}

/// Returns the actionable `error` field of an error response.
fn error_message(body: &Value) -> &str {
    body["error"].as_str().unwrap_or("")
}

async fn post_ocsr(app: &axum::Router, media_type: &str, body: Vec<u8>) -> (StatusCode, Value) {
    post_bytes(app, "/v2/ocsr/recognize", media_type, body).await
}

/// Unique temporary directory, removed when the test finishes.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "chemistry-draw-ocsr-{}-{label}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("could not create {path:?}: {error}"));
        Self { path }
    }

    fn path(&self) -> PathBuf {
        self.path.clone()
    }

    /// Writes `contents` at `relative` and returns the full path.
    fn write(&self, relative: &str, contents: &[u8]) -> PathBuf {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .unwrap_or_else(|error| panic!("could not create {parent:?}: {error}"));
        }
        std::fs::write(&path, contents)
            .unwrap_or_else(|error| panic!("could not write {path:?}: {error}"));
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ── Preprocessing (no model) ─────────────────────────────────

#[test]
fn ocsr_input_returns_nhwc_512_shape() {
    // A black..white gradient keeps the contrast stretch the identity.
    let png = png_rgb(64, 64, |x, _y| {
        let value = (x * 255 / 63) as u8;
        [value, value, value]
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, CHANNELS]);
    assert_eq!(input.data.len(), SIDE * SIDE * CHANNELS);
    assert!(
        input.data.iter().all(|value| value.is_finite()),
        "the tensor must contain only finite values"
    );
    assert!(
        input.data.iter().all(|value| (-2.5..=2.75).contains(value)),
        "the ImageNet-normalized tensor must stay close to 0, not the 0..=255 range"
    );
}

#[test]
fn ocsr_input_flattens_transparency_on_white() {
    // A 40x40 opaque black square on a fully transparent red background. If
    // transparency were composited on black (or ignored), the background would
    // become dark; it must become white.
    let png = png_rgba(100, 100, |x, y| {
        if (30..70).contains(&x) && (30..70).contains(&y) {
            [0, 0, 0, 255]
        } else {
            [255, 0, 0, 0]
        }
    });

    let input = ocsr_input(&png).expect("a valid RGBA PNG must preprocess");

    assert!(
        is_black(pixel(&input, 256, 256)),
        "the opaque black square must stay black after the pipeline"
    );
    assert!(
        is_white(pixel(&input, 20, 20)),
        "a transparent pixel must be composited on white, not black or red"
    );
}

#[test]
fn ocsr_input_applies_bgr_grey_quirk() {
    // One black and one white reference column keep every channel's contrast
    // stretch the identity; the remaining columns are pure red and pure blue.
    // The BGR2GRAY quirk weighs red with 0.114 and blue with 0.299, so pure red
    // must come out much darker than pure blue (the correct Rec.601 weights
    // would invert the relation).
    let png = png_rgb(100, 100, |x, _y| match x {
        0 => [0, 0, 0],
        1..=49 => [255, 0, 0],
        50..=98 => [0, 0, 255],
        _ => [255, 255, 255],
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    let red = pixel(&input, 150, 256);
    let blue = pixel(&input, 380, 256);
    let red_level = unnormalized(red)[0];
    let blue_level = unnormalized(blue)[0];

    assert!(
        (5.0..=25.0).contains(&red_level),
        "pure red must use the BGR blue weight 0.114, got grey {red_level}"
    );
    assert!(
        (120.0..=180.0).contains(&blue_level),
        "pure blue must use the BGR red weight 0.299, got grey {blue_level}"
    );
    assert!(
        blue_level > 4.0 * red_level,
        "the swapped weights make red much darker than blue: red {red_level}, blue {blue_level}"
    );
    for (name, sample) in [("red", red), ("blue", blue)] {
        let [r, g, b] = unnormalized(sample);
        assert!(
            (r - g).abs() < 1.5 && (g - b).abs() < 1.5,
            "the {name} column must stay grayscale, got levels {r}, {g} and {b}"
        );
    }
}

#[test]
fn ocsr_input_applies_a_non_identity_contrast_stretch() {
    // Reference derived with NumPy 2.5.4 (the Python toolchain this pipeline
    // ports): compositing on white makes every alpha 255, so min = 150 and
    // max = 255 give a 105-wide range and
    // `np.linspace(0, 255, 106, dtype=np.uint8)[21]` is 50. Integer floor
    // division (`21 * 255 / 105`) would give 51. The 512x512 image has a
    // 480x480 square of grey 171 on a 255 background plus a 10x10 patch of 150
    // that sets the minimum. After the stretch (171 -> 50), the BGR2GRAY quirk
    // keeps grey unchanged, the contrast mean is 75 and `Contrast(1.8)` maps
    // 50 -> 30; brightness x1.6 then gives 48 (integer floor would give 49).
    // The centre pixel sits in the uniform square, away from every edge, so the
    // final LANCZOS resize keeps the value.
    let png = png_rgb(512, 512, |x, y| {
        if (16..496).contains(&x) && (16..496).contains(&y) {
            let value = if (20..30).contains(&x) && (20..30).contains(&y) {
                150
            } else {
                171
            };
            [value, value, value]
        } else {
            [255, 255, 255]
        }
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    let centre = unnormalized(pixel(&input, 256, 256))[0];
    assert!(
        (centre - 48.0).abs() < 0.5,
        "the NumPy linspace LUT must map 171 to 50 and the pipeline to 48, got {centre} \
         (integer floor division would give 49)"
    );
}

#[test]
fn ocsr_crop_keeps_an_all_background_image_unchanged() {
    // Every pixel is brighter than the 200 background threshold, including the
    // two deliberately non-uniform samples: the crop must return the image
    // untouched, not an empty or one-pixel box.
    let mut image = GrayImage::from_pixel(7, 5, Luma([240]));
    image.put_pixel(0, 0, Luma([201]));
    image.put_pixel(6, 4, Luma([255]));

    let cropped = crop_empty_borders(&image);

    assert_eq!(cropped.dimensions(), (7, 5));
    for (x, y, pixel) in image.enumerate_pixels() {
        assert_eq!(
            cropped.get_pixel(x, y),
            pixel,
            "the all-background image changed at ({x}, {y})"
        );
    }
}

#[test]
fn ocsr_input_rejects_an_extreme_aspect_ratio() {
    // 12,000 x 1 is inside the per-side cap, but the central canvas would be
    // int(1.2 * 12,000) = 14,400 px per side, above the 8,192 px bound.
    let png = png_rgb(MAX_IMAGE_SIDE, 1, |_x, _y| [0, 0, 0]);

    let error = ocsr_input(&png).expect_err("a canvas over 8,192 px per side must be rejected");

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("extreme aspect ratio"),
        "the error must explain the aspect-ratio bound, got: {message}"
    );
    assert!(
        message.contains("8192") && message.contains("14400"),
        "the error must name the 8,192 px limit and the 14,400 px canvas, got: {message}"
    );
}

#[test]
fn ocsr_input_resizes_small_square_to_512() {
    // A 300x300 square with side < 512 is first scaled to 512x512, so its
    // centred 100x100 black square becomes ~171x171 before the border crop.
    let png = png_rgb(300, 300, |x, y| {
        if (100..200).contains(&x) && (100..200).contains(&y) {
            [0, 0, 0]
        } else {
            [255, 255, 255]
        }
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, CHANNELS]);
    assert!(
        is_black(pixel(&input, 256, 256)),
        "the black square must be centred after the crop"
    );
    assert!(
        is_black(pixel(&input, 316, 256)),
        "the square must span ~171 px after the 300 -> 512 resize"
    );
    assert!(
        is_white(pixel(&input, 356, 256)),
        "the square must not span more than ~171 px without the documented resize"
    );
    assert!(
        is_black(pixel(&input, 256, 316)) && is_white(pixel(&input, 256, 356)),
        "the square must stay square vertically"
    );
}

#[test]
fn ocsr_input_keeps_large_images() {
    // 1024x768 has a side >= 512, so the pipeline must not resize it first. A
    // 100x100 black square must therefore stay 100 px wide; a resize by
    // 512/1024 would shrink it to 50 px.
    let png = png_rgb(1024, 768, |x, y| {
        if (462..562).contains(&x) && (334..434).contains(&y) {
            [0, 0, 0]
        } else {
            [255, 255, 255]
        }
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, CHANNELS]);
    assert!(
        is_black(pixel(&input, 256, 256)),
        "the black square must be centred after the border crop"
    );
    assert!(
        is_black(pixel(&input, 296, 256)),
        "an unresized 100x100 square keeps a half width of 50 px"
    );
    assert!(
        is_white(pixel(&input, 316, 256)),
        "a resized 50x50 square would stop before +60 px"
    );
    assert!(
        is_black(pixel(&input, 256, 296)) && is_white(pixel(&input, 256, 316)),
        "the unresized square must stay square vertically"
    );
    assert!(
        is_white(pixel(&input, 10, 10)),
        "the empty border is cropped away and replaced by white padding"
    );
}

#[test]
fn ocsr_input_scales_wide_images_proportionally() {
    // 100x50 is scaled by 512 / max(w, h) = 5.12 to 512x256, preserving the 2:1
    // aspect ratio. The central square is max(512, int(1.2 * 512)) = 614, so
    // the content ends up ~427x213 centred in the final 512x512 tensor.
    let png = png_rgb(
        100,
        50,
        |x, _y| {
            if x < 50 {
                [255, 0, 0]
            } else {
                [0, 0, 255]
            }
        },
    );

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    assert_eq!(input.shape, [1, SIDE, SIDE, CHANNELS]);
    assert!(
        is_white(pixel(&input, 256, 100)),
        "the 2:1 content leaves a white band above it"
    );
    assert!(
        is_white(pixel(&input, 256, 400)),
        "the 2:1 content leaves a white band below it"
    );
    let red_level = unnormalized(pixel(&input, 100, 160))[0];
    let blue_level = unnormalized(pixel(&input, 400, 160))[0];
    assert!(
        red_level < 80.0,
        "the left half must be the dark red side, got grey {red_level}"
    );
    assert!(
        blue_level > 120.0,
        "the right half must be the light blue side, got grey {blue_level}"
    );
    assert!(
        is_white(pixel(&input, 100, 140)),
        "the content must start around y=149 after the 100x50 -> 512x256 scaling"
    );
}

#[test]
fn ocsr_input_crops_empty_borders() {
    // A 40x40 black square in the top-left corner of a 400x400 white image:
    // after the border crop and the central canvas, the square must sit at the
    // centre of the tensor, not near (51, 51).
    let png = png_rgb(400, 400, |x, y| {
        if (40..80).contains(&x) && (40..80).contains(&y) {
            [0, 0, 0]
        } else {
            [255, 255, 255]
        }
    });

    let input = ocsr_input(&png).expect("a valid RGB PNG must preprocess");

    assert!(
        is_black(pixel(&input, 256, 256)),
        "the cropped square must be pasted at the centre"
    );
    assert!(
        is_black(pixel(&input, 241, 256)) && is_black(pixel(&input, 271, 256)),
        "the square must span the centre region after the crop"
    );
    assert!(
        is_white(pixel(&input, 100, 100)),
        "without the empty-border crop the square would still be near (51, 51)"
    );
    assert!(
        is_white(pixel(&input, 20, 20)),
        "the cropped border is replaced by white padding"
    );
}

#[test]
fn ocsr_input_rejects_undecodable_bytes() {
    let error = ocsr_input(b"not an image at all").expect_err("garbage bytes must be rejected");

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("decode") && message.contains("image"),
        "the error must explain the image could not be decoded, got: {message}"
    );
}

#[test]
fn ocsr_input_rejects_images_over_the_side_limit() {
    // The OCSR decoder shares the classifier's 12,000 px per-side bound.
    let png = png_rgb(MAX_IMAGE_SIDE + 1, 1, |_x, _y| [0, 0, 0]);

    let error = ocsr_input(&png).expect_err("an image wider than 12,000 px must be rejected");

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("size exceeds limit"),
        "the error must explain the dimension cap, got: {message}"
    );
}

// ── Vocabulary (no model) ────────────────────────────────────

/// A truncated `vocab.json` in the real `decimer-tokenizer-v1` shape: the two
/// maps are sparse (ids 13 and 14 are the start/end tokens).
fn sparse_vocab_json() -> Value {
    json!({
        "format": "decimer-tokenizer-v1",
        "vocab_size": 17,
        "pad_token": "<pad>",
        "pad_id": 0,
        "unk_token": "<unk>",
        "unk_id": 1,
        "start_token": "<start>",
        "start_id": 13,
        "end_token": "<end>",
        "end_id": 14,
        "token_to_id": {
            "<pad>": 0,
            "<unk>": 1,
            "C": 2,
            "1": 3,
            "<start>": 13,
            "<end>": 14,
            "!": 15,
            "$": 16
        },
        "id_to_token": {
            "0": "<pad>",
            "1": "<unk>",
            "2": "C",
            "3": "1",
            "13": "<start>",
            "14": "<end>",
            "15": "!",
            "16": "$"
        },
        "digit_remap": { "1234567890": "!$^<>?£¢€§" }
    })
}

fn load_sparse_vocab(dir: &TempDir) -> Vocab {
    let path = dir.write("vocab.json", sparse_vocab_json().to_string().as_bytes());
    load_vocab(&path).expect("a valid vocab.json must load")
}

#[test]
fn ocsr_vocab_decodes_tokens_and_applies_digit_remap() {
    let dir = TempDir::new("vocab-decode");
    let vocab = load_sparse_vocab(&dir);

    assert_eq!(
        vocab.decode_ids(&[13, 2, 15, 16, 14]),
        "C12",
        "`!` must be remapped to 1 and `$` to 2 after token lookup"
    );
    assert_eq!(
        vocab.decode_ids(&[15, 16]),
        "12",
        "the digit remap must apply to the concatenated tokens"
    );
}

#[test]
fn ocsr_vocab_skips_pad_start_and_end() {
    let dir = TempDir::new("vocab-skip");
    let vocab = load_sparse_vocab(&dir);

    assert_eq!(
        vocab.decode_ids(&[0, 13, 2, 14]),
        "C",
        "ids 0 (pad), 13 (start) and 14 (end) must not enter the SMILES"
    );
    assert_eq!(
        vocab.decode_ids(&[13, 14]),
        "",
        "a decode with no content tokens must produce an empty string"
    );
}

#[test]
fn ocsr_vocab_rejects_malformed_json() {
    let dir = TempDir::new("vocab-malformed");
    let path = dir.write("vocab.json", b"this is not JSON");

    let error = match load_vocab(&path) {
        Ok(_) => panic!("malformed JSON must be rejected"),
        Err(error) => error,
    };

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("vocab.json"),
        "the error must name the vocabulary file, got: {message}"
    );
}

#[test]
fn ocsr_vocab_rejects_missing_maps() {
    let dir = TempDir::new("vocab-missing-map");
    let path = dir.write(
        "vocab.json",
        br#"{"id_to_token": {"0": "<pad>", "2": "C"}}"#,
    );

    let error = match load_vocab(&path) {
        Ok(_) => panic!("a vocabulary without token_to_id must be rejected"),
        Err(error) => error,
    };

    let message = format!("{error:#}").to_lowercase();
    assert!(
        message.contains("token_to_id"),
        "the error must name the missing map, got: {message}"
    );
}

// ── OCSR shape contract (no model) ───────────────────────────

/// Returns the actionable message of a rejected OCSR shape.
fn ocsr_shape_error(graph: &[i64], manifest: &[i64]) -> String {
    match validate_ocsr_shape(graph, manifest) {
        Ok(()) => panic!("shape {graph:?} must be rejected against manifest {manifest:?}"),
        Err(error) => format!("{error:#}"),
    }
}

#[test]
fn ocsr_shape_accepts_an_exact_match() {
    validate_ocsr_shape(&[1, 512, 512, 3], &[1, 512, 512, 3])
        .expect("an exact encoder shape must be accepted");
    validate_ocsr_shape(&[1, -1, 156], &[1, -1, 156])
        .expect("an exact dynamic decoder shape must be accepted");
}

#[test]
fn ocsr_shape_accepts_a_dynamic_batch() {
    validate_ocsr_shape(&[-1, 512, 512, 3], &[1, 512, 512, 3])
        .expect("axis 0 may be dynamic even when the manifest pins the batch to one");
    validate_ocsr_shape(&[-1, -1], &[1, -1])
        .expect("a dynamic batch and decode sequence must be accepted");
}

#[test]
fn ocsr_shape_accepts_a_manifest_dynamic_sequence() {
    validate_ocsr_shape(&[1, -1], &[1, -1])
        .expect("the manifest-marked decode-sequence axis may stay dynamic");
}

#[test]
fn ocsr_shape_rejects_a_dynamic_vocabulary_axis() {
    let message = ocsr_shape_error(&[1, -1, -1], &[1, -1, 156]);

    assert!(
        message.contains("axis 2") && message.contains("156"),
        "a dynamic vocabulary axis is not a manifest-dynamic axis, got: {message}"
    );
}

#[test]
fn ocsr_shape_rejects_a_rank_mismatch() {
    let message = ocsr_shape_error(&[1, -1], &[1, -1, 156]);

    assert!(
        message.contains("rank 2") && message.contains("rank 3"),
        "the comparator must report both ranks, got: {message}"
    );
}

#[test]
fn ocsr_shape_rejects_a_static_mismatch() {
    let message = ocsr_shape_error(&[1, 512, 256, 3], &[1, 512, 512, 3]);

    assert!(
        message.contains("axis 2") && message.contains("256") && message.contains("512"),
        "a static encoder-width mismatch is a contract error, got: {message}"
    );
}

#[test]
fn ocsr_shape_rejects_a_static_dimension_where_the_manifest_is_dynamic() {
    let message = ocsr_shape_error(&[1, 156], &[1, -1]);

    assert!(
        message.contains("axis 1") && message.contains("156"),
        "a graph may not pin an axis the manifest declares dynamic, got: {message}"
    );
}

// ── Greedy decode (no model) ─────────────────────────────────

fn probability_row(best: usize, probability: f32) -> Vec<f32> {
    let mut row = vec![0.0_f32; VOCAB_SIZE];
    row[best] = probability;
    row
}

/// A tensor of zeros with the OCSR shape, enough to exercise the decoder loop.
fn blank_input() -> OcsrInput {
    OcsrInput {
        data: vec![0.0; SIDE * SIDE * CHANNELS],
        shape: [1, SIDE, SIDE, CHANNELS],
    }
}

/// Deterministic [`OcsrGraphs`] double: one fixed probability row per step.
struct FakeGraphs {
    rows: Vec<Vec<f32>>,
    decode_calls: usize,
    token_sequences: Vec<Vec<i32>>,
    encode_calls: usize,
}

impl FakeGraphs {
    fn new(rows: Vec<Vec<f32>>) -> Self {
        assert!(!rows.is_empty(), "the fake needs at least one row");
        Self {
            rows,
            decode_calls: 0,
            token_sequences: Vec::new(),
            encode_calls: 0,
        }
    }
}

impl OcsrGraphs for FakeGraphs {
    fn encode(&mut self, _input: &OcsrInput) -> anyhow::Result<Vec<f32>> {
        self.encode_calls += 1;
        Ok(vec![0.0; ENCODER_OUTPUT_LEN])
    }

    fn decode_step(&mut self, tokens: &[i32], enc_out: &[f32]) -> anyhow::Result<Vec<f32>> {
        if tokens.is_empty() {
            anyhow::bail!("the decoder must be seeded with the start id");
        }
        assert_eq!(
            enc_out.len(),
            ENCODER_OUTPUT_LEN,
            "the encoder output must be fed unchanged"
        );
        self.token_sequences.push(tokens.to_vec());

        let index = self.decode_calls.min(self.rows.len() - 1);
        let row = self.rows[index].clone();
        self.decode_calls += 1;

        // Every position before the last gets a decoy row whose argmax is the
        // pad id; only the last position may drive the next token.
        let mut output = vec![0.0_f32; tokens.len() * VOCAB_SIZE];
        let decoy = probability_row(0, 1.0);
        for chunk in output
            .chunks_mut(VOCAB_SIZE)
            .take(tokens.len().saturating_sub(1))
        {
            chunk.copy_from_slice(&decoy);
        }
        let last = (tokens.len() - 1) * VOCAB_SIZE;
        output[last..last + VOCAB_SIZE].copy_from_slice(&row);
        Ok(output)
    }
}

fn assert_probabilities(actual: &[f32], expected: &[f32]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "one probability must be recorded per generated token"
    );
    for (step, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (actual - expected).abs() < 1e-6,
            "step {step}: expected probability {expected}, got {actual}"
        );
    }
}

#[test]
fn ocsr_greedy_decode_stops_immediately_on_end() {
    let mut graphs = FakeGraphs::new(vec![probability_row(END_ID as usize, 0.75)]);

    let (ids, probabilities, incomplete) = greedy_decode(
        &mut graphs,
        &blank_input(),
        START_ID,
        END_ID,
        MAX_DECODE_STEPS,
    )
    .expect("the fake decoder must not fail");

    assert_eq!(ids, vec![START_ID, END_ID]);
    assert_probabilities(&probabilities, &[0.75]);
    assert!(!incomplete, "ending on end_id is a complete decode");
    assert_eq!(graphs.encode_calls, 1, "the encoder must run exactly once");
    assert_eq!(
        graphs.token_sequences,
        vec![vec![START_ID]],
        "the first decoder step must be seeded with the start id only"
    );
}

#[test]
fn ocsr_greedy_decode_appends_tokens_until_end() {
    let mut graphs = FakeGraphs::new(vec![
        probability_row(20, 0.9),
        probability_row(21, 0.8),
        probability_row(END_ID as usize, 0.7),
    ]);

    let (ids, probabilities, incomplete) = greedy_decode(
        &mut graphs,
        &blank_input(),
        START_ID,
        END_ID,
        MAX_DECODE_STEPS,
    )
    .expect("the fake decoder must not fail");

    assert_eq!(ids, vec![START_ID, 20, 21, END_ID]);
    assert_probabilities(&probabilities, &[0.9, 0.8, 0.7]);
    assert!(!incomplete);
    assert_eq!(
        graphs.token_sequences,
        vec![vec![START_ID], vec![START_ID, 20], vec![START_ID, 20, 21]],
        "each step must feed the whole sequence, including the generated ids"
    );
}

#[test]
fn ocsr_greedy_decode_accepts_end_exactly_at_max_len() {
    // The end token is the second generated token, on the last allowed step:
    // the decode is complete even though the loop consumed every step.
    let mut graphs = FakeGraphs::new(vec![
        probability_row(20, 0.9),
        probability_row(END_ID as usize, 0.8),
    ]);

    let (ids, probabilities, incomplete) =
        greedy_decode(&mut graphs, &blank_input(), START_ID, END_ID, 2)
            .expect("the fake decoder must not fail");

    assert_eq!(ids, vec![START_ID, 20, END_ID]);
    assert_probabilities(&probabilities, &[0.9, 0.8]);
    assert!(
        !incomplete,
        "an end token exactly on the last allowed step is a complete decode"
    );
    assert_eq!(graphs.decode_calls, 2);
    assert_eq!(
        graphs.token_sequences,
        vec![vec![START_ID], vec![START_ID, 20]]
    );
}

#[test]
fn ocsr_greedy_decode_reports_incomplete_at_max_len() {
    let mut graphs = FakeGraphs::new(vec![probability_row(20, 0.5)]);

    let (ids, probabilities, incomplete) =
        greedy_decode(&mut graphs, &blank_input(), START_ID, END_ID, 3)
            .expect("the fake decoder must not fail");

    assert_eq!(
        ids,
        vec![START_ID, 20, 20, 20],
        "the ids include the start id plus one id per decoding step"
    );
    assert_probabilities(&probabilities, &[0.5, 0.5, 0.5]);
    assert!(
        incomplete,
        "a decode that stops at max_len without end_id is incomplete"
    );
    assert_eq!(graphs.decode_calls, 3);
    assert_eq!(
        graphs.token_sequences,
        vec![vec![START_ID], vec![START_ID, 20], vec![START_ID, 20, 20]],
        "a truncated decode must still feed the exact generated prefix at every step"
    );
}

#[test]
fn ocsr_greedy_decode_picks_the_highest_probability() {
    let mut row = vec![0.0_f32; VOCAB_SIZE];
    row[7] = 0.4;
    row[42] = 0.9;
    row[100] = 0.2;
    let mut graphs = FakeGraphs::new(vec![row, probability_row(END_ID as usize, 0.6)]);

    let (ids, _, incomplete) = greedy_decode(
        &mut graphs,
        &blank_input(),
        START_ID,
        END_ID,
        MAX_DECODE_STEPS,
    )
    .expect("the fake decoder must not fail");

    assert_eq!(ids, vec![START_ID, 42, END_ID]);
    assert!(!incomplete);
}

#[test]
fn ocsr_greedy_decode_records_one_probability_per_token() {
    let mut graphs = FakeGraphs::new(vec![
        probability_row(5, 0.55),
        probability_row(6, 0.65),
        probability_row(END_ID as usize, 0.45),
    ]);

    let (ids, probabilities, _) = greedy_decode(
        &mut graphs,
        &blank_input(),
        START_ID,
        END_ID,
        MAX_DECODE_STEPS,
    )
    .expect("the fake decoder must not fail");

    assert_eq!(ids.len(), probabilities.len() + 1);
    assert_probabilities(&probabilities, &[0.55, 0.65, 0.45]);
}

#[test]
fn ocsr_mean_confidence_includes_the_end_token() {
    // (0.2 + 0.4 + 0.9) / 3 = 0.5. Dropping the final end-token probability
    // would give 0.3, so this pins the documented mean.
    let mean = mean_confidence(&[0.2, 0.4, 0.9]);

    assert!(
        (mean - 0.5).abs() < 1e-6,
        "the mean must include the end-token step, got {mean}"
    );
}

#[test]
fn ocsr_mean_confidence_of_an_empty_decode_is_zero() {
    assert_eq!(mean_confidence(&[]), 0.0);
}

// ── Endpoint errors and health (no model) ────────────────────

#[tokio::test]
async fn ocsr_rejects_unsupported_media_type() {
    let app = test_app();
    let (status, body) = post_ocsr(&app, "text/plain", b"hello".to_vec()).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.contains("image/png")
            && message.contains("image/jpeg")
            && message.contains("image/webp"),
        "the 400 must list the supported image types, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_rejects_undecodable_image() {
    let app = test_app();
    let (status, body) = post_ocsr(&app, "image/png", b"this is not a PNG".to_vec()).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let message = error_message(&body).to_lowercase();
    assert!(
        message.contains("decode") && message.contains("image"),
        "the 400 must explain the image could not be decoded, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_rejects_oversized_body() {
    // One byte over the documented 10 MiB cap must get 413 before decoding.
    let app = test_app();
    let body = vec![0u8; MAX_BODY_BYTES + 1];

    let (status, response) = post_ocsr(&app, "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "a body over 10 MiB must be rejected with 413, got body: {response}"
    );
}

#[tokio::test]
async fn ocsr_decodes_bodies_at_exactly_ten_megabytes() {
    // The cap is inclusive: exactly 10,485,760 bytes must reach the decoder
    // (400) instead of being rejected as too large (413).
    let app = test_app();
    let body = vec![0u8; MAX_BODY_BYTES];

    let (status, response) = post_ocsr(&app, "image/png", body).await;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "exactly 10 MiB is inside the cap and must be decoded, got body: {response}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_model_dir_is_missing() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the UNIX epoch")
        .as_nanos();
    let missing = std::env::temp_dir().join(format!(
        "chemistry-draw-missing-models-{}-{nanos}",
        std::process::id()
    ));
    assert!(
        !missing.exists(),
        "test needs an absent model directory: {missing:?}"
    );
    let app = test_app_with_models(missing);

    // A valid image is required: validation errors (400) take precedence over
    // model availability, so only a well-formed image reaches the 503 path.
    let (status, body) = post_ocsr(&app, "image/png", fixture_bytes("caffeine.png")).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    let message = error_message(&body);
    assert!(
        message.to_lowercase().contains("model"),
        "the 503 must say the model is unavailable, got: {message}"
    );
    assert!(
        message.contains("CHEMISTRY_MODELS_DIR"),
        "the 503 must explain how to provide the model, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_manifest_declares_no_ocsr() {
    let root = TempDir::new("no-ocsr-entry");
    root.write("manifest.json", br#"{"schema": 1, "models": {}}"#);
    let app = test_app_with_models(root.path());

    let (status, body) = post_ocsr(&app, "image/png", fixture_bytes("caffeine.png")).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    let message = error_message(&body).to_lowercase();
    assert!(
        message.contains("ocsr"),
        "the 503 must name the missing OCSR model, got: {message}"
    );
    assert!(
        message.contains("manifest.json") && message.contains("chemistry_models_dir"),
        "the 503 must name the manifest path and CHEMISTRY_MODELS_DIR, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_encoder_artifact_is_missing() {
    let root = TempDir::new("ocsr-missing-encoder");
    let zeros = "0".repeat(64);
    let decoder = b"stub decoder";
    let vocab = sparse_vocab_json().to_string();
    root.write(DECODER_ARTIFACT, decoder);
    root.write(VOCAB_ARTIFACT, vocab.as_bytes());
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(
            &zeros,
            &sha256_hex(decoder),
            &sha256_hex(vocab.as_bytes()),
        ),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("OCSR encoder") && message.contains("missing"),
        "the 503 must name the missing encoder artifact, got: {message}"
    );
    assert!(
        message.contains("CHEMISTRY_MODELS_DIR"),
        "the 503 must explain how to provide the model, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_decoder_artifact_is_missing() {
    let root = TempDir::new("ocsr-missing-decoder");
    let zeros = "0".repeat(64);
    let encoder = b"stub encoder";
    let vocab = sparse_vocab_json().to_string();
    root.write(ENCODER_ARTIFACT, encoder);
    root.write(VOCAB_ARTIFACT, vocab.as_bytes());
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(
            &sha256_hex(encoder),
            &zeros,
            &sha256_hex(vocab.as_bytes()),
        ),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("OCSR decoder") && message.contains("missing"),
        "the 503 must name the missing decoder artifact, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_vocabulary_artifact_is_missing() {
    let root = TempDir::new("ocsr-missing-vocab-file");
    let zeros = "0".repeat(64);
    let encoder = b"stub encoder";
    let decoder = b"stub decoder";
    root.write(ENCODER_ARTIFACT, encoder);
    root.write(DECODER_ARTIFACT, decoder);
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(&sha256_hex(encoder), &sha256_hex(decoder), &zeros),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("OCSR vocabulary") && message.contains("missing"),
        "the 503 must name the missing vocabulary artifact, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_an_artifact_checksum_does_not_match() {
    let root = TempDir::new("ocsr-bad-checksum");
    let wrong = "0".repeat(64);
    let encoder = b"stub encoder";
    let decoder = b"stub decoder";
    let vocab = sparse_vocab_json().to_string();
    root.write(ENCODER_ARTIFACT, encoder);
    root.write(DECODER_ARTIFACT, decoder);
    root.write(VOCAB_ARTIFACT, vocab.as_bytes());
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(
            &wrong,
            &sha256_hex(decoder),
            &sha256_hex(vocab.as_bytes()),
        ),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("OCSR encoder")
            && message.contains("sha256")
            && message.contains("replace the corrupted file"),
        "the 503 must explain the checksum mismatch, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_vocabulary_ids_disagree_with_the_manifest() {
    let root = TempDir::new("ocsr-vocab-start-id");
    let encoder = b"stub encoder";
    let decoder = b"stub decoder";
    let vocab = vocab_json_with(START_ID - 1, END_ID, VOCAB_SIZE).to_string();
    root.write(ENCODER_ARTIFACT, encoder);
    root.write(DECODER_ARTIFACT, decoder);
    root.write(VOCAB_ARTIFACT, vocab.as_bytes());
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(
            &sha256_hex(encoder),
            &sha256_hex(decoder),
            &sha256_hex(vocab.as_bytes()),
        ),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("start_id")
            && message.contains(&format!("{}", START_ID - 1))
            && message.contains(&format!("{START_ID}")),
        "the 503 must report the vocabulary and manifest start ids, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_returns_503_when_vocabulary_size_disagrees_with_the_decoder() {
    let root = TempDir::new("ocsr-vocab-size");
    let encoder = b"stub encoder";
    let decoder = b"stub decoder";
    let vocab = vocab_json_with(START_ID, END_ID, VOCAB_SIZE - 1).to_string();
    root.write(ENCODER_ARTIFACT, encoder);
    root.write(DECODER_ARTIFACT, decoder);
    root.write(VOCAB_ARTIFACT, vocab.as_bytes());
    write_ocsr_only_manifest(
        &root,
        ocsr_manifest_entry_with_hashes(
            &sha256_hex(encoder),
            &sha256_hex(decoder),
            &sha256_hex(vocab.as_bytes()),
        ),
    );

    let body = post_caffeine_503(&root.path()).await;

    let message = error_message(&body);
    assert!(
        message.contains("vocab_size")
            && message.contains(&format!("{}", VOCAB_SIZE - 1))
            && message.contains(&VOCAB_SIZE.to_string()),
        "the 503 must report the vocabulary size and the {VOCAB_SIZE} decoder classes, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_unprocessable_errors_map_to_422() {
    let error =
        AppError::Unprocessable("could not finish the structure; try a sharper image".to_string());
    let response = error.into_response();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the error body must be readable");
    let body: Value = serde_json::from_slice(&body).expect("the 422 body must be JSON");
    let message = error_message(&body);
    assert!(
        message.contains("could not finish the structure"),
        "the 422 must carry the actionable incomplete-decode message, got: {message}"
    );
}

#[tokio::test]
async fn ocsr_incomplete_prediction_maps_to_422_without_a_smiles() {
    let prediction = OcsrPrediction {
        smiles: "C".to_string(),
        confidence: 0.4,
        incomplete: true,
    };

    let error = ensure_complete(&prediction).expect_err("an incomplete decode is not a result");
    assert!(
        matches!(&error, AppError::Unprocessable(_)),
        "an incomplete decode must map to AppError::Unprocessable, got: {error:?}"
    );

    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the error body must be readable");
    let body: Value = serde_json::from_slice(&body).expect("the 422 body must be JSON");
    let message = error_message(&body);
    assert!(
        message.contains("could not finish the structure") && message.contains("sharper image"),
        "the 422 must carry the actionable incomplete-decode message, got: {message}"
    );
    assert!(
        body.get("smiles").is_none(),
        "a truncated decode must never return a smiles field, got body: {body}"
    );
}

#[test]
fn ocsr_complete_prediction_is_accepted() {
    let prediction = OcsrPrediction {
        smiles: "C".to_string(),
        confidence: 0.995,
        incomplete: false,
    };

    ensure_complete(&prediction).expect("a complete decode must pass the handler guard");
}

fn classifier_manifest_entry() -> Value {
    json!({
        "id": CLASSIFIER_MODEL_ID,
        "file": CLASSIFIER_ARTIFACT,
        "artifact_sha256": "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9",
        "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
        "license": "MIT",
        "threshold": 0.000089,
        "preprocessing": "runtime_default",
        "inputs": [
            { "name": "input_2", "dtype": "float32", "shape": [1, 224, 224, 3] },
            { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
            { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
        ],
        "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
    })
}

fn ocsr_manifest_entry() -> Value {
    json!({
        "id": OCSR_MODEL_ID,
        "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
        "license": "CC-BY-4.0",
        "preprocessing": "decimer_ocsr",
        "start_id": START_ID,
        "end_id": END_ID,
        "max_len": MAX_DECODE_STEPS,
        "confidence_threshold": 0.901,
        "encoder": {
            "file": ENCODER_ARTIFACT,
            "artifact_sha256": "0".repeat(64),
            "inputs": [
                { "name": "image", "dtype": "float32", "shape": [1, 512, 512, 3] }
            ],
            "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 256, 512] }
        },
        "decoder": {
            "file": DECODER_ARTIFACT,
            "artifact_sha256": "0".repeat(64),
            "inputs": [
                { "name": "tokens", "dtype": "int32", "shape": [1, -1] },
                { "name": "enc_out", "dtype": "float32", "shape": [1, 256, 512] }
            ],
            "zero_inputs": ["217602:0", "217606:0"],
            "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, -1, 156] }
        },
        "vocab": {
            "file": VOCAB_ARTIFACT,
            "artifact_sha256": "0".repeat(64)
        }
    })
}

/// Lowercase hex SHA-256 of `bytes`, matching the manifest spelling.
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The OCSR manifest entry with explicit artifact checksums.
fn ocsr_manifest_entry_with_hashes(encoder: &str, decoder: &str, vocab: &str) -> Value {
    let mut entry = ocsr_manifest_entry();
    entry["encoder"]["artifact_sha256"] = json!(encoder);
    entry["decoder"]["artifact_sha256"] = json!(decoder);
    entry["vocab"]["artifact_sha256"] = json!(vocab);
    entry
}

/// Writes a schema-1 manifest declaring the OCSR entry and nothing else.
fn write_ocsr_only_manifest(root: &TempDir, entry: Value) {
    root.write(
        "manifest.json",
        json!({ "schema": 1, "models": { "ocsr-handdrawn": entry } })
            .to_string()
            .as_bytes(),
    );
}

/// A `decimer-tokenizer-v1` vocabulary with the given special ids and size.
fn vocab_json_with(start_id: i32, end_id: i32, vocab_size: usize) -> Value {
    let mut vocab = sparse_vocab_json();
    vocab["start_id"] = json!(start_id);
    vocab["end_id"] = json!(end_id);
    vocab["vocab_size"] = json!(vocab_size);
    vocab
}

/// Posts the caffeine fixture against `root` and returns the 503 body.
async fn post_caffeine_503(root: &Path) -> Value {
    let app = test_app_with_models(root.to_path_buf());
    let (status, body) = post_ocsr(&app, "image/png", fixture_bytes("caffeine.png")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "body: {body}");
    body
}

fn health_model_ids(body: &Value) -> Vec<&str> {
    body["models"]
        .as_array()
        .unwrap_or_else(|| panic!("health.models must be an array, got body: {body}"))
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

#[tokio::test]
async fn health_lists_ocsr_only_when_all_artifacts_exist() {
    let root = TempDir::new("health-ocsr-present");
    root.write(
        "manifest.json",
        json!({
            "schema": 1,
            "models": {
                "image-classifier": classifier_manifest_entry(),
                "ocsr-handdrawn": ocsr_manifest_entry()
            }
        })
        .to_string()
        .as_bytes(),
    );
    // Only presence matters for health: no checksum is verified and no session
    // is opened, so stub bytes are enough.
    root.write(CLASSIFIER_ARTIFACT, b"stub classifier");
    root.write(ENCODER_ARTIFACT, b"stub encoder");
    root.write(DECODER_ARTIFACT, b"stub decoder");
    root.write(VOCAB_ARTIFACT, b"stub vocabulary");

    let app = test_app_with_models(root.path());
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let models = health_model_ids(&body);
    assert!(
        models.contains(&OCSR_MODEL_ID),
        "health must list {OCSR_MODEL_ID} when all three artifacts exist, got: {models:?}"
    );
    assert!(
        models.contains(&CLASSIFIER_MODEL_ID),
        "health must keep listing the classifier, got: {models:?}"
    );
}

#[tokio::test]
async fn health_hides_ocsr_when_an_artifact_is_missing() {
    let root = TempDir::new("health-ocsr-missing-vocab");
    root.write(
        "manifest.json",
        json!({
            "schema": 1,
            "models": {
                "image-classifier": classifier_manifest_entry(),
                "ocsr-handdrawn": ocsr_manifest_entry()
            }
        })
        .to_string()
        .as_bytes(),
    );
    root.write(CLASSIFIER_ARTIFACT, b"stub classifier");
    root.write(ENCODER_ARTIFACT, b"stub encoder");
    root.write(DECODER_ARTIFACT, b"stub decoder");
    // vocab.json is intentionally absent.

    let app = test_app_with_models(root.path());
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let models = health_model_ids(&body);
    assert!(
        !models.contains(&OCSR_MODEL_ID),
        "an OCSR model with a missing artifact must not be listed, got: {models:?}"
    );
    assert!(
        models.contains(&CLASSIFIER_MODEL_ID),
        "the missing OCSR artifact must not hide the classifier, got: {models:?}"
    );
}

// ── Model-gated tests ────────────────────────────────────────

/// Lists the three OCSR artifacts and the manifest inside `dir`.
fn ocsr_artifact_reason(dir: &Path) -> Result<(), String> {
    for artifact in [ENCODER_ARTIFACT, DECODER_ARTIFACT, VOCAB_ARTIFACT] {
        let path = dir.join(artifact);
        if !path.is_file() {
            return Err(format!(
                "skipping: OCSR artifact {} is missing; fetch ocsr-handdrawn-fp32/ from \
                 https://huggingface.co/spalax-dev/chemistry-draw-ocsr into {}",
                path.display(),
                dir.display()
            ));
        }
    }
    let manifest = dir.join("manifest.json");
    if !manifest.is_file() {
        return Err(format!("skipping: {} is missing", manifest.display()));
    }
    Ok(())
}

/// Returns the model root when the OCSR artifacts exist, otherwise logs the
/// skip reason and returns `None`. Every model-gated test calls this first.
fn ocsr_artifact_root() -> Option<PathBuf> {
    let dir = models_dir();
    match ocsr_artifact_reason(&dir) {
        Ok(()) => Some(dir),
        Err(reason) => {
            eprintln!("{reason}");
            None
        }
    }
}

#[cfg(unix)]
fn symlink_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
fn symlink_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, destination)
}

/// Returns a temporary model root whose manifest declares only the OCSR entry
/// and whose artifacts are symlinks to the real files.
///
/// The OCSR contract and fixture tests do not need the classifier: they build
/// this root instead of using the shared model store, so an OCSR-only install
/// still runs them. Only `health_lists_both_models_when_present` requires both
/// model families.
fn ocsr_only_model_root() -> Option<TempDir> {
    let dir = ocsr_artifact_root()?;

    let manifest_path = dir.join("manifest.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!(
                "skipping: {} could not be read: {error}",
                manifest_path.display()
            );
            return None;
        }
    };
    let manifest: Value = match serde_json::from_str(&raw) {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!(
                "skipping: {} is not valid JSON: {error}",
                manifest_path.display()
            );
            return None;
        }
    };
    let Some(entry) = manifest
        .get("models")
        .and_then(|models| models.get("ocsr-handdrawn"))
        .cloned()
    else {
        eprintln!(
            "skipping: {} has no ocsr-handdrawn entry",
            manifest_path.display()
        );
        return None;
    };

    let root = TempDir::new("ocsr-only-root");
    write_ocsr_only_manifest(&root, entry);
    for artifact in [ENCODER_ARTIFACT, DECODER_ARTIFACT, VOCAB_ARTIFACT] {
        let source = dir.join(artifact);
        let destination = root.path().join(artifact);
        if let Some(parent) = destination.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("skipping: could not create {}: {error}", parent.display());
                return None;
            }
        }
        if let Err(error) = symlink_file(&source, &destination) {
            eprintln!(
                "skipping: could not symlink {} -> {}: {error}",
                destination.display(),
                source.display()
            );
            return None;
        }
    }
    Some(root)
}

#[test]
#[ignore = "requires local ONNX model"]
fn ocsr_model_contract_matches_manifest() {
    let Some(root) = ocsr_only_model_root() else {
        return;
    };
    let registry = ModelRegistry::load(&root.path())
        .expect("model registry must load the temp OCSR-only manifest.json");
    let model: &OcsrModel = registry
        .ocsr()
        .expect("the registry must report a configuration error, not panic")
        .expect("manifest must declare the OCSR model");
    let contract = model.contract();

    assert_eq!(contract.id, OCSR_MODEL_ID);

    assert_eq!(contract.encoder_input.name, "image");
    assert_eq!(contract.encoder_input.dtype, "float32");
    assert_eq!(
        contract.encoder_input.shape,
        vec![1_i64, 512, 512, 3],
        "the encoder image input must be NHWC float32 [1, 512, 512, 3]"
    );

    assert_eq!(contract.encoder_output.name, "Identity:0");
    assert_eq!(contract.encoder_output.dtype, "float32");
    assert_eq!(contract.encoder_output.shape, vec![1_i64, 256, 512]);

    assert_eq!(contract.decoder_tokens.name, "tokens");
    assert_eq!(contract.decoder_tokens.dtype, "int32");
    assert_eq!(
        contract.decoder_tokens.shape.len(),
        2,
        "the decoder tokens input must be [1, seq]"
    );
    assert_eq!(contract.decoder_tokens.shape[0], 1);
    assert_eq!(
        contract.decoder_tokens.shape[1], -1,
        "the decode-sequence axis is the dynamic one"
    );

    assert_eq!(contract.decoder_enc_out.name, "enc_out");
    assert_eq!(contract.decoder_enc_out.dtype, "float32");
    assert_eq!(
        contract.decoder_enc_out.shape, contract.encoder_output.shape,
        "enc_out must accept the encoder output unchanged"
    );

    assert_eq!(contract.decoder_output.name, "Identity:0");
    assert_eq!(contract.decoder_output.dtype, "float32");
    assert_eq!(
        contract.decoder_output.shape.len(),
        3,
        "the decoder output must be [1, seq, 156]"
    );
    assert_eq!(contract.decoder_output.shape[0], 1);
    assert_eq!(contract.decoder_output.shape[1], -1);
    assert_eq!(
        contract.decoder_output.shape[2], VOCAB_SIZE as i64,
        "the vocabulary has 156 classes"
    );

    assert_eq!(contract.start_id, START_ID);
    assert_eq!(contract.end_id, END_ID);
    assert_eq!(contract.max_len, MAX_DECODE_STEPS);
    assert!(
        (contract.confidence_threshold - 0.901).abs() < 1e-6,
        "the manifest records the measured 0.901 confidence threshold"
    );
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn ocsr_recognizes_caffeine_fixture() {
    let Some(root) = ocsr_only_model_root() else {
        return;
    };
    let app = test_app_with_models(root.path());

    let (status, body) = post_ocsr(&app, "image/png", fixture_bytes("caffeine.png")).await;

    assert_eq!(
        status,
        StatusCode::OK,
        "the real model must finish the caffeine fixture; a 422 here is an incomplete decode \
         to report, not a test to weaken. body: {body}"
    );
    let smiles = body["smiles"]
        .as_str()
        .unwrap_or_else(|| panic!("smiles must be a string, got body: {body}"));
    assert_eq!(
        smiles, CAFFEINE_SMILES,
        "the hand-drawn model decodes caffeine to a fixed SMILES, got body: {body}"
    );
    let confidence = body["confidence"]
        .as_f64()
        .unwrap_or_else(|| panic!("confidence must be a number, got body: {body}"));
    assert!(
        (0.99..=1.0).contains(&confidence),
        "the caffeine fixture decodes at ~0.9957 confidence, got {confidence}"
    );
    assert_eq!(
        body["incomplete"], false,
        "a 200 response must be a complete decode, got body: {body}"
    );
    assert_eq!(body["model"], OCSR_MODEL_ID);
}

#[tokio::test]
#[ignore = "requires local ONNX model"]
async fn health_lists_both_models_when_present() {
    let Some(dir) = ocsr_artifact_root() else {
        return;
    };
    if !dir.join(CLASSIFIER_ARTIFACT).is_file() {
        eprintln!(
            "skipping: classifier artifact {} is missing",
            dir.join(CLASSIFIER_ARTIFACT).display()
        );
        return;
    }
    let app = test_app_with_models(dir);

    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    let models = health_model_ids(&body);
    assert!(
        models.contains(&CLASSIFIER_MODEL_ID),
        "health must list {CLASSIFIER_MODEL_ID}, got: {models:?}"
    );
    assert!(
        models.contains(&OCSR_MODEL_ID),
        "health must list {OCSR_MODEL_ID}, got: {models:?}"
    );
}
