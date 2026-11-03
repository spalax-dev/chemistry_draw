fn main() {
    // Path absoluto: rustc-link-search se evalúa relativo al TARGET dir
    // del workspace, no al crate. Usar CARGO_MANIFEST_DIR garantiza
    // portabilidad sin importar dónde se compile.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let lib_dir = if target_os == "windows" {
        "windows-x86_64"
    } else {
        "linux-x86_64"
    };
    let lib_path = format!("{}/../lib/{lib_dir}", env!("CARGO_MANIFEST_DIR"));

    println!("cargo:rustc-link-search={lib_path}");
    println!("cargo:rustc-link-lib=dylib=indigo");
    println!("cargo:rustc-link-lib=dylib=indigo-renderer");

    // Imago (and therefore OpenCV) is Linux-only: the Windows build ships a
    // stub and never links libimago.
    if target_os != "windows" {
        println!("cargo:rustc-link-lib=dylib=imago");
        // RPATH para que linuxdeploy/ldd encuentre libindigo.so al empaquetar AppImage
        // En AppDir: usr/bin/indigo-server → $ORIGIN/../lib = usr/lib/
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    }

    println!("cargo:rerun-if-changed=build.rs");
}
