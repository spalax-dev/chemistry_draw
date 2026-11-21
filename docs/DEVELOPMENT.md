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

## Branch model (mandatory)

Chemistry Draw has two maintained lines; choose the target line before creating
any branch or worktree:

- **`main` — 0.x maintenance/support.** The line users run today: bug fixes,
  maintenance upgrades (including the Ketcher/Indigo/language E1) and releases.
  Do not add the ML/1.x work to `main`.
- **`develop` — 1.x integration.** Imago removal, ONNX/models/OCSR, NuGet and
  the 1.x path. It is not the 0.x support line.

Rules:

- Create the activity's branch/worktree from the **target line**: `main` for a
  0.x maintenance activity, `develop` for 1.x. **Never** base a main-targeted
  activity on `develop`.
- Merge the activity back to the same line. Do not cross-merge
  `main`/`develop` unless the user explicitly asks; port an individual fix with
  a cherry-pick and preserve each line's content.
- Record the base branch in `progress/current.md` and the activity before
  starting.
- Reference: the build-layout activity was based on `main`, merged to `main`,
  then ported to `develop`. E1 is main-only; it is not merged into `develop`.

## Frontend checks

```bash
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # ESLint
pnpm run format:check   # Prettier
pnpm test               # Vitest (pure frontend helpers)
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

## Native libraries (Indigo + ONNX Runtime)

The `indigo-server` sidecar links against prebuilt Indigo libraries and loads
ONNX Runtime dynamically; both are shipped with the app.

- They are **not committed** (they are binaries). Generate them with:

```bash
task libs
```

That builds the Docker builder image and copies the runtime libraries into
`src-tauri/lib/linux-x86_64/`, which is gitignored. The set is Indigo, Indigo
Renderer, their runtime dependencies and the pinned ONNX Runtime 1.31.0 chain.
`task libs` wipes that directory before copying, so it only ever holds what the
builder image produces — no accumulated host leftovers. The copy uses `cp -a`
like the packaging scripts, so `libonnxruntime.so -> libonnxruntime.so.1 ->
libonnxruntime.so.1.31.0` stays a chain of symlinks (one real 29 MB file).

It does **not** copy `libfontconfig*`, `libfreetype*`, `libexpat*`, `libpng*` or
`libbrotli*`: those stay host-provided, as do `libc`, `libm`, `libz`,
`libstdc++`, `libgcc_s` and GL/X11/xcb. If your
`src-tauri/lib/linux-x86_64/` was populated before this split, delete those
files (the directory is gitignored) so the sidecar loads the host copies.

The reason: Debian 12 ships fontconfig **2.14**, which cannot parse the newer
`/etc/fonts` syntax of current distros (Fedora 45 uses fontconfig **2.18**), so
a bundled copy floods every PNG render with `Fontconfig warning` lines even when
it works. The host libraries produce identical output without the warnings.

- Packaging builds (`.deb`/`.rpm`/AppImage) copy the same filtered set from
  `/opt/chemistry/libs/` inside the container and ship it in the package. The
  copy goes into the bind-mounted `src-tauri/lib/linux-x86_64/`, so each
  packaging script snapshots that directory first and restores it with an
  `EXIT` trap: a dev checkout is never left mutated by packaging, and only
  builder-image libraries are bundled. Tauri's resource copier dereferences
  symlinks, so the deb/rpm builds run `scripts/repack-native-payload.sh` after
  bundling to restore the ONNX Runtime chain (it repacks with gzip payloads so
  `data.tar.gz` / `rpm2cpio` keep working). The repack pins the same
  `ORT_VERSION=1.31.0` as the fetchers (bump them together; the packaging
  contract test fails on drift). RPM metadata other than the implicit
  capabilities is copied verbatim; rpmbuild regenerates provides/requires, which
  canonicalizes `chemistry-draw(x86_64)` to `(x86-64)` and re-emits `rpmlib(...)`
  with `<=` (see the script header for why). The AppImage AppDir is assembled
  directly with `cp -a`, so its chain is preserved.
- Packaging refuses forbidden native libs:
  `scripts/check-native-libs.sh [--allowlist <source-dir>] <dir...>` exits
  non-zero when it finds `*imago*` or `*opencv*` files. With `--allowlist`, it
  also rejects any file in the target directory that does not exist by basename
  in `<source-dir>` ("not provided by the builder image"), so host leftovers
  cannot leak into a package. It prints the offending paths and the fix. Every
  packaging script runs it right after copying `/opt/chemistry/libs/*.so*` into
  the bundled lib dir, with `--allowlist /opt/chemistry/libs`.
- When `scripts/build-libs.sh` changes (dependencies added or removed, or the
  ONNX Runtime pin bumped), rebuild the builder image with
  `task builder-image -- --no-cache` (same as
  `bash scripts/build-image.sh --no-cache`). The builder downloads and verifies
  the ONNX Runtime archive at image build time; a stale image lacks the chain
  and packaging fails fast in `check-native-libs.sh --allowlist` instead of
  silently shipping old libraries.
- `libstdc++` and `libgcc_s` are deliberately **not** shipped: the target
  distro's runtime is used.

## ONNX Runtime (inference runtime)

The sidecar loads ONNX Runtime **dynamically** (`ort` `load-dynamic`); it is
never linked at build time. Activity 7 (`ship-onnx-runtime`) also **ships** the
pinned 1.31.0 library:

The upstream GitHub **1.31.0 release assets are no longer reachable** (they
return 404), so the pinned source is now the official
`Microsoft.ML.OnnxRuntime` **1.31.0** NuGet package:

- Package: `microsoft.ml.onnxruntime.1.31.0.nupkg` from
  `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/`
- nupkg SHA-256: `7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b`
- Linux member: `runtimes/linux-x64/native/libonnxruntime.so`, SHA-256
  `469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e`,
  29,345,384 B — byte-identical to the previously shipped
  `libonnxruntime.so.1.31.0`.
- Windows member: `runtimes/win-x64/native/onnxruntime.dll`, SHA-256
  `0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c`,
  17,253,176 B.

A `.nupkg` is a zip archive. Do **not** substitute the PyPI wheel: its
`onnxruntime` shared library is a different build.

- Linux: `scripts/build-libs.sh` downloads and SHA-256-verifies the nupkg,
  extracts `runtimes/linux-x64/native/libonnxruntime.so` with Python's
  `zipfile` into the builder output as `libonnxruntime.so.1.31.0`, verifies the
  library SHA-256 and recreates the `.so.1`/`.so` symlinks. `task libs` copies
  the chain into `src-tauri/lib/linux-x86_64/`. Packaging ships it. Rebuild the
  image with `task builder-image -- --no-cache` when the pin changes.
- Windows: `pwsh scripts/fetch-windows-libs.ps1` downloads and verifies the
  same nupkg and extracts `runtimes/win-x64/native/onnxruntime.dll` into
  `src-tauri/lib/windows-x86_64/`.

Developer override: `scripts/fetch-onnxruntime.sh` fetches the same pinned
Linux build into the gitignored `.ort/linux-x86_64/` (idempotent, checksummed,
never models) and requires both `curl` and `python3` (the latter extracts the
nupkg member with `zipfile`); on Windows put `onnxruntime.dll` in
`.ort/windows-x86_64/`. The
debug Tauri host prefers `.ort/<platform>/` and falls back to the bundled
`lib/<platform>/`, while release uses the bundled copy only. The harness still
sets `ORT_DYLIB_PATH` from `.ort/` when present. Without a loadable runtime,
Indigo keeps working and `POST /v2/filter/classify` answers `503` with an
actionable message.

Development builds need no manual export: the debug Tauri host passes an
absolute `<repo>/models` as `CHEMISTRY_MODELS_DIR` when the variable is not
already set, and the sidecar otherwise prefers an existing `<repo>/models` over
`models` in its working directory. `CHEMISTRY_MODELS_DIR` is only needed for a
non-default model root or a manual sidecar run. Models stay gitignored and are
never bundled.

## Packaged clean-install validation (B3)

The clean-install contract is validated from the actual packages, not from a dev
run. Build them first (Debian 12+ container):

```bash
task packages
ls -l build/packages/
```

The `.deb`, `.rpm` and AppImage ship the sidecar, Indigo and the dynamically
loaded ONNX Runtime 1.31.0, and no model weights. Inspect the version under
test explicitly (older generations may stay in `build/packages/`):

```bash
V=0.1.7
DEB=build/packages/chemistry-draw_${V}_amd64.deb
RPM=build/packages/chemistry-draw-${V}-1.x86_64.rpm
APPIMAGE=build/packages/chemistry-draw_${V}_amd64.AppImage

ar p "$DEB" data.tar.gz | tar -tz | grep usr/bin/indigo-server
rpm -qlp "$RPM" | grep usr/bin/indigo-server
mkdir -p build/appimage && APPIMAGE=$(realpath "$APPIMAGE") && (cd build/appimage && rm -rf squashfs-root && "$APPIMAGE" --appimage-extract >/dev/null)
test -x build/appimage/squashfs-root/usr/bin/indigo-server

# Each absence command must print nothing.
ar p "$DEB" data.tar.gz | tar -tz | grep -Ei '\.onnx$|/models/'
rpm -qlp "$RPM" | grep -Ei '\.onnx$|/models/'
find build/appimage/squashfs-root \( -iname '*.onnx' -o -ipath '*/models/*' \)
```

Run the packaged sidecar against an empty model root. The `LD_LIBRARY_PATH`
points at the packaged lib directory and no `ORT_DYLIB_PATH` is set, so the
bundled runtime chain must load on its own:

```bash
CLEAN=$(mktemp -d)
export LD_LIBRARY_PATH=$PWD/build/appimage/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64
INDIGO_PORT=19321 INDIGO_NO_PARENT_WATCHDOG=1 \
  CHEMISTRY_MODELS_DIR=$CLEAN ./build/appimage/squashfs-root/usr/bin/indigo-server &

curl -s http://127.0.0.1:19321/v2/models | jq '.ready, .total_bytes' # false, 323987190
curl -s http://127.0.0.1:19321/v2/info | jq -c .imago_versions        # []
```

Then exercise the opt-in download/verify/filter/OCSR flow and the clean UI; the
full command sequence and expected values are in `docs/verification.md` §2
"Clean install (B3)". The real Hugging Face download is ~324 MB and is a manual
smoke, never CI. For the UI, launch the packaged app with a fresh app-data root:

```bash
CLEAN_DATA=$(mktemp -d)
XDG_DATA_HOME=$CLEAN_DATA ./build/appimage/squashfs-root/AppRun
```

The host creates `$CLEAN_DATA/dev.spalax.ChemistryDraw/models`; the **Models**
dialog auto-opens, Download fills that root, and Recognize enables without a
restart. On Windows the path is
`%APPDATA%\dev.spalax.ChemistryDraw\models`, and the CI job covers the empty
`/v2/models` and `/v2/info` `[]` smoke (it never downloads the models).

## Build outputs

Phase 1 consolidates build artifacts under `build/`:

| Path               | Contents                                                |
| ------------------ | ------------------------------------------------------- |
| `build/packages`   | `.deb`, `.rpm` and AppImage produced by `task packages` |
| `build/appimage`   | AppImage extraction scratch space                       |
| `build/verify`     | `.deb`/`.rpm` extraction used for payload checks        |
| `build/libs`       | Native Indigo build workspace used by `task libs`       |
| `build/benchmarks` | Model-parity raw output (`scripts/model-parity.mjs`)    |

`target/` (Cargo) and `dist/` (Vite/frontend) stay tool-owned and keep their
current locations; consolidating them under `build/` is Phase 2 (E4). `models/`
and `.ort/` are runtime/dev data, not build outputs.

To inspect an AppImage, extract it under `build/appimage` instead of the
repository root:

```bash
mkdir -p build/appimage
(cd build/appimage && /path/to/chemistry-draw_*.AppImage --appimage-extract)
# or: unsquashfs -d build/appimage/squashfs-root /path/to/chemistry-draw_*.AppImage
```

## Windows 10/11 (x86_64)

Windows uses the prebuilt EPAM Indigo 1.46.0 DLLs instead of the Docker
builder. It runs the same sidecar as Linux; B2 re-enables Recognize Molecule
through the local filter + OCSR pipeline and its Ketcher-compatible job shim.

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

`scripts/fetch-windows-libs.ps1` downloads the pinned Indigo archive and the
pinned ONNX Runtime 1.31.0 NuGet package, verifies the archive and DLL SHA-256
values, extracts the six
runtime DLLs (five Indigo/MSVC plus `onnxruntime.dll`) into
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
# dynamically and must not appear as a NEEDED entry)
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
