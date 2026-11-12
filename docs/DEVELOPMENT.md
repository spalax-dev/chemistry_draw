# Development dependencies

This project uses [Tauri](https://v2.tauri.app/), a Rust + Web frontend. For local development you need system libraries for GTK/WebKit/GLib. For packaging we use the Docker builder (`task packages`), so you don't need these if you only build RPM/DEB/AppImage via Docker.

## Workflow

Every change follows **docs → test → implement → review**:

1. Update the docs (`README.md`, `docs/`) describing the behaviour.
2. Add the failing test and confirm RED (`docs/testing.md`).
3. Write the minimal implementation; confirm GREEN, then refactor.
4. Review against `docs/verification.md` and `docs/CHECKPOINTS.md`.

`node scripts/harness.mjs` is the gate: its block 3 runs
`node --test scripts/lib/activity-policy.test.mjs` and validates the task
`phase` order in `activities.json` with `scripts/lib/activity-policy.mjs`.
Docs-only activities (`type: "docs"`) run docs → review and skip test/implement.

## Frontend checks

```bash
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # ESLint
pnpm run format:check   # Prettier
pnpm build              # tsc + vite build
```

## Local development (`task dev` / `task run`)

These are **development packages** (`-devel`/`-dev`) because `pkg-config` and headers are required to compile crates like `glib-sys`, `gtk-sys`, `webkit2gtk-sys`.

### Fedora / RHEL / Nobara

```bash
sudo dnf install -y \
  glib2-devel \
  gtk3-devel \
  webkit2gtk4.1-devel \
  pkgconf-pkg-config \
  openssl-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  patchelf \
  fuse3 \
  fuse3-devel
```

### Debian / Ubuntu

```bash
sudo apt install -y \
  libglib2.0-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  pkg-config \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  fuse3 \
  libfuse2
```

### Arch Linux

```bash
sudo pacman -S --needed \
  glib2 \
  gtk3 \
  webkit2gtk-4.1 \
  pkgconf \
  openssl \
  libayatana-appindicator \
  librsvg \
  patchelf \
  fuse3
```

## Native libraries (Indigo)

The `indigo-server` sidecar links against prebuilt Indigo libraries.

- They are **not committed** (they are binaries). Generate them with:

```bash
task libs
```

That builds the Docker builder image and copies the runtime libraries into
`src-tauri/lib/linux-x86_64/`, which is gitignored. `task libs` wipes that
directory before copying, so it only ever holds what the builder image
produces — no accumulated host leftovers.

- Packaging builds (`.deb`/`.rpm`/AppImage) copy the same set from
  `/opt/chemistry/libs/` inside the container and ship it in the package. That
  set is Indigo-only (`libindigo.so`, `libindigo-renderer.so` and their runtime
  dependencies). The copy goes into the bind-mounted
  `src-tauri/lib/linux-x86_64/`, so each packaging script snapshots that
  directory first and restores it with an `EXIT` trap: a dev checkout is never
  left mutated by packaging, and only builder-image libraries are bundled.
- Packaging refuses forbidden native libs:
  `scripts/check-native-libs.sh [--allowlist <source-dir>] <dir...>` exits
  non-zero when it finds `*imago*` or `*opencv*` files. With `--allowlist`, it
  also rejects any file in the target directory that does not exist by basename
  in `<source-dir>` ("not provided by the builder image"), so host leftovers
  cannot leak into a package. It prints the offending paths and the fix. Every
  packaging script runs it right after copying `/opt/chemistry/libs/*.so*` into
  the bundled lib dir, with `--allowlist /opt/chemistry/libs`.
- When `scripts/build-libs.sh` changes (dependencies added or removed), rebuild
  the builder image with `task builder-image -- --no-cache` (same as
  `bash scripts/build-image.sh --no-cache`). Packaging with a stale image now
  fails fast instead of silently bundling old libraries.
- `libstdc++` and `libgcc_s` are deliberately **not** shipped: the target
  distro's runtime is used.

## ONNX Runtime (local inference)

The sidecar loads ONNX Runtime **dynamically**; B1 does not link or bundle it.
Fetch the pinned 1.31.0 Linux x86_64 shared build (checksummed, idempotent, no
models) before running model-gated tests or trying the classifier locally:

```bash
scripts/fetch-onnxruntime.sh
```

It extracts `lib/libonnxruntime.so*` into the gitignored
`.ort/linux-x86_64/`. `node scripts/harness.mjs` sets `ORT_DYLIB_PATH` when the
file exists, and the debug Tauri host does the same for the sidecar. Without the
runtime, Indigo keeps working and `POST /v2/filter/classify` answers `503` with
an actionable message.

Development builds need no manual export: the debug Tauri host passes an
absolute `<repo>/models` as `CHEMISTRY_MODELS_DIR` when the variable is not
already set, and the sidecar otherwise prefers an existing `<repo>/models` over
`models` in its working directory. `CHEMISTRY_MODELS_DIR` is only needed for a
non-default model root or a manual sidecar run. Models stay gitignored and are
never bundled.

Windows: place the pinned `onnxruntime.dll` under `.ort/windows-x86_64/` and set
`ORT_DYLIB_PATH` to it. Shipping the runtime with the installers is a follow-up
activity (see `docs/ROADMAP.md`).

## Windows 10/11 (x86_64)

Windows uses the prebuilt EPAM Indigo 1.46.0 DLLs instead of the Docker
builder. It runs the same sidecar as Linux; Recognize Molecule is hidden on
every platform until B2 wires OCSR.

Prerequisites:

- Visual Studio Build Tools with **Desktop development with C++** (MSVC x64 +
  Windows SDK)
- Rust stable MSVC toolchain, Node.js ≥ 22, pnpm and PowerShell 5.1+
- WebView2 Runtime (included in Windows 11; the installer embeds the
  bootstrapper for Windows 10)

```powershell
# From a VS x64 developer shell (dumpbin/lib must be on PATH):
pwsh scripts/fetch-windows-libs.ps1

$env:PATH = "$PWD\src-tauri\lib\windows-x86_64;$env:PATH"
pnpm install
cargo build --release -p indigo-server --bin indigo-server
Copy-Item target\release\indigo-server.exe `
  target\release\indigo-server-x86_64-pc-windows-msvc.exe
node scripts/harness.mjs
pnpm tauri build --bundles nsis
```

`scripts/fetch-windows-libs.ps1` downloads the pinned archive, verifies its
SHA-256, extracts only the runtime DLLs into
`src-tauri/lib/windows-x86_64/` (gitignored) and generates
`indigo.lib` / `indigo-renderer.lib` from the exported `indigo*` C symbols.
CI runs it under `ilammy/msvc-dev-cmd@v1`; packaging the installers is part of
the Windows CI job.

## Supported distros

The packages are built in a Debian 12 container, and the native Indigo
libraries use symbols from its C library (`arc4random@GLIBC_2.36`), so the real
floor is **glibc 2.36**:

| Distro               | glibc | Status                                     |
| -------------------- | ----- | ------------------------------------------ |
| Debian 12 (bookworm) | 2.36  | supported                                  |
| Debian 13 (trixie)   | 2.41  | supported                                  |
| Ubuntu 24.04         | 2.39  | supported                                  |
| Ubuntu 22.04         | 2.35  | **not supported** (`GLIBC_2.36 not found`) |
| Debian 11            | 2.31  | not supported                              |

GTK3 and the `webkit2gtk-4.1` runtime are required too, which Debian 11 does not
provide. CI runs on `ubuntu-24.04` for the same reason: linking a test binary
against the libraries fails on an older glibc.

Lowering the floor would mean building Indigo _and_ the Tauri app on
Debian 11, which is not possible today because Tauri v2 needs
`webkit2gtk-4.1` (Debian 12+).

## Quick checks

```bash
# Check pkg-config deps
pkg-config --exists glib-2.0 gtk+-3.0 webkit2gtk-4.1 && echo "GTK/WebKit OK"

# Check missing runtime deps for the sidecar (libonnxruntime is loaded
# dynamically and must not appear here)
ldd target/debug/indigo-server 2>/dev/null | grep "not found"
ldd target/debug/indigo-server 2>/dev/null | grep -c "libonnxruntime" # must print 0
```

## Logs and diagnostics

Both the Rust host and the frontend write to a rotating log file, so a bug
report can be diagnosed without rebuilding or attaching a debugger.

- **Location** (Linux): `~/.local/share/dev.spalax.ChemistryDraw/logs/chemistry-draw.log`
  (Tauri's per-app log directory; on other platforms it follows the OS
  convention).
- **Rotation**: 2 MB per file, the last 5 files are kept.
- **What is captured**:
  - Host lifecycle: app version, log directory, sidecar spawn/exit, panics.
  - The sidecar's stdout/stderr, forwarded line by line (ANSI colors stripped)
    with the `indigo-server` target.
  - Every frontend `console.*` call, plus uncaught errors and unhandled
    promise rejections, tagged `[frontend]`.

The frontend integration lives in `src/logging.ts` and is installed from
`src/main.tsx` before the first render; nothing else has to be done in the UI.

To locate the directory at runtime:

```js
// DevTools console of the app
await window.__TAURI_INTERNALS__.invoke("log_dir");
```

### Health endpoint

The sidecar exposes `GET /v2/health` for support/diagnostics (Ketcher does not
use it). It reports uptime, PID, port, the Indigo version, the targeted ONNX
Runtime API generation and the model ids whose artifacts are on disk:

```bash
curl -s http://127.0.0.1:9321/v2/health | jq
```

`GET /v2/info` now builds `api_path` from the port actually bound, so it stays
correct when the sidecar falls back to a different port because 9321 is busy.

## Notes

- **Packaged `.rpm/.deb/.AppImage`**: Runtime deps are declared in the bundle. You don't need `*-devel` packages to run them.
- **Docker builds**: Ignore all of this. Use `task builder-image`, `task packages`, `task rpm`, etc. All deps are inside the `chemistry-builder` image.
