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

## Toolchain and prerequisites

The supported versions, pins and audit gates are in
**[docs/TOOLCHAIN.md](TOOLCHAIN.md)**. For the 0.x `main` line:

| Tool | Version                                        |
| ---- | ---------------------------------------------- |
| Node | `24.20.0` from `.nvmrc` (`>=24.20.0 <25`)      |
| pnpm | 12.21.0, pinned by `packageManager` + Corepack |
| Rust | stable (local baseline rustc 1.99.1)           |

pnpm is the **only** package manager: use it for installs, scripts and audits.
`npm install`, `npm ci`, `npx` and `yarn` are not supported.

Ketcher 3.21 declares `engines.node >= 24.20.0`, so 24.20.0 is the real floor
and the repo's `.nvmrc` pins it. Any Node below 24.20.0 is below it — upgrade
before working on this branch. `engines` and `packageManager` are declared in
`package.json`, so `nvm install 24.20.0 && nvm use` installs the pinned
release (the same command works as `nvm install && nvm use`, which reads
`.nvmrc`):

```bash
nvm install 24.20.0 && nvm use  # .nvmrc pins Node 24.20.0 (Ketcher 3.21 floor)
corepack enable                 # installs the pnpm version from packageManager
pnpm install --frozen-lockfile
```

### Ketcher 3.21 multi-language `ketcher-react`

`ketcher-react` is not the published npm bundle (English-only): the app uses the
committed `vendor/ketcher-react/ketcher-react-3.21.0-multi.tgz`, built from tag
`v3.21.0` with `KETCHER_MULTI_LANGUAGE_BUILD=true`. A fresh checkout, CI and
Windows only need `pnpm install`; regenerate the tarball only when the Ketcher
build must change, in the pinned toolchain:

```bash
scripts/build-ketcher-react.sh
```

The script is pnpm-only (no `npm`, `npx` or `yarn`) and requires Node 24.20+. It
regenerates the tarball in a throwaway `build/ketcher-src` checkout:

1. clone tag `v3.21.0` into `build/ketcher-src`;
2. write `pnpm-workspace.yaml` with `packages: ["packages/*"]`;
3. `pnpm install --ignore-scripts --no-frozen-lockfile` (root npm lock ignored,
   husky skipped);
4. `export KETCHER_MULTI_LANGUAGE_BUILD=true`;
5. `pnpm --filter ketcher-react run i18n:generate` (bypasses the npm-based
   `prebuild`);
6. `pnpm --filter ketcher-react exec cross-env NODE_ENV=production rollup -c rollup.config.mjs -m true`;
7. guard `zh-CN` in `dist/index.js`, then
   `pnpm --filter ketcher-react pack --pack-destination vendor/ketcher-react`
   and rename to `ketcher-react-3.21.0-multi.tgz`.

The throwaway checkout never enters the app's dependency graph. `ketcher-core`
stays the published 3.21.0 package with one narrowed `parametrizeUrl` patch;
`docs/KETCHER-BUG-parametrizeUrl.md` carries the bug and the removal condition
(3.22 stable with the upstream fix).

Before opening a change, run the audit gates and the full harness:

```bash
pnpm run audit                       # full graph; fails on high/critical
pnpm run audit:prod                  # production graph; fails on high/critical
cargo install cargo-audit --locked   # one-time
cargo audit                          # Rust gate: fails only on vulnerabilities; warnings are tracked
node scripts/harness.mjs
```

`cargo audit` reports unmaintained/unsound warnings that have no fix without
failing (`--deny warnings` is not the gate); the Rust baseline is in
[docs/TOOLCHAIN.md](TOOLCHAIN.md) §3.1.2.

`node scripts/harness.mjs --fast` is for local iteration (skips the frontend
build, uses `cargo check`, skips sidecar tests); the full run is required before
review. The allowlist policy and the dated exceptions are in
[docs/TOOLCHAIN.md](TOOLCHAIN.md) §3.

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

## Local development (`task run`)

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
  opencv \
  opencv-devel \
  opencv-imgcodecs \
  lapack \
  openblas \
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
  libopencv-dev \
  liblapack3 \
  libopenblas0 \
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
  opencv \
  lapack \
  openblas \
  patchelf \
  fuse3
```

## Native libraries (Indigo / Imago)

The `indigo-server` sidecar links against prebuilt Indigo/Imago/OpenCV libraries.
Indigo is pinned to the stable Linux tag **`indigo-1.49.0`** (git refs are
lowercase; the GitHub release is `Indigo-1.49.0`).

- They are **not committed** (they are binaries). Generate them with:

```bash
task libs
```

That builds the Docker builder image and copies the runtime libraries into
`src-tauri/lib/linux-x86_64/`, which is gitignored. The builder clones
`--depth 1 --branch indigo-1.49.0` (never `master`), so `/v2/info` reports
`1.49.0`; after changing the pin, rebuild the image with
`task builder-image -- --no-cache` before `task libs`. It includes the minimal
OpenCV that Imago needs (`libopencv_*.so.406`) plus `libjpeg`. It does **not**
copy `libfontconfig*`, `libfreetype*`, `libexpat*`, `libpng*` or `libbrotli*`:
those stay host-provided, as do `libc`, `libm`, `libz`, `libstdc++`,
`libgcc_s` and GL/X11/xcb. If your `src-tauri/lib/linux-x86_64/` was populated
before this split, delete those files (the directory is gitignored) so the
sidecar loads the host copies.

The reason: Debian 12 ships fontconfig **2.14**, which cannot parse the newer
`/etc/fonts` syntax of current distros (Fedora 45 uses fontconfig **2.18**), so
a bundled copy floods every PNG render with `Fontconfig warning` lines even when
it works. The host libraries produce identical output without the warnings.

- Packaging builds (`.deb`/`.rpm`/AppImage) copy the same filtered set from
  `/opt/chemistry/libs/` inside the container and ship it in the package.
- `libstdc++` and `libgcc_s` are deliberately **not** shipped: the target
  distro's runtime is used.

## Build outputs

Phase 1 consolidates build artifacts under `build/`:

| Path             | Contents                                                |
| ---------------- | ------------------------------------------------------- |
| `build/packages` | `.deb`, `.rpm` and AppImage produced by `task packages` |
| `build/appimage` | AppImage extraction scratch space                       |
| `build/verify`   | `.deb`/`.rpm` extraction used for payload checks        |
| `build/libs`     | Native Indigo/Imago build workspace used by `task libs` |

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

Windows uses the prebuilt EPAM Indigo 1.49.0 DLLs instead of the Docker
builder. Imago and OpenCV are **not** built or shipped: image recognition is
unavailable and Ketcher disables **Recognize Molecule** (`imago_versions` is an
empty array).

Prerequisites:

- Visual Studio Build Tools with **Desktop development with C++** (MSVC x64 +
  Windows SDK)
- Rust stable MSVC toolchain, Node.js 24 LTS (`>=24.20.0 <25`), pnpm 12 via
  Corepack (`corepack enable`), and PowerShell 5.1+
- WebView2 Runtime (included in Windows 11; the installer embeds the
  bootstrapper for Windows 10)

```powershell
# From a VS x64 developer shell (dumpbin/lib must be on PATH):
pwsh scripts/fetch-windows-libs.ps1

$env:PATH = "$PWD\src-tauri\lib\windows-x86_64;$env:PATH"
corepack enable
pnpm install --frozen-lockfile
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

The packages are built in a Debian 12 container, and the native Indigo/Imago
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

Lowering the floor would mean building Indigo/Imago _and_ the Tauri app on
Debian 11, which is not possible today because Tauri v2 needs
`webkit2gtk-4.1` (Debian 12+).

## Quick checks

```bash
# Check pkg-config deps
pkg-config --exists glib-2.0 gtk+-3.0 webkit2gtk-4.1 && echo "GTK/WebKit OK"

# Check missing runtime deps for the sidecar
ldd target/debug/indigo-server 2>/dev/null | grep "not found"
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
use it). It reports uptime, PID, port, versions and whether the `imago-worker`
binary was found next to the sidecar:

```bash
curl -s http://127.0.0.1:9321/v2/health | jq
```

`GET /v2/info` now builds `api_path` from the port actually bound, so it stays
correct when the sidecar falls back to a different port because 9321 is busy.

## Notes

- **Packaged `.rpm/.deb/.AppImage`**: Runtime deps are declared in the bundle. You don't need `*-devel` packages to run them.
- **Docker builds**: Ignore all of this. Use `task builder-image`, `task packages`, `task rpm`, etc. All deps are inside the `chemistry-builder` image.
