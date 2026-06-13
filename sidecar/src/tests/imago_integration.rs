/// Test de integración Imago: usa una imagen de prueba (caffeine.jpg),
/// ejecuta el pipeline completo (load → filter → recognize) y guarda
/// el molfile resultante en el filesystem para inspección manual.
/// No depende de ImageMagick — usa imagoFilterImage nativo.
#[cfg(test)]
mod imago_integration {
    use std::path::PathBuf;

    /// Usa la imagen caffeine.jpg del test data de Imago.
    /// Pipeline: load_from_file → filter_image → set_config → recognize → molfile cleanup.
    /// El molfile resultante se guarda en /tmp/imago_test_result.mol
    #[test]
    fn imago_full_pipeline_caffeine() {
        let img = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../Imago/api/python/tests/data/caffeine.jpg");

        if !img.exists() {
            eprintln!("SKIP: test image not found at {img:?}");
            return;
        }

        let img_bytes = std::fs::read(&img).expect("read test image");
        let tmp = std::env::temp_dir().join(format!("imago_test_{:x}.png", std::process::id()));
        std::fs::write(&tmp, &img_bytes).expect("write temp");

        // Pipeline completo con filtro
        let sid = crate::indigo::init_session().expect("indigo session");
        crate::imago::init_with_indigo_session(sid);

        crate::imago::load_image_from_file(&tmp.to_string_lossy())
            .expect("load caffeine.jpg");

        crate::imago::filter_image()
            .expect("filter_image");

        crate::imago::set_config(None)
            .expect("set_config");

        let result = crate::imago::recognize().expect("recognize caffeine");

        // Guardar resultado
        let out = std::env::temp_dir().join("imago_test_result.mol");
        std::fs::write(&out, &result).expect("write result");

        // Cleanup via Indigo
        let _sid2 = crate::indigo::init_session().unwrap();
        crate::indigo::set_option_bool("ignore-stereochemistry-errors", 1);
        let cleaned = crate::indigo::load_structure(&result)
            .and_then(|h| {
                crate::indigo::layout(h);
                crate::indigo::convert(h, "chemical/x-daylight-smiles")
            })
            .unwrap_or_else(|_| "CLEANUP_FAILED".into());

        let _ = std::fs::remove_file(&tmp);

        println!("Raw molfile: {} chars → {}", result.len(), out.display());
        println!("Cleaned SMILES: {}", cleaned);
        assert!(!result.is_empty(), "result must not be empty");
        assert!(result.contains("V2000") || result.contains("V3000"), "must be a valid molfile");
    }
}
