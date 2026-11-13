//! `decimer_ocsr` image preprocessing for optical chemical structure recognition.
//!
//! This is a separate pipeline from `runtime_default` ([`super::preprocess`]):
//! the OCSR model was trained on DECIMER's own preprocessing, so the step order
//! is the contract, not an implementation detail. It is a port of the
//! toolchain's `runtime/preprocess.py`:
//!
//! 1. Open the image as RGBA and composite it on white.
//! 2. Contrast stretch: a LUT maps the per-image minimum..maximum (across the
//!    RGBA array) to `0..255`.
//! 3. BGR2GRAY quirk on the RGB array: `gray = 0.114*R + 0.587*G + 0.299*B`
//!    (OpenCV BGR weights applied without swapping the channels), then PIL
//!    `ImageEnhance.Contrast(1.8)` (`mean + 1.8*(value - mean)`).
//! 4. Resize rules, in order: a square with side `< 512` becomes `512x512`; if
//!    either side is `>= 512` it is not resized; otherwise both sides scale by
//!    `512 / max(w, h)` with `int()` truncation and LANCZOS.
//! 5. Crop empty borders: pixels `> 200` are background, crop to the bounding
//!    box of non-background pixels; an all-background image is kept unchanged.
//! 6. Paste centered on a white square of side `max(512, int(1.2 * max(w, h)))`;
//!    a side over [`MAX_CENTRAL_SIDE`] (8,192 px) is rejected as an extreme
//!    aspect ratio before the canvas is allocated.
//! 7. Brightness x1.6 (PIL semantics, clipped).
//! 8. Resize to exactly `512x512` with LANCZOS as RGB.
//! 9. Normalize with the ImageNet mean/std and emit NHWC float32
//!    `[1, 512, 512, 3]`.
//!
//! Decoding is bounded before any pixel is materialized, with the same limits as
//! the classifier: [`MAX_IMAGE_SIDE`] (12,000 px) per side and
//! [`MAX_DECODE_ALLOC_BYTES`] (128 MiB) of decoder allocations. Over-limit or
//! undecodable input returns an actionable error that the transport maps to
//! HTTP 400, as does a central canvas over [`MAX_CENTRAL_SIDE`].

use std::io::Cursor;

use anyhow::{bail, Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, ImageReader, Limits, Luma, Rgba, RgbaImage};

use crate::service::ml::preprocess::{MAX_DECODE_ALLOC_BYTES, MAX_IMAGE_SIDE};

/// Side length of the square OCSR input tensor.
const SIDE: u32 = 512;
/// Number of colour channels of the OCSR input tensor.
const CHANNELS: usize = 3;
/// Maximum central-canvas side; larger values indicate an extreme aspect ratio
/// and would allocate a wasteful intermediate image.
const MAX_CENTRAL_SIDE: u32 = 8192;
/// Pixels brighter than this value are treated as empty background when cropping.
const BACKGROUND_THRESHOLD: u8 = 200;
/// PIL `ImageEnhance.Contrast` factor applied to the grayscale image.
const CONTRAST: f32 = 1.8;
/// PIL `ImageEnhance.Brightness` factor applied before the final resize.
const BRIGHTNESS: f32 = 1.6;
/// ImageNet per-channel mean used by the final normalization step.
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet per-channel standard deviation used by the final normalization step.
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Preprocessed OCSR input in NHWC layout.
#[derive(Debug, Clone, PartialEq)]
pub struct OcsrInput {
    /// Row-major NHWC pixels: `[height][width][channel]`, ImageNet-normalized.
    pub data: Vec<f32>,
    /// Tensor shape, always `[1, 512, 512, 3]`.
    pub shape: [usize; 4],
}

/// Decodes PNG, JPEG or WebP bytes and applies the `decimer_ocsr` pipeline.
///
/// Undecodable, unsupported or over-limit bytes produce an actionable error
/// instead of a panic or an unbounded allocation; the transport layer maps it
/// to HTTP 400.
pub fn ocsr_input(bytes: &[u8]) -> Result<OcsrInput> {
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

    preprocess(&image)
}

fn preprocess(image: &DynamicImage) -> Result<OcsrInput> {
    let composited = composite_on_white(image);
    let stretched = stretch_contrast(&composited);
    let grayscale = grayscale_with_bgr_quirk(&stretched);
    let contrasted = enhance_contrast(&grayscale);
    let resized = resize_rules(&contrasted);
    let cropped = crop_empty_borders(&resized);
    let side = central_side(cropped.width(), cropped.height());
    if side > MAX_CENTRAL_SIDE {
        bail!(
            "the image has an extreme aspect ratio: the central canvas would be {side} px per \
             side (the limit is {MAX_CENTRAL_SIDE}); crop the image closer to a square or draw \
             inside a smaller canvas"
        );
    }
    let squared = central_square(&cropped, side);
    let brightened = brighten(&squared);
    let final_image = image::imageops::resize(&brightened, SIDE, SIDE, FilterType::Lanczos3);
    let data = normalize(&final_image);

    Ok(OcsrInput {
        data,
        shape: [1, SIDE as usize, SIDE as usize, CHANNELS],
    })
}

/// Composites every pixel over opaque white, preserving size.
fn composite_on_white(image: &DynamicImage) -> RgbaImage {
    let rgba = image.to_rgba8();
    let mut out = RgbaImage::new(rgba.width(), rgba.height());

    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let alpha = u32::from(alpha);
        let blend = |channel: u8| -> u8 {
            // out = src * alpha + white * (1 - alpha), rounded to nearest.
            ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        out.put_pixel(x, y, Rgba([blend(red), blend(green), blend(blue), 255]));
    }

    out
}

/// Stretches the per-image minimum..maximum (all RGBA channels) to `0..255`.
fn stretch_contrast(image: &RgbaImage) -> RgbaImage {
    let (minimum, maximum) = image
        .pixels()
        .flat_map(|pixel| pixel.0)
        .fold((255_u8, 0_u8), |(minimum, maximum), value| {
            (minimum.min(value), maximum.max(value))
        });

    let mut lut = [0_u8; 256];
    if maximum == minimum {
        // `np.linspace(0, 255, 1)` is a single zero: a uniform image becomes black.
        lut[usize::from(minimum)] = 0;
    } else {
        let range = u32::from(maximum) - u32::from(minimum);
        let last = range as usize;
        let delta = 255.0_f64 / f64::from(range);
        for step in 0..=last {
            // Matches `np.linspace(0, 255, range + 1, dtype=np.uint8)`: NumPy
            // computes `step * delta` in float64, sets the endpoints explicitly
            // to 0 and 255, then the uint8 cast truncates. Integer floor
            // division differs for ranges such as 105 (step 21 -> 50, not 51).
            let value = match step {
                0 => 0.0,
                step if step == last => 255.0,
                step => step as f64 * delta,
            };
            lut[(u32::from(minimum) + step as u32) as usize] = value as u8;
        }
    }

    let mut out = RgbaImage::new(image.width(), image.height());
    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        out.put_pixel(
            x,
            y,
            Rgba([
                lut[usize::from(red)],
                lut[usize::from(green)],
                lut[usize::from(blue)],
                lut[usize::from(alpha)],
            ]),
        );
    }

    out
}

/// Converts to grayscale with the BGR2GRAY-on-RGB quirk, truncating like NumPy.
fn grayscale_with_bgr_quirk(image: &RgbaImage) -> GrayImage {
    let mut gray = GrayImage::new(image.width(), image.height());

    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue, _] = pixel.0;
        let value = 0.114 * f32::from(red) + 0.587 * f32::from(green) + 0.299 * f32::from(blue);
        gray.put_pixel(x, y, Luma([value.clamp(0.0, 255.0) as u8]));
    }

    gray
}

/// Applies PIL `ImageEnhance.Contrast(1.8)`.
///
/// PIL blends a constant `mean = int(mean + 0.5)` image with the source and
/// extrapolates beyond `0..255` when the factor is greater than one, truncating
/// and clipping each sample.
fn enhance_contrast(image: &GrayImage) -> GrayImage {
    let count = f64::from(image.width()) * f64::from(image.height());
    let sum: u64 = image.pixels().map(|pixel| u64::from(pixel.0[0])).sum();
    let mean = (sum as f64 / count + 0.5) as u8;

    let mut lut = [0_u8; 256];
    for (value, entry) in lut.iter_mut().enumerate() {
        *entry = extrapolate(mean, CONTRAST, value as u8);
    }

    map_pixels(image, &lut)
}

/// Applies PIL `ImageEnhance.Brightness(1.6)` (blend against black).
fn brighten(image: &GrayImage) -> GrayImage {
    let mut lut = [0_u8; 256];
    for (value, entry) in lut.iter_mut().enumerate() {
        *entry = extrapolate(0, BRIGHTNESS, value as u8);
    }

    map_pixels(image, &lut)
}

/// Replicates PIL's `Image.blend` extrapolation: `base + factor*(value - base)`,
/// clipped to `0..255` and truncated toward zero.
fn extrapolate(base: u8, factor: f32, value: u8) -> u8 {
    let blended = f32::from(base) + factor * (f32::from(value) - f32::from(base));
    if blended <= 0.0 {
        0
    } else if blended >= 255.0 {
        255
    } else {
        blended as u8
    }
}

fn map_pixels(image: &GrayImage, lut: &[u8; 256]) -> GrayImage {
    let mut out = GrayImage::new(image.width(), image.height());
    for (x, y, pixel) in image.enumerate_pixels() {
        out.put_pixel(x, y, Luma([lut[usize::from(pixel.0[0])]]));
    }
    out
}

/// Applies the documented resize rules without changing the aspect ratio.
fn resize_rules(image: &GrayImage) -> GrayImage {
    let (width, height) = image.dimensions();
    if width == height && width < SIDE {
        return image::imageops::resize(image, SIDE, SIDE, FilterType::Lanczos3);
    }
    if width >= SIDE || height >= SIDE {
        return image.clone();
    }

    let ratio = f64::from(SIDE) / f64::from(width.max(height));
    let new_width = ((f64::from(width) * ratio) as u32).max(1);
    let new_height = ((f64::from(height) * ratio) as u32).max(1);
    image::imageops::resize(image, new_width, new_height, FilterType::Lanczos3)
}

/// Crops to the bounding box of pixels at or below [`BACKGROUND_THRESHOLD`].
pub(crate) fn crop_empty_borders(image: &GrayImage) -> GrayImage {
    let mut minimum_x = u32::MAX;
    let mut maximum_x = 0;
    let mut minimum_y = u32::MAX;
    let mut maximum_y = 0;
    let mut found_content = false;

    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel.0[0] <= BACKGROUND_THRESHOLD {
            found_content = true;
            minimum_x = minimum_x.min(x);
            maximum_x = maximum_x.max(x);
            minimum_y = minimum_y.min(y);
            maximum_y = maximum_y.max(y);
        }
    }

    if !found_content {
        return image.clone();
    }

    image::imageops::crop_imm(
        image,
        minimum_x,
        minimum_y,
        maximum_x - minimum_x + 1,
        maximum_y - minimum_y + 1,
    )
    .to_image()
}

/// Side of the central canvas: `max(512, int(1.2 * max(w, h)))`.
fn central_side(width: u32, height: u32) -> u32 {
    ((1.2 * f64::from(width.max(height))) as u32).max(SIDE)
}

/// Pastes the content at the center of a white `side` square.
fn central_square(image: &GrayImage, side: u32) -> GrayImage {
    let (width, height) = image.dimensions();
    let mut canvas = GrayImage::from_pixel(side, side, Luma([255]));
    let offset_x = (side - width) / 2;
    let offset_y = (side - height) / 2;

    for (x, y, pixel) in image.enumerate_pixels() {
        canvas.put_pixel(offset_x + x, offset_y + y, *pixel);
    }

    canvas
}

/// Emits the final NHWC float32 tensor with ImageNet normalization.
fn normalize(image: &GrayImage) -> Vec<f32> {
    let mut data = Vec::with_capacity((SIDE * SIDE) as usize * CHANNELS);
    for pixel in image.pixels() {
        let value = f32::from(pixel.0[0]) / 255.0;
        for channel in 0..CHANNELS {
            data.push((value - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel]);
        }
    }
    data
}
