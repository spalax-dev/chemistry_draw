// Tests para el pipeline de reconocimiento de imágenes con Imago v2.
//
// Imago convierte imágenes de estructuras químicas en molfiles.
// El pipeline es: load_from_file → filter_image → set_config → recognize.
//
// Requiere libimago.so y una imagen de prueba (caffeine.jpg del test data de Imago).
// Si la imagen no existe, los tests se saltan (no fallan).
//
// Casos cubiertos:
//   - Pipeline completo con filtro (imagen real → molfile)
//   - Verificación de formato del molfile resultante
//   - Cleanup via Indigo (load → layout → convert a SMILES)
//   - Manejo de imagen inexistente (skip gracefully)

use crate::tests::*;
use axum::http::StatusCode;
use std::path::PathBuf;

fn test_image() -> Option<PathBuf> {
    let img = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../Imago/api/python/tests/data/caffeine.jpg");
    if img.exists() {
        Some(img)
    } else {
        None
    }
}

/// Verifica que el pipeline completo (load → filter → config → recognize)
/// produce un molfile válido a partir de una imagen real.
/// Usa caffeine.jpg del test data de Imago.
#[tokio::test]
async fn full_pipeline_produces_valid_molfile() {
    let img = match test_image() {
        Some(p) => p,
        None => return,
    };

    let bytes = std::fs::read(&img).expect("read test image");
    let tmp = std::env::temp_dir().join(format!("imago_test_{:x}.png", std::process::id()));
    std::fs::write(&tmp, &bytes).expect("write temp");

    // Pipeline completo
    let sid = crate::ffi::indigo::init_session().expect("indigo session");
    crate::ffi::imago::init_with_indigo_session(sid);

    crate::ffi::imago::load_image_from_file(&tmp.to_string_lossy())
        .expect("load caffeine image from file");
    crate::ffi::imago::filter_image()
        .expect("filter_image (binarize + preprocess)");
    crate::ffi::imago::set_config(None)
        .expect("set_config auto-detect");

    let mol = crate::ffi::imago::recognize().expect("recognize structure");

    let _ = std::fs::remove_file(&tmp);

    assert!(!mol.is_empty(), "molfile must not be empty");
    assert!(
        mol.contains("V2000") || mol.contains("V3000"),
        "molfile must be V2000 or V3000 format, got: {}",
        &mol[..100]
    );
}

/// Verifica que el molfile de Imago puede ser re-cargado por Indigo
/// después del cleanup con ignore-stereochemistry-errors.
/// El SMILES resultante debe ser una cadena no vacía.
#[tokio::test]
async fn recognized_molfile_cleanup_through_indigo() {
    let img = match test_image() {
        Some(p) => p,
        None => return,
    };

    let bytes = std::fs::read(&img).expect("read test image");
    let tmp = std::env::temp_dir().join(format!("imago_cleanup_{:x}.png", std::process::id()));
    std::fs::write(&tmp, &bytes).expect("write temp");

    let sid = crate::ffi::indigo::init_session().expect("indigo session");
    crate::ffi::imago::init_with_indigo_session(sid);
    crate::ffi::imago::load_image_from_file(&tmp.to_string_lossy()).expect("load");
    crate::ffi::imago::filter_image().expect("filter");
    crate::ffi::imago::set_config(None).expect("config");
    let mol = crate::ffi::imago::recognize().expect("recognize");

    let _ = std::fs::remove_file(&tmp);

    // Cleanup: pasar el molfile por Indigo para normalizar
    let _sid2 = crate::ffi::indigo::init_session().unwrap();
    crate::ffi::indigo::set_option_bool("ignore-stereochemistry-errors", 1);
    let smiles = crate::ffi::indigo::load_structure(&mol)
        .and_then(|h| {
            crate::ffi::indigo::layout(h);
            crate::ffi::indigo::convert(h, "chemical/x-daylight-smiles")
        })
        .expect("cleanup should succeed");

    assert!(!smiles.is_empty(), "cleaned SMILES must not be empty");
    assert!(
        smiles.contains('C') || smiles.contains('c'),
        "SMILES must contain carbon, got: {smiles}"
    );
}

/// El pipeline debe manejar gracefully una imagen que no existe.
/// No debe panickear ni crashear con SIGSEGV.
#[tokio::test]
async fn missing_image_does_not_panic() {
    let sid = crate::ffi::indigo::init_session().expect("indigo session");
    crate::ffi::imago::init_with_indigo_session(sid);

    // load_image_from_file con archivo inexistente no debe panickear
    let _ = crate::ffi::imago::load_image_from_file("/tmp/does_not_exist_xyz.png");

    // Verificar que no crasheó — si llegamos aquí, está bien
}

/// Múltiples pipelines secuenciales no deben interferir entre sí.
/// Cada reconocimiento debe producir un resultado independiente.
#[tokio::test]
async fn sequential_pipelines_are_independent() {
    let img = match test_image() {
        Some(p) => p,
        None => return,
    };

    let bytes = std::fs::read(&img).expect("read test image");

    let mut results = Vec::new();
    for i in 0..2 {
        let tmp = std::env::temp_dir().join(format!("imago_seq_{i}_{:x}.png", std::process::id()));
        std::fs::write(&tmp, &bytes).expect("write temp");

        let sid = crate::ffi::indigo::init_session().expect("indigo session");
        crate::ffi::imago::init_with_indigo_session(sid);
        crate::ffi::imago::load_image_from_file(&tmp.to_string_lossy()).expect("load");
        crate::ffi::imago::filter_image().expect("filter");
        crate::ffi::imago::set_config(None).expect("config");
        let mol = crate::ffi::imago::recognize().expect("recognize");

        let _ = std::fs::remove_file(&tmp);
        results.push(mol);
    }

    assert_eq!(results.len(), 2, "should have 2 results");
    assert!(!results[0].is_empty(), "first result must not be empty");
    assert!(!results[1].is_empty(), "second result must not be empty");
}

/// El endpoint GET /v2/info debe incluir imago_versions en la respuesta.
/// Ketcher usa este campo para habilitar el botón "Recognize Molecule"
/// y para poblar el dropdown de versión de Imago.
#[tokio::test]
async fn info_endpoint_includes_imago_versions() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/info").await;

    assert_eq!(status, StatusCode::OK);
    let versions = body["imago_versions"].as_array()
        .expect("imago_versions must be an array");
    assert!(!versions.is_empty(), "imago_versions must not be empty");
    assert!(versions.contains(&serde_json::json!("2")), "must include version 2");
}
