#[allow(unused_imports)]
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
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

/// Directory holding the rotated log files.
///
/// Exposed as a command so the UI (or a support workflow) can point users at
/// the logs without hardcoding platform-specific paths.
#[tauri::command]
fn log_dir(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// Remove ANSI SGR sequences (the sidecar's `tracing` output is colorized when
/// it detects a terminal). Log files should stay readable.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
                          // Skip parameter/intermediate bytes until the final byte (@-~).
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
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
        log::info!("[chemistry-draw] stopping indigo-server");
        if let Err(e) = child.kill() {
            log::error!("[chemistry-draw] could not stop indigo-server: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log panics with their location instead of losing them on stderr.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));

    let app = tauri::Builder::default()
        // Registered first so the other plugins and the setup hook can log.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("chemistry-draw".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                // Keep the last handful of files instead of growing forever.
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![indigo_port, log_dir])
        .setup(|app| {
            log::info!(
                "[chemistry-draw] starting version {}",
                app.package_info().version
            );
            if let Ok(dir) = app.path().app_log_dir() {
                log::info!("[chemistry-draw] logs directory: {}", dir.display());
            }
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
                let p = app
                    .path()
                    .resource_dir()
                    .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
                p.join("lib")
                    .join("linux-x86_64")
                    .to_string_lossy()
                    .to_string()
            };
            println!("[chemistry-draw] LD_LIBRARY_PATH = {}", lib_path);
            log::info!("[chemistry-draw] LD_LIBRARY_PATH = {lib_path}");

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
                        *sidecar_state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                                    // The sidecar reports the port it actually bound
                                    // to, which may differ if the preferred one was busy.
                                    if let Some(rest) = text.trim().strip_prefix("INDIGO_PORT=") {
                                        if let Ok(actual) = rest.trim().parse::<u16>() {
                                            if let Ok(mut current) = port_state.0.lock() {
                                                *current = actual;
                                            }
                                            log::info!(
                                                "[chemistry-draw] indigo-server port = {actual}"
                                            );
                                        }
                                    }
                                    log::info!(target: "indigo-server", "{}", text.trim_end());
                                }
                                CommandEvent::Stderr(line) => {
                                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                                    log::warn!(target: "indigo-server", "{}", text.trim_end());
                                }
                                CommandEvent::Terminated(payload) => {
                                    log::error!(
                                        "[chemistry-draw] indigo-server exited with {:?}",
                                        payload.code
                                    );
                                    // Drop the stale handle so we don't try to kill
                                    // an already dead process.
                                    *sidecar_state.0.lock().unwrap_or_else(|e| e.into_inner()) =
                                        None;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("[chemistry-draw] sidecar spawn failed: {e}");
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
