fn main() {
    // Path absoluto: rustc-link-search se evalúa relativo al TARGET dir
    // del workspace, no al crate. Usar CARGO_MANIFEST_DIR garantiza
    // portabilidad sin importar dónde se compile.
    let lib_path = format!("{}/../lib/linux-x86_64", env!("CARGO_MANIFEST_DIR"));
    println!("cargo:rustc-link-search={lib_path}");
    println!("cargo:rustc-link-lib=dylib=indigo");
    println!("cargo:rustc-link-lib=dylib=indigo-renderer");
    println!("cargo:rustc-link-lib=dylib=imago");

    // RPATH para que linuxdeploy/ldd encuentre libindigo.so al empaquetar AppImage
    // En AppDir: usr/bin/indigo-server → $ORIGIN/../lib = usr/lib/
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
}
