use axum::{
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};

use crate::{indigo, models::*};

#[derive(Clone)]
pub struct AppState {
    pub port: u16,
}

// ─── Info ──────────────────────────────────────────────────────

pub async fn get_info() -> impl IntoResponse {
    let v = indigo::version();
    Json(serde_json::json!({
        "Indigo": { "version": v }
    }))
}

// ─── Convert ───────────────────────────────────────────────────

pub async fn post_convert(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Aromatize ─────────────────────────────────────────────────

pub async fn post_aromatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::aromatize(handle).map_err(|e| error_500(&e.to_string()))?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Dearomatize ───────────────────────────────────────────────

pub async fn post_dearomatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::dearomatize(handle).map_err(|e| error_500(&e.to_string()))?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Layout ────────────────────────────────────────────────────

pub async fn post_layout(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Clean 2D ──────────────────────────────────────────────────

pub async fn post_clean(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::clean2d(handle);
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Render ────────────────────────────────────────────────────

pub async fn post_render(
    Json(payload): Json<RenderRequest>,
) -> Result<Response, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::layout(handle);

    let fmt = match payload.output_format.as_str() {
        "image/png" | "image/png;base64" => "png",
        "image/svg+xml" | "image/svg;base64" => "svg",
        "application/pdf" | "application/pdf;base64" => "pdf",
        other => other,
    };

    let buf = indigo::render_to_buffer(handle, fmt)
        .map_err(|e| error_500(&e.to_string()))?;

    let is_base64 = payload.output_format.contains("base64");
    let content_type = if is_base64 {
        payload.output_format.trim_end_matches(";base64").to_owned()
    } else {
        payload.output_format.clone()
    };

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
            [(axum::http::header::CONTENT_TYPE, content_type)],
            buf,
        )
            .into_response())
    }
}

// ─── Calculate ─────────────────────────────────────────────────

pub async fn post_calculate(
    Json(payload): Json<CalculateRequest>,
) -> Result<Json<CalculateResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;

    let mut res = CalculateResponse {
        molecular_weight: None,
        gross: None,
        most_abundant_mass: None,
        monoisotopic_mass: None,
        mass_composition: None,
    };

    for p in &payload.properties {
        match p.as_str() {
            "molecular-weight" => {
                let v = indigo::calculate_mw(handle);
                res.molecular_weight = Some(format!("{:.4}", v));
            }
            "gross" => {
                res.gross = Some(indigo::calculate_gross(handle));
            }
            _ => {}
        }
    }

    Ok(Json(res))
}

// ─── Check ─────────────────────────────────────────────────────

pub async fn post_check(
    Json(payload): Json<CheckRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let types_json = serde_json::to_string(&payload.types)
        .map_err(|e| error_500(&e.to_string()))?;
    let result = indigo::check_structure(&payload.struct_, &types_json)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok((StatusCode::OK, [("content-type", "application/json")], result))
}

// ─── Calculate CIP ─────────────────────────────────────────────

pub async fn post_calculate_cip(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::calculate_cip(handle).map_err(|e| error_500(&e.to_string()))?;
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Automap ───────────────────────────────────────────────────

pub async fn post_automap(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    let _sid = indigo::init_session().map_err(|e| error_500(&e.to_string()))?;
    let handle = indigo::load_structure(&payload.struct_)
        .map_err(|e| error_400(&e.to_string()))?;
    indigo::automap(handle, "discard").map_err(|e| error_500(&e.to_string()))?;
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| error_500(&e.to_string()))?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Error helpers ─────────────────────────────────────────────

fn error_400(msg: &str) -> (StatusCode, Json<IndigoError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(IndigoError {
            error: msg.into(),
        }),
    )
}

fn error_500(msg: &str) -> (StatusCode, Json<IndigoError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(IndigoError {
            error: msg.into(),
        }),
    )
}
