//! Entry point. Reads `INDIGO_PORT` (default 9321), starts axum with CORS.
//!
//! If the requested port is busy (another instance is running, or a stale
//! process), it walks forward until it finds a free one and prints the chosen
//! port so the host can tell the frontend where to connect. It never panics on
//! a busy port.

#[cfg(windows)]
use std::io::IsTerminal;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info};

use indigo_server::service::ml::paths::resolve_models_dir;
use indigo_server::{build_router, AppState};

/// Ports to try starting from `preferred` before falling back to an ephemeral one.
const PORT_SCAN_RANGE: u16 = 20;

/// Exit if the process that launched us disappears.
///
/// Tauri kills the sidecar on a clean exit, but if the app crashes or is
/// SIGKILLed the child would be orphaned and keep the port bound.
///
/// The reliable signal is stdin: Tauri gives the sidecar a pipe, and the pipe
/// closes when the parent process dies. On Unix, reparenting (ppid change) is
/// used as a fallback when stdin is not a pipe (e.g. a manual run from a
/// terminal, or `indigo-server < /dev/null`).
///
/// Set `INDIGO_NO_PARENT_WATCHDOG=1` to disable it (e.g. when running the server
/// as a standalone daemon that is supposed to outlive its launcher).
fn spawn_parent_watchdog() {
    if std::env::var("INDIGO_NO_PARENT_WATCHDOG").is_ok() {
        return;
    }

    if stdin_is_pipe() {
        spawn_stdin_watcher();
    } else {
        // Fallback for Unix runs without a piped stdin.
        #[cfg(unix)]
        {
            let initial_parent = std::os::unix::process::parent_id();
            if initial_parent == 1 {
                return;
            }
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let parent = std::os::unix::process::parent_id();
                if parent != initial_parent {
                    eprintln!(
                        "parent process exited (ppid {initial_parent} -> {parent}); shutting down"
                    );
                    std::process::exit(0);
                }
            });
        }
    }
}

/// Reads stdin until EOF; exits when the parent closes the pipe.
fn spawn_stdin_watcher() {
    // Parent death closes the pipe -> EOF -> we shut down.
    std::thread::spawn(|| {
        let mut buf = [0u8; 64];
        let mut stdin = std::io::stdin();
        loop {
            match std::io::Read::read(&mut stdin, &mut buf) {
                Ok(0) | Err(_) => {
                    eprintln!("stdin closed; parent exited, shutting down");
                    std::process::exit(0);
                }
                Ok(_) => {} // Ignore any input; we only care about EOF.
            }
        }
    });
}

/// True when stdin is the pipe Tauri hands to the sidecar.
///
/// Unix keeps the original FIFO check: terminals, regular files and
/// `/dev/null` must not be mistaken for a parent pipe, or a shell redirect
/// would shut the server down immediately.
#[cfg(unix)]
fn stdin_is_pipe() -> bool {
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(libc::STDIN_FILENO, &mut stat) != 0 {
            return false;
        }
        (stat.st_mode & libc::S_IFMT) == libc::S_IFIFO
    }
}

/// Windows has no `fstat`/`S_IFIFO` equivalent in `libc`; a non-terminal
/// stdin is the pipe provided by Tauri (`IsTerminal` handles both consoles
/// and redirected handles).
#[cfg(windows)]
fn stdin_is_pipe() -> bool {
    !std::io::stdin().is_terminal()
}

async fn bind(preferred: u16) -> std::io::Result<(TcpListener, u16)> {
    for offset in 0..PORT_SCAN_RANGE {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match TcpListener::bind(addr).await {
            Ok(listener) => return Ok((listener, port)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                info!("port {port} already in use, trying next");
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    // Last resort: let the OS pick a free port.
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let port = listener.local_addr()?.port();
    info!("falling back to ephemeral port {port}");
    Ok((listener, port))
}

/// Resolves the model root.
///
/// `CHEMISTRY_MODELS_DIR` always wins. Otherwise an existing `<repo>/models` is
/// used; a release build launched elsewhere falls back to `models` in the
/// working directory.
fn models_dir() -> PathBuf {
    let explicit = std::env::var_os("CHEMISTRY_MODELS_DIR").map(PathBuf::from);
    let repo_models = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(|repo| repo.join("models"))
        .unwrap_or_else(|| PathBuf::from("models"));

    resolve_models_dir(explicit, repo_models)
}

#[tokio::main]
async fn main() {
    // Panics would otherwise vanish into the sidecar's stderr, which the host
    // forwards to the log file but without location information.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        eprintln!("PANIC at {location}: {info}");
    }));

    tracing_subscriber::fmt()
        .with_target(true)
        .with_thread_ids(true)
        .with_line_number(true)
        .with_level(true)
        .init();

    spawn_parent_watchdog();

    let preferred: u16 = std::env::var("INDIGO_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9321);

    let (listener, port) = match bind(preferred).await {
        Ok(bound) => bound,
        Err(e) => {
            error!("could not bind any port starting at {preferred}: {e}");
            std::process::exit(1);
        }
    };

    // The host parses this line to learn the real port.
    println!("INDIGO_PORT={port}");
    info!("indigo-server listening on http://127.0.0.1:{port}");

    let models_dir = models_dir();
    info!("model root: {}", models_dir.display());
    let state = AppState::new(port, models_dir);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = build_router(state)
        .layer(TraceLayer::new_for_http().on_failure(()))
        .layer(cors);

    if let Err(e) = axum::serve(listener, app).await {
        error!("server failed: {e}");
        std::process::exit(1);
    }
}
