# Architecture

> What "good work" means in this project.

## Delivery order

Changes land as **docs → test → implement → review**: documentation defines the
contract, a failing test proves the gap, the minimal implementation closes it,
and the reviewer verifies the result. `node scripts/harness.mjs` enforces the
task phases declared in `activities.json` (docs-only activities run
docs → review).

---

## 1. Project Overview

Chemistry Draw is an **offline-first desktop chemical structure editor**: a
[Tauri v2](https://v2.tauri.app/) shell around the [Ketcher](https://github.com/epam/ketcher)
React editor (Apache 2.0, EPAM Systems).

Instead of Ketcher's WASM backend, the app ships a **native REST sidecar** that
implements the Indigo v2 HTTP API on top of EPAM's C++ libraries. This is a
community packaging: it is not an official EPAM product.

| Piece             | Technology                                                      |
| ----------------- | --------------------------------------------------------------- |
| Desktop shell     | Tauri v2 (Rust)                                                 |
| Frontend          | React 18 + TypeScript + Vite                                    |
| Editor            | `ketcher-react` / `ketcher-core` 3.18.x (patched, see §9)       |
| Chemistry backend | `indigo-server` sidecar: Rust + axum                            |
| Native chemistry  | `libindigo`, `libindigo-renderer`, `libimago` (FFI)             |
| OCR worker        | `imago-worker` child process (Linux only)                       |
| Packaging         | Linux: Docker builder → `.deb`, `.rpm`, AppImage; Windows: NSIS |

---

## 2. Process and data flow

```text
┌──────────────────────────── WebView ────────────────────────────┐
│  React + Ketcher                                                │
│  App.tsx → resolveApiBase() → RemoteStructServiceProvider       │
│  logging.ts → console/errors forwarded to the host log          │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTP 127.0.0.1:<port>/v2/*
┌─────────────────────────────▼───────────────────────────────────┐
│  indigo-server (axum, spawned and supervised by the Tauri host)  │
│  transport/ → service/ → ffi/                                    │
│  job/ (in-memory Imago jobs)                                     │
└───────────────┬──────────────────────────────┬──────────────────┘
                │ FFI                          │ spawn per upload
┌───────────────▼──────────────┐   ┌───────────▼──────────────────┐
│ libindigo / libindigo-renderer│   │ imago-worker (one-shot)      │
│ libimago                      │   │ stdin: image path → stdout:  │
│                               │   │ molfile                      │
└───────────────────────────────┘   └──────────────────────────────┘
```

Imago and `imago-worker` exist in Linux builds only. On Windows the sidecar
links just `indigo.dll` / `indigo-renderer.dll`, `ffi::imago` is a stub, the
Imago routes are not registered and `imago_versions` is empty, so Ketcher
disables image recognition.

The Tauri host (`src-tauri/src/lib.rs`) does **no chemistry**: it picks a free
port, spawns `indigo-server`, tracks the port it reports, forwards its logs and
kills it on exit (plus a stdin-EOF watchdog inside the sidecar for crashes).

---

## 3. Layering (one-way dependency)

Dependencies point one way only:

```text
frontend (src/)  →  HTTP  →  transport/  →  service/  →  ffi/
                                   ↘  job/
```

| Layer                | Responsibility                                        | May not                 |
| -------------------- | ----------------------------------------------------- | ----------------------- |
| `src/`               | UI, Ketcher integration, API base resolution, logging | call native libs        |
| `src-tauri/src/`     | App lifecycle: port, sidecar spawn/kill, commands     | contain cheminformatics |
| `sidecar/transport/` | HTTP parsing, status codes, JSON                      | call `ffi::` directly   |
| `sidecar/service/`   | Orchestration and domain errors                       | know about HTTP         |
| `sidecar/ffi/`       | `extern "C"` bindings, session handling               | know about HTTP or jobs |
| `sidecar/job/`       | In-memory job store                                   | perform recognition     |

Pattern rules:

- A handler returns `Result<Json<_>, AppError>`; it never builds error bodies
  by hand (`error.rs` maps variants to status codes).
- Business logic lives in `service/`, not in handlers.
- All native calls go through `ffi/`; no `unsafe` FFI elsewhere.
- The host never links the chemistry libraries.

---

## 4. Frontend integration

- `src/App.tsx` resolves the API base by polling `GET /v2/info` until the
  sidecar answers (it starts asynchronously), using the port reported by the
  `indigo_port` command.
- Ketcher is mounted through `RemoteStructServiceProvider` pointing at
  `http://127.0.0.1:<port>/v2/`.
- `src/logging.ts` transparently mirrors `console.*`, uncaught errors and
  unhandled rejections into the Tauri log. It is a no-op outside Tauri.
- Hash/`file-saver` shims exist for the webview; do not add Node-only APIs.

---

## 5. Sidecar API surface

| Method | Path                                                                | Backend                           |
| ------ | ------------------------------------------------------------------- | --------------------------------- |
| GET    | `/v2/info`                                                          | versions + `api_path` (real port) |
| GET    | `/v2/health`                                                        | diagnostics for bug reports       |
| GET    | `/v2/indigo/info`                                                   | alias of `/v2/info`               |
| POST   | `/v2/indigo/convert`, `aromatize`, `dearomatize`, `layout`, `clean` | Indigo                            |
| POST   | `/v2/indigo/render`                                                 | Indigo Renderer                   |
| POST   | `/v2/indigo/calculate`, `check`, `calculate_cip`, `automap`         | Indigo                            |
| POST   | `/v2/imago/uploads`                                                 | Imago (creates a job, Linux only) |
| GET    | `/v2/imago/uploads/{id}`                                            | job status (Linux only)           |

Errors are `AppError` → `{ "error": "..." }` with 400/404/500. Ketcher's
upload-and-poll contract is described in `sidecar/src/job/mod.rs`.

---

## 6. Native libraries

Indigo, Indigo Renderer and Imago are **not vendored in git**.

- **Linux**: built in the Docker builder and copied by `task libs` into
  `src-tauri/lib/linux-x86_64/` (gitignored). The same directory is what
  packaging ships. The build uses a **minimal OpenCV** (core, imgproc,
  imgcodecs; PNG/JPEG only) compiled into the builder. `libstdc++` and
  `libgcc_s` are **never** shipped: the target distro runtime is used. The real
  support floor is **glibc 2.36** (`arc4random@GLIBC_2.36` in `libindigo.so`):
  Debian 12+, Ubuntu 24.04+, current Fedora.
- **Windows**: `scripts/fetch-windows-libs.ps1` downloads the pinned EPAM
  Indigo **1.46.0** x86_64 archive, verifies its SHA-256, extracts
  `indigo.dll`, `indigo-renderer.dll`, `msvcp140.dll`, `vcruntime140.dll` and
  `vcruntime140_1.dll` into `src-tauri/lib/windows-x86_64/` (gitignored) and
  generates the MSVC import libraries `indigo.lib` / `indigo-renderer.lib`
  from the `indigo*` C exports. Imago and OpenCV are intentionally absent.

---

## 7. Packaging

Platform settings live in `src-tauri/tauri.linux.conf.json` and
`src-tauri/tauri.windows.conf.json`; `tauri.conf.json` only holds what is
common (Tauri merges the platform file at build time).

Linux: `task packages` runs everything inside `chemistry-builder` and writes to
`dist-packages/`:

- `.deb` / `.rpm`: Tauri bundler (`tauri build --bundles deb,rpm`).
- AppImage: **custom AppDir** assembled by `scripts/make-appimage.sh` and packed
  with `appimagetool`. Tauri's linuxdeploy bundler is deliberately not used
  because it copies the whole ELF closure (GTK/WebKit/Wayland), which breaks EGL
  on other distros.

Windows: `pnpm tauri build --bundles nsis` produces an NSIS installer under
`target/release/bundle/nsis/`. It bundles `indigo-server.exe` plus the five
Indigo/MSVC DLLs under `lib/windows-x86_64/`; `imago-worker` is not in
`externalBin` and Imago is not packaged.

The Windows build lives in `.github/actions/windows-build`: toolchain, DLL fetch,
sidecar build, harness, smoke test and NSIS bundle. Both `ci.yml` (artifact) and
`release.yml` (release asset) call it, so the published installer is the same
one CI validated. A release publishes `.deb`, `.rpm`, AppImage and the Windows
`.exe`.

`scripts/build-packages.sh` serializes runs with `flock` because concurrent
builds share the target volume and bundle directory.

Version bumps are driven by release-please and must stay in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
`src-tauri/sidecar/Cargo.toml`.

---

## 8. Observability

- Rust host + frontend + sidecar output go to a rotating file via
  `tauri-plugin-log` (stdout + app log dir, 2 MB × 5 files).
- The sidecar's stdout/stderr is forwarded line by line with ANSI stripped.
- `GET /v2/health` exposes uptime, PID, port, versions and whether
  `imago-worker` was found. It is for support, not for Ketcher.
- Panics are logged with location.

---

## 9. Temporary workaround

`ketcher-core` 3.18.0 has a bug in `parametrizeUrl` that turns the port in
`127.0.0.1:9321` into a placeholder. We ship `patches/ketcher-core@3.18.0.patch`
(registered in `pnpm-workspace.yaml`). Upstream fixed it in
[epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552) but has not
published a release with the fix yet. Removal procedure:
`docs/KETCHER-BUG-parametrizeUrl.md`.

---

## 10. Non-goals

- Online accounts, telemetry, or cloud sync.
- Shipping prebuilt binaries in git.
- Reimplementing Ketcher's editor UI.
- Supporting glibc < 2.36 or webkit2gtk < 4.1.
- Shipping Imago/OpenCV or image recognition on Windows.
