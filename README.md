# Chemistry Draw

<p align="center">
  <img src="src-tauri/icons/icon.png" width="64" alt="Chemistry Draw logo">
</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Desktop chemical structure editor built with [Tauri](https://v2.tauri.app/) (Rust backend + React/TypeScript frontend) wrapping [Ketcher](https://github.com/epam/ketcher) (© EPAM Systems, Apache License 2.0) for Linux.

> Not an official EPAM product. Community-maintained packaging without affiliation or official support.


## Features

- Full Ketcher editor with molecule, reaction and macromolecule drawing
- Native Indigo backend via Rust sidecar for faster cheminformatics (replaces WASM)
- Basic image-to-structure recognition powered by EPAM Imago v2
- **Native file save dialog** for all formats.
- Save as PNG / SVG with proper image rendering via the sidecar
- Offline-first — runs entirely on your machine

## Building from source

### Prerequisites

- [Task](https://taskfile.dev/) — task runner
- Rust ≥ 1.84
- [pnpm](https://pnpm.io/)
- Tauri v2 system dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):

  ```bash
  # Debian / Ubuntu
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```

- OpenCV 4.x (`libopencv-dev`) — required by the Imago recognition library

### Build & run

```bash
# Install frontend dependencies
pnpm install

# Run development server (builds sidecar automatically)
task dev

# Run sidecar tests only
task test

# Remove compiled artifacts (Rust target + dist)
task clean
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
