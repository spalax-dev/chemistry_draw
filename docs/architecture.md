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

| Piece             | Technology                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| Desktop shell     | Tauri v2 (Rust)                                                            |
| Frontend          | React 18 + TypeScript + Vite                                               |
| Editor            | `ketcher-react` / `ketcher-core` 3.18.x (patched, see §10)                 |
| Chemistry backend | `indigo-server` sidecar: Rust + axum                                       |
| Native chemistry  | `libindigo`, `libindigo-renderer` (FFI)                                    |
| Image inference   | ONNX Runtime 1.31 via `ort` 2.0.0-rc.15 (dynamic, CPU, DECIMER classifier) |
| Packaging         | Linux: Docker builder → `.deb`, `.rpm`, AppImage; Windows: NSIS            |

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
│  transport/filter → service/ml/ → ONNX Runtime (CPU)             │
└───────────────────────────────┬──────────────────────────────────┘
                                │ FFI
┌───────────────────────────────▼──────────────────────────────────┐
│ libindigo / libindigo-renderer                                   │
└──────────────────────────────────────────────────────────────────┘
```

The sidecar links Indigo and Indigo Renderer on every platform. It exposes no
Imago fields: `/v2/imago/*` does not exist, and there is no job upload/polling
contract. Phase B1 adds an ONNX Runtime classifier (`POST /v2/filter/classify`)
that decides whether an image contains a chemical structure. OCSR (image →
SMILES) is still absent, so Ketcher's **Recognize Molecule** control stays hidden
until B2 wires the full pipeline, and the removed capability leaves no dead
button.

The classifier path is HTTP → `transport/filter.rs` → `service/ml/` → ONNX
Runtime (CPU). It does not touch Indigo. `/v2/info` keeps its current shape
because Ketcher parses it; the inference diagnostics live only in `/v2/health`.

The Tauri host (`src-tauri/src/lib.rs`) does **no chemistry**: it picks a free
port, spawns `indigo-server`, tracks the port it reports, forwards its logs and
kills it on exit (plus a stdin-EOF watchdog inside the sidecar for crashes).

---

## 3. Layering (one-way dependency)

Dependencies point one way only:

```text
frontend (src/)  →  HTTP  →  transport/  →  service/  →  ffi/
```

| Layer                 | Responsibility                                        | May not                 |
| --------------------- | ----------------------------------------------------- | ----------------------- |
| `src/`                | UI, Ketcher integration, API base resolution, logging | call native libs        |
| `src-tauri/src/`      | App lifecycle: port, sidecar spawn/kill, commands     | contain cheminformatics |
| `sidecar/transport/`  | HTTP parsing, status codes, JSON                      | call `ffi::` directly   |
| `sidecar/service/`    | Orchestration and domain errors                       | know about HTTP         |
| `sidecar/service/ml/` | ONNX sessions, model registry, preprocessing          | know about HTTP         |
| `sidecar/ffi/`        | `extern "C"` bindings, session handling               | know about HTTP         |

Pattern rules:

- A handler returns `Result<Json<_>, AppError>`; it never builds error bodies
  by hand (`error.rs` maps variants to status codes).
- Business logic lives in `service/`, not in handlers.
- All native calls go through `ffi/`; no `unsafe` FFI elsewhere.
- ML inference lives in `service/ml/`; handlers only validate the body, enforce
  the size cap and map errors.
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
| POST   | `/v2/filter/classify`                                               | ONNX Runtime classifier           |

Errors are `AppError` → `{ "error": "..." }`: 400 invalid input (including an
undecodable or unsupported image), 404 unknown id, 413 payload over the 10 MiB
cap, 500 backend failure, 503 model unavailable (missing, checksum mismatch or
contract mismatch). The `413` is the exception to the JSON shape: it comes from
axum's `DefaultBodyLimit`, whose body is plain text, not `{ "error": ... }`.
`/v2/info` exposes Indigo versions only; `/v2/health` adds the targeted ONNX
Runtime API generation and the model ids whose artifacts are present on disk.
There is no `/v2/imago/*` surface and no job upload/polling contract.

---

## 6. ONNX inference foundation

Phase B replaces Imago with a two-model pipeline: a **filter** (does the image
contain a chemical structure?) and an **OCSR** model (image → SMILES). B1
delivers the runtime foundation and the filter only. Model download, OCSR, UI
wiring and `libonnxruntime` packaging are out of scope for B1.

### Runtime

- Rust binding: `ort` **2.0.0-rc.15** (pykeio), pinned, built with
  `default-features = false` and features `std`, `api-31`, `load-dynamic`.
- `libonnxruntime` is **loaded dynamically at runtime**: the sidecar has no
  link-time dependency on it and B1 never bundles it. The path comes from
  `ORT_DYLIB_PATH`; when unset, the bare platform name
  (`libonnxruntime.so` / `onnxruntime.dll`) is passed to the loader, so
  `LD_LIBRARY_PATH` / `PATH` applies. A failed load is an actionable error
  (HTTP 503), never a panic.
- Developer/runtime setup: `scripts/fetch-onnxruntime.sh` downloads the pinned
  ONNX Runtime **1.31.0** Linux x86_64 shared build, verifies its SHA-256 and
  extracts only `lib/libonnxruntime.so*` into the gitignored
  `.ort/linux-x86_64/`, preserving the `libonnxruntime.so` -> `libonnxruntime.so.1`
  -> `libonnxruntime.so.1.31.0` chain. It is idempotent, fails with a clear
  message on other platforms, and never downloads models. The pinned URL and
  checksum live in the script.
- Debug host: `src-tauri/src/lib.rs` sets `ORT_DYLIB_PATH` on the sidecar when
  `.ort/<platform>/libonnxruntime.so` (or `onnxruntime.dll`) exists, and logs
  the path. Release packaging/shipping of the runtime is a follow-up activity.
- Execution provider: **CPU only**, one intra-op thread, telemetry disabled. No
  GPU providers.
- Sessions are created lazily on first use and cached for the process lifetime,
  so the sidecar starts — and keeps serving Indigo — with no models and no
  runtime installed.

### Model directory and manifest

Models are never bundled with the app and never committed. The model root comes
from `CHEMISTRY_MODELS_DIR`; debug builds default to `<repo>/models`
(gitignored). Release delivery (the host providing a downloaded model root) is
Phase B3 and not implemented yet; a release build without the variable falls
back to `models` in the working directory.

```text
models/
  manifest.json
  image-classifier-fp16/
    classifier.fp16.onnx
```

`manifest.json` is the source of truth for each model: artifact path,
`artifact_sha256`, provenance id and the exact tensor contract. Loading checks
the file checksum, then validates input/output names, shapes and dtype against
the graph. A missing file, checksum mismatch or contract mismatch is a
configuration error (HTTP 503), never a silent fallback.

```json
{
  "schema": 1,
  "models": {
    "image-classifier": {
      "id": "image-classifier@Iagea/d21f4cb",
      "file": "image-classifier-fp16/classifier.fp16.onnx",
      "artifact_sha256": "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9",
      "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
      "license": "MIT",
      "threshold": 0.000089,
      "preprocessing": "runtime_default",
      "inputs": [
        { "name": "input_2", "dtype": "float32", "shape": [1, 224, 224, 3] },
        { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
        { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
      ],
      "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
    }
  }
}
```

### Classifier tensor contract

Artifact `image-classifier-fp16/classifier.fp16.onnx`, provenance
`image-classifier@Iagea/d21f4cb`.

| Tensor       | Direction | dtype   | Shape              | Content            |
| ------------ | --------- | ------- | ------------------ | ------------------ |
| `input_2`    | input     | float32 | `[1, 224, 224, 3]` | preprocessed image |
| `45214:0`    | input     | float32 | `[1, 1, 1, 3]`     | zeros (auxiliary)  |
| `45216:0`    | input     | float32 | `[1, 1, 1, 3]`     | zeros (auxiliary)  |
| `Identity:0` | output    | float32 | `[1, 1]`           | one logit          |

The exported graph declares a **dynamic batch dimension** (`-1`); the manifest
and this contract use batch `1`, which is what the app always feeds. Contract
validation treats `-1` as dynamic and requires every other dimension to match
exactly.

Post-processing: `score = sigmoid(logit)`; the image is `structure` when
`score <= 0.000089`, otherwise `no-structure`. The direction is deliberate: a
**low** score means structure. The model is binary and emits nothing else.

Identity:

- artifact sha256 `d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9`;
- upstream checkpoint sha256
  `1f1f192e3a63c8985f20d8a0777a558458ef829379e5373fdad25bc0b4161978` — provenance
  only, **not** the file hash;
- license: MIT (Iagea/DECIMER-Image-Classifier), see `NOTICE`.

### Preprocessing (`runtime_default`, must not drift)

1. Composite RGBA on a white background.
2. Convert to grayscale, then back to 3-channel RGB.
3. Aspect-preserving LANCZOS resize so the longest side is 224.
4. Paste centered on a white 224×224 canvas.
5. Feed float32 values in `0..255`, NHWC (`[1, 224, 224, 3]`).

The two auxiliary inputs are fed zeros. Decoding is bounded before any pixels
are materialized: images wider or taller than **12,000 px** or needing more than
**128 MiB** of decoder allocations are rejected with `400`, exactly like
undecodable bytes. Invariants, measured in the integration report and not
negotiable without new evidence:

- **Never auto-invert** scans or photos: hand-drawn OCSR fell to 0/289 canonical
  and the classifier lost 14.85 pp where it was measured.
- **Never histogram-equalize**: the classifier lost 14.19 pp.
- **No sharpening or autocontrast in the default path**: the winners flip by
  domain (printed vs hand-drawn), so no transfer is assumed.

Any preprocessing change requires a measured delta on the frozen evaluation
before it ships; "looks cleaner" is not evidence.

### Known limitation: the classifier is binary only

The model separates `structure` from `no-structure`; it cannot tell one molecule
from several, and it does not detect reactions. In the frozen evaluation, 146 of
250 `several_molecules` images (~58%) were classified `no-structure`, and those
146 account for 146 of the 174 false negatives. The classifier runs without a
confidence gate: its AUC is 0.603 and the dominant error is systematically
confident, so a gate would not recover it. The B2 UX must not promise
multi-molecule or reaction handling, and "no structure" is not proof that no
structure exists.

Measured latency on CPU in the toolchain report: p50 **49 ms**, p95 **206 ms**.

### Endpoint

`POST /v2/filter/classify`

- Body: raw image bytes with `Content-Type: image/png`, `image/jpeg` or
  `image/webp`. No multipart, no base64, no job id.
- Limit: 10 MiB (10,485,760 bytes). Bodies of exactly 10,485,760 bytes are
  decoded; larger bodies get `413`. That `413` comes from axum's
  `DefaultBodyLimit` and its body is plain text, not `{ "error": ... }`.
- `200` response:

```json
{
  "contains_molecule": true,
  "category": "structure",
  "score": 0.0000042,
  "threshold": 0.000089,
  "logit": -12.38,
  "model": "image-classifier@Iagea/d21f4cb"
}
```

`category` is `structure` when `contains_molecule` is `true` and `no-structure`
otherwise. `score` is `sigmoid(logit)` and `threshold` is `0.000089`, echoed so
clients do not hardcode it.

- Errors: `400` undecodable or unsupported image (including over-limit
  dimensions or decoder allocations), `413` payload over 10 MiB, `503` model
  unavailable (missing, checksum mismatch or contract mismatch).

### Health and module map

`/v2/health` adds `onnxruntime_version` and `models` to the existing
diagnostics. `onnxruntime_version` names the ONNX Runtime **API generation**
`ort` targets (for example `onnxruntime api 1.31.x (ort 2.0.0-rc.15)`), not the
loaded binary's exact patch version. `models` lists only ids declared by the
manifest **whose artifact file exists on disk** (a cheap existence check, no
session), for example `image-classifier@Iagea/d21f4cb`.
`/v2/info` is **unchanged**: Ketcher parses it and does not need inference
metadata.

```text
sidecar/src/
  transport/filter.rs     POST /v2/filter/classify
  service/ml/
    mod.rs                shared cache and entry points
    runtime.rs            dynamically loaded ONNX Runtime environment and sessions
    registry.rs           model root, manifest, checksum, contract validation
    preprocess.rs         runtime_default image → NHWC tensor (bounded decode)
    classifier.rs         three-input run, sigmoid, threshold
```

---

## 7. Native libraries

Indigo and Indigo Renderer are **not vendored in git**.

- **Linux**: built in the Docker builder and copied by `task libs` into
  `src-tauri/lib/linux-x86_64/` (gitignored). The same directory is what
  packaging ships. `libstdc++` and `libgcc_s` are **never** shipped: the target
  distro runtime is used. The real support floor is **glibc 2.36**
  (`arc4random@GLIBC_2.36` in `libindigo.so`): Debian 12+, Ubuntu 24.04+,
  current Fedora.
- **Windows**: `scripts/fetch-windows-libs.ps1` downloads the pinned EPAM
  Indigo **1.46.0** x86_64 archive, verifies its SHA-256, extracts
  `indigo.dll`, `indigo-renderer.dll`, `msvcp140.dll`, `vcruntime140.dll` and
  `vcruntime140_1.dll` into `src-tauri/lib/windows-x86_64/` (gitignored) and
  generates the MSVC import libraries `indigo.lib` / `indigo-renderer.lib`
  from the `indigo*` C exports.

ONNX Runtime is not part of that set in B1: the sidecar uses it for inference
but loads it **dynamically** from the developer's `.ort/` directory (or the
loader search path). Obtaining and bundling `libonnxruntime` for Linux and
Windows is a separate follow-up activity; no package may contain it. Model
weights are never bundled under any circumstance.

---

## 8. Packaging

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
Indigo/MSVC DLLs under `lib/windows-x86_64/`; `externalBin` lists only
`indigo-server`.

The Windows build lives in `.github/actions/windows-build`: toolchain, DLL fetch,
sidecar build, harness, smoke test and NSIS bundle. Both `ci.yml` (artifact) and
`release.yml` (release asset) call it, so the published installer is the same
one CI validated. A release publishes `.deb`, `.rpm`, AppImage and the Windows
`.exe`.

The NSIS bundle keeps Tauri's default per-user install and embeds only the
WebView2 bootstrapper (`embedBootstrapper`). WebView2 is part of normal Windows
10/11 installations; systems where Edge/WebView2 was removed are not supported.
Bundling the offline runtime (~215 MB) was tried and rejected as too large.

`scripts/build-packages.sh` serializes runs with `flock` because concurrent
builds share the target volume and bundle directory.

Version bumps are driven by release-please and must stay in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
`src-tauri/sidecar/Cargo.toml`.

---

## 9. Observability

- Rust host + frontend + sidecar output go to a rotating file via
  `tauri-plugin-log` (stdout + app log dir, 2 MB × 5 files).
- The sidecar's stdout/stderr is forwarded line by line with ANSI stripped.
- `GET /v2/health` exposes uptime, PID, port, the Indigo version, the targeted
  ONNX Runtime API generation and the model ids whose artifacts are on disk. It
  is for support, not for Ketcher.
- Panics are logged with location.

---

## 10. Temporary workaround

`ketcher-core` 3.18.0 has a bug in `parametrizeUrl` that turns the port in
`127.0.0.1:9321` into a placeholder. We ship `patches/ketcher-core@3.18.0.patch`
(registered in `pnpm-workspace.yaml`). Upstream fixed it in
[epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552) but has not
published a release with the fix yet. Removal procedure:
`docs/KETCHER-BUG-parametrizeUrl.md`.

---

## 11. Non-goals

- Online accounts, telemetry, or cloud sync.
- Shipping prebuilt binaries in git.
- Reimplementing Ketcher's editor UI.
- Supporting glibc < 2.36 or webkit2gtk < 4.1.
- Shipping Imago or OpenCV. B1 ships an ONNX classifier gate only; B2 adds OCSR
  through the two-model pipeline. Model weights are not bundled in B1, and
  `libonnxruntime` is loaded dynamically from the developer's `.ort/` directory
  (shipping it is a follow-up activity).
