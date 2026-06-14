//! High-level Indigo operations.
//!
//! Each function manages sessions, handles cleanup, and maps errors to
//! [`AppError`].

use crate::error::AppError;
use crate::ffi::indigo;
use crate::service::types::CalculateResponse;

pub fn convert(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::layout(handle);
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn aromatize(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::aromatize(handle).map_err(AppError::internal)?;
    indigo::layout(handle);
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn dearomatize(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::dearomatize(handle).map_err(AppError::internal)?;
    indigo::layout(handle);
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn layout(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::layout(handle);
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn clean(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::clean2d(handle);
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn calculate_cip(structure: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::calculate_cip(handle).map_err(AppError::internal)?;
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn automap(reaction: &str, output_format: &str) -> Result<String, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_reaction(reaction).map_err(AppError::bad_request)?;
    indigo::automap(handle, "discard").map_err(AppError::internal)?;
    indigo::convert(handle, output_format).map_err(AppError::internal)
}

pub fn render(structure: &str, output_format: &str) -> Result<(Vec<u8>, String), AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;
    indigo::layout(handle);

    let fmt = match output_format {
        "image/png" | "image/png;base64" => "png",
        "image/svg+xml" | "image/svg+xml;base64" => "svg",
        "application/pdf" | "application/pdf;base64" => "pdf",
        other => other,
    };

    let buf = indigo::render_to_buffer(handle, fmt).map_err(AppError::internal)?;
    let is_base64 = output_format.contains("base64");
    let content_type = if is_base64 {
        output_format.trim_end_matches(";base64").to_owned()
    } else {
        output_format.to_owned()
    };
    Ok((buf, content_type))
}

pub fn calculate(structure: &str, properties: &[String]) -> Result<CalculateResponse, AppError> {
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let handle = indigo::load_structure(structure).map_err(AppError::bad_request)?;

    let mut res = CalculateResponse::default();
    for p in properties {
        match p.as_str() {
            "molecular-weight" => {
                res.molecular_weight = Some(format!("{:.4}", indigo::calculate_mw(handle)));
            }
            "gross" => {
                res.gross = Some(indigo::calculate_gross(handle));
            }
            "most-abundant-mass" => {
                res.most_abundant_mass =
                    Some(format!("{:.4}", indigo::calculate_most_abundant_mass(handle)));
            }
            "monoisotopic-mass" => {
                res.monoisotopic_mass =
                    Some(format!("{:.4}", indigo::calculate_monoisotopic_mass(handle)));
            }
            "mass-composition" => {
                res.mass_composition = Some(indigo::calculate_mass_composition(handle));
            }
            _ => {}
        }
    }
    Ok(res)
}

pub fn check(structure: &str, types: &[String]) -> Result<String, AppError> {
    // Ketcher sometimes omits `valence` and `chiral_flag` from the request.
    // The Indigo API needs them to validate correctly, so we inject them.
    let mut types = types.to_vec();
    for required in &["valence", "chiral_flag"] {
        if !types.iter().any(|t| t == *required) {
            types.push(required.to_string());
        }
    }
    tracing::info!("POST /v2/indigo/check types={types:?}");
    let _sid = indigo::init_session().map_err(AppError::internal)?;
    let types_json =
        serde_json::to_string(&types).map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    indigo::check_structure(structure, &types_json).map_err(AppError::internal)
}
