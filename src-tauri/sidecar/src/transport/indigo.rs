//! Handlers for `/v2/indigo/*` endpoints.
//!
//! Each handler delegates to [`indigo_ops`], mapping [`AppError`] to HTTP.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};

use crate::error::AppError;
use crate::service::{indigo_ops, types::*};

pub async fn get_indigo_info() -> Json<serde_json::Value> {
    super::info::get_info().await
}

pub async fn post_convert(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::convert(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_aromatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::aromatize(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_dearomatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::dearomatize(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_layout(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::layout(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_clean(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::clean(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_calculate_cip(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::calculate_cip(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_automap(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, AppError> {
    let result = indigo_ops::automap(&payload.struct_, &payload.output_format)?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

pub async fn post_render(
    Json(payload): Json<RenderRequest>,
) -> Result<Response, AppError> {
    let (buf, content_type) = indigo_ops::render(&payload.struct_, &payload.output_format)?;

    let is_base64 = payload.output_format.contains("base64");
    if is_base64 {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(Json(serde_json::json!({
            "data": b64,
            "content-type": content_type,
        }))
        .into_response())
    } else {
        Ok((
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            buf,
        )
            .into_response())
    }
}

pub async fn post_calculate(
    Json(payload): Json<CalculateRequest>,
) -> Result<Json<CalculateResponse>, AppError> {
    Ok(Json(indigo_ops::calculate(
        &payload.struct_,
        &payload.properties,
    )?))
}

pub async fn post_check(
    Json(payload): Json<CheckRequest>,
) -> Result<Response, AppError> {
    let result = indigo_ops::check(&payload.struct_, &payload.types)?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        result,
    )
        .into_response())
}
