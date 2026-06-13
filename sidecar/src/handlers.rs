use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use tracing::{error, info};

use crate::{imago, imago_jobs::ImagoJobStore, indigo, models::*};

#[derive(Clone)]
pub struct AppState {
    pub _port: u16,
    pub imago_store: crate::imago_jobs::ImagoJobStore,
}

// ─── Info ──────────────────────────────────────────────────────

pub async fn get_info() -> impl IntoResponse {
    info!("GET /v2/info");
    let v = indigo::version();
    let imago_v = imago::versions();
    Json(serde_json::json!({
        "Indigo": { "version": v },
        "imago_versions": imago_v,
        "indigo_version": v,
        "api_path": "http://localhost:9321/v2"
    }))
}

// ─── Convert ───────────────────────────────────────────────────

pub async fn post_convert(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/convert fmt={}", payload.output_format);
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format).map_err(|e| {
        error!("convert: {e}");
        error_500(&e.to_string())
    })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Aromatize ─────────────────────────────────────────────────

pub async fn post_aromatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/aromatize");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::aromatize(handle).map_err(|e| {
        error!("aromatize: {e}");
        error_500(&e.to_string())
    })?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format).map_err(|e| {
        error!("convert: {e}");
        error_500(&e.to_string())
    })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Dearomatize ───────────────────────────────────────────────

pub async fn post_dearomatize(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/dearomatize");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::dearomatize(handle).map_err(|e| {
        error!("dearomatize: {e}");
        error_500(&e.to_string())
    })?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format).map_err(|e| {
        error!("convert: {e}");
        error_500(&e.to_string())
    })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Layout ────────────────────────────────────────────────────

pub async fn post_layout(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/layout");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::layout(handle);
    let result = indigo::convert(handle, &payload.output_format).map_err(|e| {
        error!("convert: {e}");
        error_500(&e.to_string())
    })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Clean 2D ──────────────────────────────────────────────────

pub async fn post_clean(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/clean");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::clean2d(handle);
    let result = indigo::convert(handle, &payload.output_format).map_err(|e| {
        error!("convert: {e}");
        error_500(&e.to_string())
    })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Render ────────────────────────────────────────────────────

pub async fn post_render(
    Json(payload): Json<RenderRequest>,
) -> Result<Response, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/render fmt={}", payload.output_format);
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::layout(handle);

    let fmt = match payload.output_format.as_str() {
        "image/png" | "image/png;base64" => "png",
        "image/svg+xml" | "image/svg;base64" => "svg",
        "application/pdf" | "application/pdf;base64" => "pdf",
        other => other,
    };

    let buf = indigo::render_to_buffer(handle, fmt).map_err(|e| {
        error!("render: {e}");
        error_500(&e.to_string())
    })?;

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
    info!("POST /v2/indigo/calculate props={:?}", payload.properties);
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;

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
    let mut types = payload.types.clone();
    for required in &["valence", "chiral_flag"] {
        if !types.iter().any(|t| t == *required) {
            types.push(required.to_string());
        }
    }
    info!("POST /v2/indigo/check types={:?}", types);
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let types_json = serde_json::to_string(&types)
        .map_err(|e| error_500(&e.to_string()))?;
    let result = indigo::check_structure(&payload.struct_, &types_json)
        .map_err(|e| {
            error!("check_structure: {e}");
            error_500(&e.to_string())
        })?;
    Ok((StatusCode::OK, [("content-type", "application/json")], result))
}

// ─── Calculate CIP ─────────────────────────────────────────────

pub async fn post_calculate_cip(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/calculate_cip");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_structure(&payload.struct_).map_err(|e| {
        error!("load_structure: {e}");
        error_400(&e.to_string())
    })?;
    indigo::calculate_cip(handle).map_err(|e| {
        error!("calculate_cip: {e}");
        error_500(&e.to_string())
    })?;
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| {
            error!("convert: {e}");
            error_500(&e.to_string())
        })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Automap ───────────────────────────────────────────────────

pub async fn post_automap(
    Json(payload): Json<IndigoRequest>,
) -> Result<Json<IndigoResponse>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/indigo/automap");
    let _sid = indigo::init_session().map_err(|e| {
        error!("init_session: {e}");
        error_500(&e.to_string())
    })?;
    let handle = indigo::load_reaction(&payload.struct_).map_err(|e| {
        error!("load_reaction: {e}");
        error_400(&e.to_string())
    })?;
    indigo::automap(handle, "discard").map_err(|e| {
        error!("automap: {e}");
        error_500(&e.to_string())
    })?;
    let result = indigo::convert(handle, &payload.output_format)
        .map_err(|e| {
            error!("convert: {e}");
            error_500(&e.to_string())
        })?;
    Ok(Json(IndigoResponse {
        struct_: result,
        format: payload.output_format,
    }))
}

// ─── Imago: Image Recognition ──────────────────────────────────

pub async fn post_imago_upload(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<IndigoError>)> {
    info!("POST /v2/imago/uploads size={}", body.len());
    let id = state.imago_store.create();
    let id_clone = id.clone();
    let body_vec = body.to_vec();

    process_imago(&state.imago_store, &id_clone, &body_vec);

    Ok(Json(serde_json::json!({ "upload_id": id })))
}

pub async fn get_imago_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<IndigoError>)> {
    match state.imago_store.get(&id) {
        Some(crate::imago_jobs::JobStatus::Processing) => {
            Ok(Json(serde_json::json!({ "state": "PROCESSING" })))
        }
        Some(crate::imago_jobs::JobStatus::Success { mol_str }) => {
            info!("GET /v2/imago/uploads/{id} -> SUCCESS");
            Ok(Json(serde_json::json!({
                "state": "SUCCESS",
                "metadata": { "mol_str": mol_str }
            })))
        }
        Some(crate::imago_jobs::JobStatus::Failure { error }) => {
            error!("Imago recognition failed: {error}");
            Ok(Json(serde_json::json!({
                "state": "FAILURE",
                "error": error
            })))
        }
        None => Err((
            StatusCode::NOT_FOUND,
            Json(IndigoError {
                error: format!("upload_id {} not found", id),
            }),
        )),
    }
}

fn process_imago(store: &ImagoJobStore, id: &str, image_bytes: &[u8]) {
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join(format!("imago_in_{id}.png"));

    if let Err(e) = std::fs::write(&input_path, image_bytes) {
        store.set_failure(id, format!("write temp: {e}"));
        return;
    }

    info!("[imago] input={input_path:?}");

    let indigo_sid = match crate::indigo::init_session() {
        Ok(s) => s,
        Err(e) => {
            store.set_failure(id, format!("indigo session: {e}"));
            let _ = std::fs::remove_file(&input_path);
            return;
        }
    };
    crate::imago::init_with_indigo_session(indigo_sid);

    let path_str = input_path.to_string_lossy();
    if let Err(e) = imago::load_image_from_file(&path_str) {
        store.set_failure(id, format!("load: {e}"));
        let _ = std::fs::remove_file(&input_path);
        return;
    }

    if let Err(e) = imago::filter_image() {
        store.set_failure(id, format!("filter: {e}"));
        let _ = std::fs::remove_file(&input_path);
        return;
    }

    if let Err(e) = imago::set_config(None) {
        store.set_failure(id, format!("config: {e}"));
        let _ = std::fs::remove_file(&input_path);
        return;
    }

    match imago::recognize() {
        Ok(mol_str) if !mol_str.trim().is_empty() => {
            let cleaned = (|| -> anyhow::Result<String> {
                let _sid = crate::indigo::init_session()?;
                crate::indigo::set_option_bool("ignore-stereochemistry-errors", 1);
                let h = crate::indigo::load_structure(&mol_str)?;
                crate::indigo::layout(h);
                crate::indigo::convert(h, "")
            })()
            .unwrap_or(mol_str);
            store.set_success(id, cleaned);
        }
        Ok(_) => {
            store.set_failure(id, "imago produced empty molfile".into());
        }
        Err(e) => {
            store.set_failure(id, format!("recognize: {e}"));
        }
    }

    let _ = std::fs::remove_file(&input_path);
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
