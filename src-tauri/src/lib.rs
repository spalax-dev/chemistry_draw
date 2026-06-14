#[allow(unused_imports)]
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port: u16 = std::env::var("INDIGO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9321);

            // En dev: ruta absoluta desde el source tree
            // En prod: resource_dir contiene las .so copiadas por el bundle
            #[cfg(debug_assertions)]
            let lib_path = {
                let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                manifest_dir.join("lib/linux-x86_64")
            };
            #[cfg(not(debug_assertions))]
            let lib_path = {
                let p = app.path().resource_dir().unwrap_or_else(|_|
                    std::env::current_dir().unwrap_or_default()
                );
                p.join("lib").join("linux-x86_64")
            };
            println!("[chemistry-draw] LD_LIBRARY_PATH = {}", lib_path.display());

            let sidecar_cmd = app
                .shell()
                .sidecar("indigo-server")
                .expect("Failed to create indigo-server sidecar command")
                .env("INDIGO_PORT", port.to_string())
                .env(
                    "LD_LIBRARY_PATH",
                    lib_path.to_string_lossy().to_string(),
                );

            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                match sidecar_cmd.spawn() {
                    Ok((mut rx, _child)) => {
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    println!(
                                        "[indigo-server] {}",
                                        String::from_utf8_lossy(&line)
                                    );
                                }
                                CommandEvent::Stderr(line) => {
                                    eprintln!(
                                        "[indigo-server:err] {}",
                                        String::from_utf8_lossy(&line)
                                    );
                                }
                                CommandEvent::Terminated(payload) => {
                                    eprintln!(
                                        "[indigo-server] exited with {:?}",
                                        payload.code
                                    );
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        // Probablemente el puerto ya está en uso (hot reload)
                        // El sidecar viejo sigue corriendo → no es fatal
                        eprintln!("[chemistry-draw] sidecar spawn failed (may be already running): {e}");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
