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
- Tauri v2 system dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- `patchelf` — required for bundling (Arch: `sudo pacman -S patchelf`, Debian/Ubuntu: `sudo apt install patchelf`)

#### Native library building (Indigo + Imago + OpenCV)

The app bundles native libraries compiled against **glibc ≥ 2.35**. These are pre-built and committed to the repo, but you can rebuild them from source:

```bash
task build-libs   # requires Docker (Ubuntu 22.04 image)
```

On Arch Linux, install build dependencies:
```bash
sudo pacman -S base-devel cmake git \
  patchelf libcairo libpng fontconfig \
  opencv boost
```

On Debian/Ubuntu:
```bash
sudo apt install build-essential cmake git \
  patchelf libcairo2-dev libpng-dev libfontconfig1-dev \
  libopencv-dev \
  libboost-dev libboost-filesystem-dev \
  libboost-thread-dev libboost-program-options-dev
```

#### Runtime requirements

- **Linux** (x86_64) with **glibc ≥ 2.35** (Ubuntu 22.04+, Debian 12+, Arch)
- **FUSE** required to run AppImage directly, or use `APPIMAGE_EXTRACT_AND_RUN=1`

### Build & run

```bash
# Install frontend dependencies
pnpm install

# Run development server (builds sidecar automatically)
task dev

# Run sidecar tests only
task test

# Build production .deb package
task package

# Build AppImage
task appimage

# Remove compiled artifacts (Rust target + dist)
task clean
```

*Both `.deb` and AppImage packages bundle all shared library dependencies (OpenCV, image codecs, etc.)
so they work on Debian 12 and Ubuntu 22.04+ without extra system packages.*


## License

Apache 2.0 — see [LICENSE](LICENSE).
