# Chemistry Draw

<p align="center">
  <img src="src-tauri/icons/icon.png" width="64" alt="Chemistry Draw logo">
</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Desktop chemical structure editor built with [Tauri](https://v2.tauri.app/) (Rust backend + React/TypeScript frontend) wrapping [Ketcher](https://github.com/epam/ketcher) (© EPAM Systems, Apache License 2.0) for Linux and Windows.

> Not an official EPAM product. Community-maintained packaging without affiliation or official support.

## Features

- Full Ketcher editor with molecule, reaction and macromolecule drawing
- Native Indigo backend via Rust sidecar for faster cheminformatics (replaces WASM)
- Basic image-to-structure recognition powered by EPAM Imago v2 (**Linux only**;
  Windows builds ship without Imago and show Recognize Molecule disabled)
- **Native file save dialog** for all formats.
- Save as PNG / SVG with proper image rendering via the sidecar
- Offline-first — runs entirely on your machine

## Releases

GitHub Releases publish four artifacts built from the same commit:

| Platform             | Artifact                                      |
| -------------------- | --------------------------------------------- |
| Debian / Ubuntu      | `.deb`                                        |
| Fedora / RHEL        | `.rpm`                                        |
| Any Linux            | AppImage                                      |
| Windows 10/11 x86_64 | NSIS `chemistry-draw_<version>_x64-setup.exe` |

Windows builds ship without Imago/OpenCV, so image recognition is unavailable
there. The Windows installer is built and smoke-tested by
`.github/actions/windows-build`, the same action CI uses, and attached to the
release by the Windows job in `.github/workflows/release.yml`.

## Development workflow

Work follows a fixed order: **docs → test → implement → review**.

1. **Docs** — update `README.md` and `docs/` with the behaviour before writing
   code.
2. **Test** — add the failing test and confirm RED.
3. **Implement** — minimal code to make it pass; confirm GREEN, then refactor.
4. **Review** — verify against `docs/verification.md` and
   `docs/CHECKPOINTS.md`.

`node scripts/harness.mjs` enforces the phase order declared in
`activities.json` and runs the policy tests. See
[docs/testing.md](docs/testing.md) for the test-first rules and
[docs/conventions.md](docs/conventions.md) for the task schema.

## Building from source

### Prerequisites

- [Task](https://taskfile.dev/) — task runner
- Rust ≥ 1.84
- [pnpm](https://pnpm.io/)
- Tauri v2 system dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- `patchelf` — required for bundling (Arch: `sudo pacman -S patchelf`, Debian/Ubuntu: `sudo apt install patchelf`)

#### Native library building (Indigo + Imago + OpenCV)

The app bundles native libraries compiled against **glibc ≥ 2.36**. They are not committed; `task libs` builds them into `src-tauri/lib/linux-x86_64/` (gitignored), and you can rebuild them from source:

```bash
task libs   # requires Docker (Debian 12 builder image)
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

- **Linux** (x86_64) with **glibc ≥ 2.36** (Debian 12+, Ubuntu 24.04+, Arch)
- **FUSE** required to run AppImage directly, or use `APPIMAGE_EXTRACT_AND_RUN=1`

### Windows 10/11 (x86_64)

Windows builds use the pinned EPAM Indigo **1.46.0** DLLs. Imago and OpenCV are
not included: image recognition is unavailable and Ketcher disables the
**Recognize Molecule** action.

#### Prerequisites

- Windows 10/11 x86_64
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the **Desktop development with C++** workload (MSVC x64 + Windows SDK)
- Rust stable with the MSVC toolchain (the default on Windows:
  `x86_64-pc-windows-msvc`)
- Node.js ≥ 22 and [pnpm](https://pnpm.io/)
- PowerShell 5.1+ (`pwsh` or `powershell`) to run the library fetch script
- WebView2 Runtime (preinstalled on Windows 11; the installer embeds the
  bootstrapper for Windows 10)

#### Build & run

Run these commands from a **VS x64 Native Tools Command Prompt** (or any shell
after `ilammy/msvc-dev-cmd`), because `dumpbin`/`lib` must be on `PATH`:

```powershell
# One-time: download Indigo 1.46.0, verify SHA-256, extract the DLLs and
# generate indigo.lib / indigo-renderer.lib (all gitignored).
pwsh scripts/fetch-windows-libs.ps1

# Add the DLLs to PATH for local runs.
$env:PATH = "$PWD\src-tauri\lib\windows-x86_64;$env:PATH"

pnpm install
cargo build --release -p indigo-server --bin indigo-server
Copy-Item target\release\indigo-server.exe `
  target\release\indigo-server-x86_64-pc-windows-msvc.exe

# Tests and lints
node scripts/harness.mjs

# Run the app or produce the NSIS installer
pnpm tauri dev
pnpm tauri build --bundles nsis
```

The installer lands in
`target/release/bundle/nsis/chemistry-draw_<version>_x64-setup.exe`. It bundles
`indigo-server.exe` plus `indigo.dll`, `indigo-renderer.dll` and the MSVC
runtime DLLs under `lib/windows-x86_64/`; no Imago or OpenCV is packaged.

CI builds and smoke-tests this installer on `windows-latest`
(`.github/workflows/ci.yml`) through the shared
`.github/actions/windows-build` action; the Windows sidecar must answer
`/v2/info` with an empty `imago_versions` array and return 404 for
`/v2/imago/uploads`. `release.yml` runs the same action on a release and attaches
the installer to the GitHub release next to the Linux packages.

### Build & run (Linux)

```bash
# Install frontend dependencies
pnpm install

# Run development server (builds sidecar automatically)
task dev

# Run sidecar tests only
task test

# Build production .deb package
task packages

# Build AppImage
task appimage

# Remove compiled artifacts (Rust target + dist)
task clean
```

_Both `.deb` and AppImage packages bundle all shared library dependencies (OpenCV, image codecs, etc.)
so they work on Debian 12 and Ubuntu 24.04+ without extra system packages._

## License

Apache 2.0 — see [LICENSE](LICENSE).
