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
    
    let result = std::panic::catch_unwind(|| {
        indigo_server::service::imago_ops::process(&bytes)
    });
    
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
