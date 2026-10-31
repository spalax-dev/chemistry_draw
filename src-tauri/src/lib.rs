#[allow(unused_imports)]
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Port the sidecar ended up listening on.
#[derive(Clone)]
struct IndigoPort(Arc<Mutex<u16>>);

/// Handle to the sidecar process so it can be killed when the app exits.
/// Without this the child is orphaned and keeps its port bound.
#[derive(Clone, Default)]
struct SidecarProcess(Arc<Mutex<Option<CommandChild>>>);

#[tauri::command]
fn indigo_port(state: tauri::State<'_, IndigoPort>) -> u16 {
    *state.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pick a port we can actually listen on. Prefers `preferred`, then any free
/// port. The sidecar does the real bind and reports back, but choosing an
/// unused port here means the frontend never probes a port that belongs to
/// another (stale) instance.
fn pick_free_port(preferred: u16) -> u16 {
    use std::net::TcpListener;

    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    preferred
}

fn kill_sidecar(process: &SidecarProcess) {
    let child = process.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(child) = child {
        println!("[chemistry-draw] stopping indigo-server");
        if let Err(e) = child.kill() {
            eprintln!("[chemistry-draw] could not stop indigo-server: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![indigo_port])
        .setup(|app| {
            let preferred_port: u16 = std::env::var("INDIGO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9321);
            let port = pick_free_port(preferred_port);

            let port_state = IndigoPort(Arc::new(Mutex::new(port)));
            app.manage(port_state.clone());

            let sidecar_state = SidecarProcess::default();
            app.manage(sidecar_state.clone());

            // En dev: ruta absoluta desde el source tree
            // En prod: resource_dir contiene las .so copiadas por el bundle
            #[cfg(debug_assertions)]
            let lib_path = {
                let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                manifest_dir
                    .join("lib/linux-x86_64")
                    .to_string_lossy()
                    .to_string()
            };
            #[cfg(not(debug_assertions))]
            let lib_path = {
                let p = app.path().resource_dir().unwrap_or_else(|_|
                    std::env::current_dir().unwrap_or_default()
                );
                p.join("lib").join("linux-x86_64").to_string_lossy().to_string()
            };
            println!("[chemistry-draw] LD_LIBRARY_PATH = {}", lib_path);

            let sidecar_cmd = app
                .shell()
                .sidecar("indigo-server")
                .expect("Failed to create indigo-server sidecar command")
                .env("INDIGO_PORT", port.to_string())
                .env("LD_LIBRARY_PATH", lib_path);

            tauri::async_runtime::spawn(async move {
                match sidecar_cmd.spawn() {
                    Ok((mut rx, child)) => {
                        // Keep the handle so we can kill it on exit.
                        *sidecar_state.0.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(child);

                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    let text = String::from_utf8_lossy(&line).to_string();
                                    // The sidecar reports the port it actually bound
                                    // to, which may differ if the preferred one was busy.
                                    if let Some(rest) = text.trim().strip_prefix("INDIGO_PORT=") {
                                        if let Ok(actual) = rest.trim().parse::<u16>() {
                                            if let Ok(mut current) = port_state.0.lock() {
                                                *current = actual;
                                            }
                                            println!(
                                                "[chemistry-draw] indigo-server port = {actual}"
                                            );
                                        }
                                    }
                                    println!("[indigo-server] {}", text.trim_end());
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
                                    // Drop the stale handle so we don't try to kill
                                    // an already dead process.
                                    *sidecar_state
                                        .0
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner()) = None;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[chemistry-draw] sidecar spawn failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Covers normal quit, last-window-closed and Ctrl+C in dev.
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarProcess>() {
                kill_sidecar(state.inner());
            }
        }
    });
}
