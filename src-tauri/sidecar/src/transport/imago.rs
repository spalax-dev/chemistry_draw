//! Handlers for `/v2/imago/uploads`.
//!
//! * `POST /v2/imago/uploads` — accepts raw image bytes, creates a job,
//!   runs recognition synchronously, returns the upload id.
//! * `GET /v2/imago/uploads/{id}` — polls job status.

use axum::{
    body::Bytes,
    extract::{Path, State},
    response::Json,
};
use base64::Engine;

use crate::error::AppError;
use crate::job::{ImagoJobStore, JobStatus};
use crate::state::AppState;

/// Accepts an image, creates a recognition job, and returns the upload id.
pub async fn post_upload(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!("POST /v2/imago/uploads size={} content_type_check", body.len());
    
    // Try to handle different input formats
    let image_bytes = if body.is_empty() {
        return Err(AppError::bad_request("empty body"));
    } else if body.starts_with(b"{") {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
            if let Some(file) = json.get("file").and_then(|v| v.as_str()) {
                if let Some(comma_pos) = file.find(',') {
                    let b64 = &file[comma_pos + 1..];
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        tracing::info!("Decoded base64 data URI, size={}", decoded.len());
                        let id = state.imago_store.create();
                        process_and_store(&state.imago_store, &id, &decoded);
                        return Ok(Json(serde_json::json!({ "upload_id": id })));
                    }
                } else if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(file) {
                    tracing::info!("Decoded base64, size={}", decoded.len());
                    let id = state.imago_store.create();
                    process_and_store(&state.imago_store, &id, &decoded);
                    return Ok(Json(serde_json::json!({ "upload_id": id })));
                }
            }
        }
        body.to_vec()
    } else {
        body.to_vec()
    };
    
    let id = state.imago_store.create();
    process_and_store(&state.imago_store, &id, &image_bytes);
    Ok(Json(serde_json::json!({ "upload_id": id })))
}

/// Polls the status of a recognition job.
pub async fn get_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    match state.imago_store.get(&id) {
        Some(JobStatus::Processing) => Ok(Json(serde_json::json!({ "state": "PROCESSING" }))),
        Some(JobStatus::Success { mol_str }) => {
            tracing::info!("Imago job {id} -> SUCCESS");
            Ok(Json(serde_json::json!({
                "state": "SUCCESS",
                "metadata": { "mol_str": mol_str }
            })))
        }
        Some(JobStatus::Failure { error }) => {
            tracing::error!("Imago job {id} -> FAILURE: {error}");
            Ok(Json(serde_json::json!({
                "state": "FAILURE",
                "error": error
            })))
        }
        None => Err(AppError::not_found(format!("upload_id {id} not found"))),
    }
}

fn process_and_store(store: &ImagoJobStore, id: &str, image_bytes: &[u8]) {
    let store_clone = store.clone();
    let id_clone = id.to_string();
    let bytes = image_bytes.to_vec();
    std::thread::spawn(move || {
        let tmp_in = std::env::temp_dir().join(format!("imago_upload_{}.bin", id_clone));
        if let Err(e) = std::fs::write(&tmp_in, &bytes) {
            store_clone.set_failure(&id_clone, format!("failed to write temp: {e}"));
            return;
        }
        let worker = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("imago-worker")))
            .unwrap_or_else(|| std::path::PathBuf::from("imago-worker"));
        if worker.exists() {
            use std::process::Command;
            let output = Command::new(&worker)
                .arg(&tmp_in)
                .env("LD_LIBRARY_PATH", std::env::var("LD_LIBRARY_PATH").unwrap_or_default())
                .output();
            let _ = std::fs::remove_file(&tmp_in);
            match output {
                Ok(out) => {
                    if out.status.success() {
                        let mol = String::from_utf8_lossy(&out.stdout).to_string();
                        if mol.trim().is_empty() {
                            store_clone.set_failure(&id_clone, "empty result".to_string());
                        } else {
                            store_clone.set_success(&id_clone, mol);
                        }
                    } else {
                        let err = String::from_utf8_lossy(&out.stderr).to_string();
                        tracing::error!("Imago worker failed for {id_clone}: {err}");
                        let msg = if err.is_empty() { "recognition failed".to_string() } else { err.trim().to_string() };
                        store_clone.set_failure(&id_clone, msg);
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to spawn imago worker: {e}");
                    store_clone.set_failure(&id_clone, format!("worker spawn failed: {e}"));
                }
            }
        } else {
            let _ = std::fs::remove_file(&tmp_in);
            store_clone.set_failure(&id_clone, "worker not found".to_string());
        }
    });
}
