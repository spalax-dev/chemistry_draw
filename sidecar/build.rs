fn main() {
    println!("cargo:rustc-link-search=../lib/linux-x86_64");
    println!("cargo:rustc-link-lib=dylib=indigo");
    println!("cargo:rustc-link-lib=dylib=indigo-renderer");
}
