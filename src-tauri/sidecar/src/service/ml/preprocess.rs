//! `runtime_default` image preprocessing for the structure classifier.
//!
//! The pipeline is the contract, not an implementation detail: it must stay
//! byte-compatible with the upstream DECIMER preprocessing (`runtime_default`).
//! A model that trained on a different pipeline is a different model, so this
//! module deliberately offers no options:
//!
//! 1. Composite RGBA on a white background (a transparent pixel is white, not
//!    black).
//! 2. Convert to grayscale with the Rec.601 weights used by PIL
//!    `convert("L")`, then replicate the gray value into three RGB channels.
//! 3. Resize with LANCZOS3, aspect-preserving, so the longest side is exactly
//!    224 pixels; the short side is `floor(short * ratio)` like the upstream
//!    Python `int(x * ratio)`. A 224x224 image is left untouched.
//! 4. Center the resized image on a white 224x224 canvas.
//! 5. Emit row-major NHWC `f32` values in `0.0..=255.0`.
//!
//! Auto-inversion, histogram equalization, sharpening and autocontrast are
//! intentionally absent: they measurably degrade the frozen evaluation.
//!
//! Decoding is bounded before any pixel is materialized: images wider or taller
//! than [`MAX_IMAGE_SIDE`] (12,000 px) or needing more than
//! [`MAX_DECODE_ALLOC_BYTES`] (128 MiB) of decoder allocations are rejected with
//! the same 400 as undecodable bytes.

use std::io::Cursor;

use anyhow::{Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, ImageReader, Limits, Rgb, RgbImage};

/// Side length of the square classifier input.
const SIDE: u32 = 224;
/// Maximum accepted width and height of a decoded image.
pub const MAX_IMAGE_SIDE: u32 = 12_000;
/// Maximum memory the decoder may allocate, in bytes (128 MiB).
pub const MAX_DECODE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;

/// Preprocessed classifier input in NHWC layout.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifierInput {
    /// Row-major NHWC pixels: `[height][width][channel]`, values in `0.0..=255.0`.
    pub data: Vec<f32>,
    /// Tensor shape, always `[1, 224, 224, 3]`.
    pub shape: [usize; 4],
}

/// Decodes PNG, JPEG or WebP bytes and applies the `runtime_default` pipeline.
///
/// Undecodable, unsupported or over-limit bytes produce an actionable error
/// instead of a panic or an unbounded allocation; the transport layer maps it
/// to HTTP 400.
pub fn classifier_input(bytes: &[u8]) -> Result<ClassifierInput> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .context("could not decode image bytes (supported formats: PNG, JPEG and WebP)")?;

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    reader.limits(limits);

    let image = reader.decode().with_context(|| {
        format!(
            "could not decode image bytes (supported formats: PNG, JPEG and WebP; \
             images are capped at {MAX_IMAGE_SIDE} px per side and \
             {} MiB of decoder allocations)",
            MAX_DECODE_ALLOC_BYTES / (1024 * 1024)
        )
    })?;
    Ok(preprocess(&image))
}

fn preprocess(image: &DynamicImage) -> ClassifierInput {
    let composited = composite_on_white(image);
    let grayscale = grayscale_rgb(&composited);
    let resized = resize_longest_side(&grayscale);
    let canvas = center_on_white(&resized);

    let data = canvas
        .pixels()
        .flat_map(|pixel| pixel.0)
        .map(f32::from)
        .collect();

    ClassifierInput {
        data,
        shape: [1, SIDE as usize, SIDE as usize, 3],
    }
}

/// Composites every pixel over opaque white, preserving size.
fn composite_on_white(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());

    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let alpha = u32::from(alpha);
        let blend = |channel: u8| -> u8 {
            // out = src * alpha + white * (1 - alpha), rounded to nearest.
            ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        rgb.put_pixel(x, y, Rgb([blend(red), blend(green), blend(blue)]));
    }

    rgb
}

/// Converts to grayscale with PIL `convert("L")`'s fixed-point Rec.601 weights
/// and replicates the result into RGB.
fn grayscale_rgb(image: &RgbImage) -> RgbImage {
    let mut gray = RgbImage::new(image.width(), image.height());

    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue] = pixel.0.map(u32::from);
        let luma = (red * 19_595 + green * 38_470 + blue * 7_471 + 0x8000) >> 16;
        let luma = luma.min(255) as u8;
        gray.put_pixel(x, y, Rgb([luma, luma, luma]));
    }

    gray
}

/// Resizes so the longest side is [`SIDE`], keeping the aspect ratio.
fn resize_longest_side(image: &RgbImage) -> RgbImage {
    let (width, height) = image.dimensions();
    if width == SIDE && height == SIDE {
        return image.clone();
    }

    let (new_width, new_height) = if width >= height {
        let short =
            ((f64::from(height) * (f64::from(SIDE) / f64::from(width))).floor() as u32).max(1);
        (SIDE, short)
    } else {
        let short =
            ((f64::from(width) * (f64::from(SIDE) / f64::from(height))).floor() as u32).max(1);
        (short, SIDE)
    };

    image::imageops::resize(image, new_width, new_height, FilterType::Lanczos3)
}

/// Pastes the resized content at the center of a white [`SIDE`]x[`SIDE`] canvas.
fn center_on_white(content: &RgbImage) -> RgbImage {
    let mut canvas = RgbImage::from_pixel(SIDE, SIDE, Rgb([255, 255, 255]));
    let offset_x = (SIDE - content.width()) / 2;
    let offset_y = (SIDE - content.height()) / 2;

    for (x, y, pixel) in content.enumerate_pixels() {
        canvas.put_pixel(x + offset_x, y + offset_y, *pixel);
    }

    canvas
}
