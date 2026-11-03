//! One-shot Imago OCR worker: reads an image path, writes a molfile to stdout.
//!
//! On Windows there is no Imago/OpenCV, so this binary is a stub that exits
//! with a clear error. It is never bundled or listed in `externalBin` there;
//! the stub only exists so `cargo build --all-targets` keeps working.

#[cfg(windows)]
fn main() {
    eprintln!("imago-worker is not available in the Windows build: Imago is disabled");
    std::process::exit(1);
}

#[cfg(not(windows))]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        std::process::exit(1);
    }

    let input_path = &args[1];
    let bytes = match std::fs::read(input_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Failed to read input: {}", e);
            std::process::exit(2);
        }
    };

    // Set up signal handling to avoid crashes
    std::panic::set_hook(Box::new(|_| {
        eprintln!("panic in worker");
        std::process::exit(99);
    }));

    let result = std::panic::catch_unwind(|| indigo_server::service::imago_ops::process(&bytes));

    match result {
        Ok(Ok(mol)) => {
            print!("{}", mol);
            std::process::exit(0);
        }
        Ok(Err(e)) => {
            eprintln!("{:#}", e);
            std::process::exit(3);
        }
        Err(_) => {
            eprintln!("worker panicked");
            std::process::exit(99);
        }
    }
}
