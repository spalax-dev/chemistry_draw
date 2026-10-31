//! Entry point. Reads `INDIGO_PORT` (default 9321), starts axum with CORS.
//!
//! If the requested port is busy (another instance is running, or a stale
//! process), it walks forward until it finds a free one and prints the chosen
//! port so the host can tell the frontend where to connect. It never panics on
//! a busy port.

use std::net::SocketAddr;

use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info};

use indigo_server::{build_router, AppState, ImagoJobStore};

/// Ports to try starting from `preferred` before falling back to an ephemeral one.
const PORT_SCAN_RANGE: u16 = 20;

/// Exit if the process that launched us disappears.
///
/// Tauri kills the sidecar on a clean exit, but if the app crashes or is
/// SIGKILLed the child would be orphaned and keep the port bound.
///
/// The reliable signal is stdin: Tauri gives the sidecar a pipe, and the pipe
/// closes when the parent process dies. Reparenting (ppid change) is only used
/// as a fallback when stdin is not a pipe (e.g. a manual run from a terminal).
///
/// Set `INDIGO_NO_PARENT_WATCHDOG=1` to disable it (e.g. when running the server
/// as a standalone daemon that is supposed to outlive its launcher).
fn spawn_parent_watchdog() {
    if std::env::var("INDIGO_NO_PARENT_WATCHDOG").is_ok() {
        return;
    }

    if stdin_is_pipe() {
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
        return;
    }

    // Fallback for runs without a piped stdin.
    let initial_parent = std::os::unix::process::parent_id();
    if initial_parent == 1 {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let parent = std::os::unix::process::parent_id();
        if parent != initial_parent {
            eprintln!("parent process exited (ppid {initial_parent} -> {parent}); shutting down");
            std::process::exit(0);
        }
    });
}

/// True when fd 0 is a FIFO/pipe (which is what Tauri hands to the sidecar).
fn stdin_is_pipe() -> bool {
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(libc::STDIN_FILENO, &mut stat) != 0 {
            return false;
        }
        (stat.st_mode & libc::S_IFMT) == libc::S_IFIFO
    }
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

#[tokio::main]
async fn main() {
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

    let state = AppState {
        _port: port,
        imago_store: ImagoJobStore::new(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = build_router(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    if let Err(e) = axum::serve(listener, app).await {
        error!("server failed: {e}");
        std::process::exit(1);
    }
}
