# Architecture

> The shape of the 1.x line: context, containers, layers, data and the rules that
> keep them coherent. This document is a map;
> [`docs/architecture.md`](../architecture.md) is the detailed reference and stays
> authoritative for shipped behaviour.
>
> **Reconstructed from the code on 2026-11-21.** Updated for the US-01 port of
> the `main` 0.1.8 backstage/file workflow (ADR 0009); the 1.x ML surface is
> unchanged. The port lands through ACT-02–ACT-05, and the detailed
> [`docs/architecture.md`](../architecture.md) is reconciled as each surface
> lands. Diagrams live in `docs/planning/c4/` and the flows in
> `docs/planning/sequences/`.

## 1. System context

Chemistry Draw is a single-user desktop application. It is used by a chemist,
teacher, student or occasional user and depends on four external things: the
desktop OS runtime (WebView2 on Windows, WebKitGTK on Linux), the host's font and
image libraries, the native Indigo libraries built or fetched at packaging time,
and the Hugging Face model repository used only for the opt-in download.

Diagram: `docs/planning/c4/context.puml`.

| External system           | Purpose                                                                       | Failure behavior                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop OS runtime        | Window, WebView, file dialogs, app-data and log directories, process control  | The app cannot start; there is no headless mode                                                                                         |
| Host font/image libraries | `fontconfig`, `freetype`, `expat`, `libpng`, `libbrotli` for PNG rendering    | PNG/SVG rendering degrades or fails; Indigo conversion and OCSR keep working                                                            |
| Hugging Face repository   | Hosts the pinned classifier, OCSR encoder/decoder and vocabulary              | Recognition stays unavailable; `GET /v2/models` reports the missing artifacts and the download error is actionable; drawing still works |
| Native Indigo libraries   | Cheminformatics and rendering via C FFI                                       | The sidecar cannot serve Indigo routes and the app is not packaged for release                                                          |
| ONNX Runtime 1.31.0       | CPU inference runtime, loaded dynamically at process start of first inference | Indigo keeps serving; filter and OCSR answer `503` with an actionable message                                                           |

There is no server, no database service and no user account. The sidecar binds a
loopback port chosen by the host on every launch.

## 2. Containers

Diagram: `docs/planning/c4/container.puml`.

| Container               | Technology                                                        | Responsibility                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ketcher webview         | React 18, TypeScript, Vite 6, `ketcher-react`/`ketcher-core` 3.18 | Backstage, editor tabs, File menu, recent structures, document workflow, in-app dialogs, model setup UI, error mapping                                        |
| Tauri host              | Rust, Tauri v2                                                    | Window lifecycle, free-port selection, sidecar spawn/supervision, environment, log forwarding, two IPC commands                                               |
| `indigo-server` sidecar | Rust, axum 0.7, tokio 1                                           | `/v2` HTTP API: Indigo operations, filter, OCSR, model delivery, Ketcher job shim, health                                                                     |
| Model store             | Filesystem under `<app_data>/models`                              | `manifest.json` plus the classifier, encoder, decoder and vocabulary artifacts                                                                                |
| User documents          | Filesystem                                                        | `.ket` documents, exported Molfile/SMILES/InChI/SVG/PNG, per-tab recovery snapshots under `<app_data>/recovery/tabs` and previews under `<app_data>/previews` |

Rules:

- The webview owns no chemistry and the host owns no chemistry. The sidecar is
  the only container that links Indigo or opens an ONNX session.
- The host never links Indigo, Indigo Renderer or ONNX Runtime. It passes paths
  and environment variables and forwards logs.
- A container owns its data: the model store is written by the sidecar's
  downloader, the document paths are written by the webview through Tauri's fs
  plugin, and the host only creates the release model root directory.
- Every cross-container call has a documented failure mode; see
  `docs/planning/contracts.md`.
- The sidecar is stateless except for a process-lifetime inference-session cache
  and the in-memory recognition job store, which exists only to bridge Ketcher's
  asynchronous protocol.

## 3. Components and layers

Diagram: `docs/planning/c4/component.puml` (the sidecar container).

The sidecar is split into layers with a one-way dependency:

```text
transport/  →  service/  →  ffi/
                   │
                   └──→  service/ml/  →  ONNX Runtime (loaded dynamically)
```

| Layer         | Contains                                                                                                     | May import from                    | May not                  |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------ |
| `transport/`  | `info`, `health`, `indigo`, `filter`, `ocsr`, `imago`, `models` handlers; media-type and body-cap validation | `service/`, `error.rs`, `state.rs` | call `ffi::` directly    |
| `service/`    | `indigo_ops`, `recognition`, `jobs`, `types`; domain orchestration and failure mapping                       | `ffi/`, `service/ml/`              | know about HTTP          |
| `service/ml/` | runtime, registry, catalog, downloader, classifier, OCSR, preprocessing, paths, vocabulary and decode        | `ort`, filesystem, HTTP client     | know about HTTP handlers |
| `ffi/`        | `extern "C"` bindings and session handling                                                                   | `libindigo`, `libindigo-renderer`  | know about HTTP or ML    |

Frontend layers follow the same one-way rule:

| Layer                  | Contains                                                                                                                                                                                                 | May import from                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `src/ui/`              | presentational components (`Backstage`, `TabStrip`, `FileMenu`, `HomeButton`, `Dialog`, `Button`, `DocumentDialogs`, `ModelSetupDialog`, `ui/backstage/`, icon style)                                    | `src/*` pure modules, design tokens |
| `src/*.ts`             | pure helpers and thin adapters (tabs/tabStore, backstage, recent structures and details, preview cache, templates, document, autosave scheduler/metadata, routing, errors, model setup, Ketcher options) | React types, injected I/O           |
| `src/App.tsx`          | composition: provider, event loop, dialog state, sidecar polling                                                                                                                                         | all frontend modules                |
| `src-tauri/src/lib.rs` | host lifecycle and commands                                                                                                                                                                              | Tauri APIs                          |

Rules:

- No cycles between layers. Business logic lives in `service/` or in a pure `src`
  module, never inline in a handler or JSX event handler.
- Handlers return `Result<Json<_>, AppError>`; they never build an error body by
  hand (`sidecar/src/error.rs` maps variants to status codes).
- All native calls go through `ffi/`; `unsafe` is confined there.
- ML handlers validate the body, enforce the 10 MiB cap and map errors; inference
  lives in `service/ml/`.
- New Ketcher-boundary code stays in `src/`; a Ketcher bug that cannot be fixed
  there becomes a versioned patch under `patches/`.
- The backstage overlays the one mounted editor; it is not a route, a second
  window or a second Ketcher instance.
- A tab is file state over that single editor: switching serializes, flushes and
  reloads, and never mounts a second editor.

## 4. Data

There is no database and no migration framework. All state is files:

- **Documents:** one `.ket` per tab, several tabs per window. A path belongs to
  at most one tab. Save writes `.ket` only; Export writes a separate file and
  never changes the tab's path or format (`docs/architecture.md` §5.2–5.3).
- **Recovery snapshots:** `<appDataDir>/recovery/tabs/<id>.ket` plus
  `<id>.json` as that tab's commit record, and `index.json` for the order and
  active id. A `.ket` without matching metadata is never restored
  (`docs/architecture.md` §5.5).
- **Recent list:** `localStorage["chemistry-draw.recent"]`, an array of absolute
  `.ket` paths, newest first, deduplicated and capped at 10. It is UI state, not
  a document: removing an entry never touches a file or a tab.
- **Previews:** `<appDataDir>/previews/<sha256(molfile)>.svg`, the Indigo render
  used by the recent-structures thumbnails; the content hash is the key.
- **Model store:** `<model root>/manifest.json` and the artifact directories
  named by the bundled catalog. The manifest is written last, through a
  temporary file and an atomic rename, after every artifact verifies
  (`docs/architecture.md` §7, "Generated manifest").
- **Logs:** rotating file in the app log directory, 2 MB × 5, plus stdout. The
  sidecar's output is forwarded line by line with ANSI stripped.
- **Session state:** the recognition job store is in memory; a sidecar restart
  drops every job. Nothing about jobs is persisted.

Schema and migration policy:

- `.ket` is owned by Ketcher; this app does not version it and must not silently
  rewrite it.
- The per-tab snapshot is app-owned JSON (`{ name, path, savedAt, dirty }`) plus
  the KET text. A missing `name` falls back to the base name of `path`; there is
  no index migration, because `index.json` stores only ids and the active id.
  Unknown or corrupt snapshots are dropped, never guessed.
- `manifest.json` keeps `schema: 1`. Unknown fields are ignored; adding a model
  key does not change the schema. A schema change is an ADR plus a loader
  change.
- No production data exists in tests: sidecar tests build fixtures and dummy
  artifacts; model-gated tests use the developer's `models/` directory.

## 5. Data flows

### 5.1 Backstage, tabs and file workflow

The webview mounts Ketcher with a `RemoteStructServiceProvider` pointed at
`http://127.0.0.1:<port>/v2/`. Ketcher calls Indigo routes for conversion,
layout, aromatization, rendering and checks. One `<Editor>` is mounted for the
window's lifetime; the backstage and the tab strip are app chrome above it.

**Backstage.** Every launch opens on the in-app **backstage** instead of the
editor splash. It is one `role="dialog"` overlay with a top bar, a four-section
rail (**Welcome**, **Open**, **Models**, **About**) and a **Back to editor**
action; a home button at the left of the tab strip reopens it. Welcome offers
Blank canvas, Import structure…, Open project…, four cards sampled from Ketcher's
real Structure Library (with Indigo-rendered previews) and the Recent structures
table. Open shows the same table with Remove plus the open tabs. About reads
`package.json` and `/v2/info`. The Models rail entry never shows a fake model
list: its button calls the App's `onOpenModels` and raises the real
`ModelSetupDialog` above the overlay while the backstage stays behind it. 1.x
keeps the real Models dialog and toolbar entry as the model setup surface
(ADR 0009, ADR 0010). The backstage never mounts a second editor, never saves and
never discards work.

**Component boundaries.** The port keeps the UI presentational and the state in
the pure modules: `src/backstage.ts`, `src/fileMenu.ts`, `src/tabs.ts`,
`src/recent*.ts` and `src/templateLibrary.ts` own the models;
`src/ui/Backstage.tsx`, `src/ui/TabStrip.tsx`, `src/ui/FileMenu.tsx` and
`src/ui/backstage/` render them and report events; `src/App.tsx` owns the
commands and the I/O. The Models pane's `onOpenModels` handler is wired in
`App.tsx` to the real model dialog, so there is no second setup surface or fake
list (ADR 0010).

**Tabs.** A tab is file state (`id`, `name`, `path`, committed `ket`, `dirty`)
over the single editor. Switching serializes the outgoing tab with
`ketcher.getKet()`, flushes its snapshot, then loads the incoming tab with
`ketcher.setMolecule()` behind a loading flag, so a programmatic load never marks
the target dirty. `src/tabs.ts` owns the pure model; `src/tabStore.ts` owns the
snapshot I/O. The title precedence is the base name of `path`, then `name`, then
`Untitled`; dirty tabs show a dot in the strip and `*` in the window title. A
`.ket` path belongs to at most one tab; Open… and a recent entry that target an
open path activate that tab instead of creating a duplicate. An imported
structure is serialized back to KET after `setMolecule`, so its snapshot is a
real `.ket` document and restores on the next launch.

**File menu.** All document commands live in a **File** menu at the left of the
tab strip: New, Open… (`.ket`), Import… (`mol`, `smi`, `inchi`, `sdf`, `rxn`),
Save, Save As…, Export… and up to 10 recent documents. Save (`Ctrl+S`) writes the
active tab's `ketcher.getKet()` as UTF-8 `.ket`; an untitled tab falls through to
Save As. Save As (`Ctrl+Shift+S`) adopts a chosen `.ket` path. Export writes one
other format and never changes the tab's path or format. New (`Ctrl+N`) reuses
an untouched empty tab or opens a new one and never prompts; Open… reuses an
untouched empty tab or opens a new one and never prompts for a dirty tab.
Imported structures have `path: null` and a clean dirty flag; their first Save is
a Save As. Ketcher's native Save As is hidden because it defaults to Molfile;
native Open stays visible as the "load into the current canvas" shortcut.

**Command surface and shortcuts.** The File menu is the complete command
surface. The 1.x top toolbar keeps Save, New, Export and Models as a second
entry point to the same commands: the first three dispatch the active-tab
command and Models opens the real setup dialog, so no rule is duplicated
(ADR 0010). The app registers its document shortcuts in the capture phase so
Ketcher never sees them: `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O`, `Ctrl+N`, `Ctrl+W`,
`Ctrl+T` and `Ctrl+Tab`. `Ctrl+W` closes the active tab, `Ctrl+T` is New and
`Ctrl+Tab` cycles the strip. A matched combination is always swallowed; the
command itself is skipped while the backstage, Models, Export, a close prompt,
an error, a notice or a running save owns the app, and the File popup is
dismissed first. Errors use the in-app `ErrorDialog`/`NoticeDialog`, never a
native message box (`docs/planning/contracts.md` §5).

**Save, close and recovery.** Save/Export route through the aliased `file-saver`
and Tauri's fs plugin (`docs/planning/contracts.md` §5). Autosave writes the
active tab's snapshot after a debounce plus a slow interval, and switching
flushes the outgoing tab. Save/Open/New write a clean snapshot; only a tab close
or Discard removes snapshot files. Launch restores the tab set silently and
drops missing/corrupt snapshots. The close guard is decided from all dirty
tabs: none closes, one active dirty tab offers Save/Discard/Cancel, and more
than one (or one inactive) offers Discard/Cancel only. These are the 1.x
behavior adopted from `main`; the `.ket` save/export/autosave contract itself did
not change.

The single-document recovery path is gone (ADR 0010, ACT-07): `RecoveryDialog`,
`src/autosaveStore.ts` and `shouldOfferRecovery` no longer exist, so there is no
`recovery/autosave.ket`/`autosave.json` snapshot, no recovery prompt and no
"newer than the original mtime" decision. `src/tabStore.ts` is the only snapshot
writer and reader; `src/autosave.ts` keeps the debounce scheduler, the metadata
parser and the write-generation helper that the tab store and `App.tsx` consume.

### 5.2 Recognition

`docs/planning/sequences/recognition-flow.puml`. Ketcher's built-in Recognize
control hardcodes `POST /v2/imago/uploads` and polls
`GET /v2/imago/uploads/{id}`. The sidecar accepts the image, stores it in the job
store, and a blocking worker runs:

1. the ONNX binary filter (`contains_molecule`);
2. the hand-drawn OCSR encoder/decoder, with a repetition guard and a confidence
   gate;
3. SMILES → V2000 molfile through the same Indigo conversion the editor uses.

The result is `{ state: "SUCCESS", metadata: { mol_str } }`. Every failure is a
`FAILURE` job (HTTP 200) that the webview maps to in-app copy; only an unknown,
expired or restarted job id is `404`.

### 5.3 Model setup and download

`docs/planning/sequences/model-setup.puml`. A clean install has an empty model
root, so `GET /v2/models` reports `ready: false` and `/v2/info` advertises
`imago_versions: []`, which disables Recognize. The app auto-opens the setup
dialog once and offers **Download** (opt-in). The downloader preflights free
space, streams each artifact to a `.part` file with HTTP Range resume, verifies
size and SHA-256, installs with an atomic rename and writes the manifest last.
The dialog polls `GET /v2/models` every 500 ms while a run is active. On `ready`,
the app copies the freshly advertised capability into Ketcher's option store in
place, so Recognize enables without a remount or canvas loss.

### 5.4 Startup

The host chooses an unused preferred port, spawns the sidecar with `INDIGO_PORT`,
`CHEMISTRY_MODELS_DIR`, `ORT_DYLIB_PATH` and the platform library path, and
watches stdout for `INDIGO_PORT=<actual>`; the webview polls `GET /v2/info`
until it answers and then mounts/updates Ketcher. The backstage renders from the
first frame, replacing the loading splash, while the provider resolves and the
tab set restores underneath; readiness does not dismiss it. On a clean install
the model status read marks the setup dialog for one auto-open after paint; the
dialog appears above the backstage, which stays behind it, and closing it returns
to Welcome. A stdin-EOF watchdog inside the sidecar kills it if the host dies
without a clean shutdown.

## 6. Cross-cutting concerns

| Concern        | Decision                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration  | Environment variables only: `INDIGO_PORT`, `CHEMISTRY_MODELS_DIR`, `CHEMISTRY_MODEL_CATALOG` (support override), `ORT_DYLIB_PATH`, `TAURI_DEV_HOST` |
| Secrets        | None. The app has no credentials; model downloads are anonymous HTTPS                                                                               |
| Logging        | `tauri-plugin-log` rotating file plus forwarded sidecar output; no file contents, images or documents in logs                                       |
| Error taxonomy | `AppError` → `{ "error": "..." }`; 400/404/409/413/422/500/503. The 413 from `DefaultBodyLimit` is the documented plain-text exception              |
| Security       | Loopback-only HTTP with CORS enabled for the webview; Tauri capabilities are the single source of filesystem scope; no cloud surface                |
| Privacy        | No telemetry. Only the opt-in model download contacts the network, and only model artifacts are fetched                                             |
| Performance    | CPU-only inference, lazy cached sessions, one intra-op thread. Classifier p50 49 ms/p95 206 ms; OCSR p50 1115 ms/p95 2156 ms (integration report)   |
| Observability  | `GET /v2/health` (uptime, PID, port, Indigo, ONNX Runtime API generation, model ids present) and `GET /v2/models` for support and the UI            |
| Compatibility  | glibc ≥ 2.36, webkit2gtk 4.1, Windows 10/11 with WebView2. Indigo is platform-pinned; ONNX Runtime is 1.31.0 on both platforms                      |

## 7. Decisions

Architecture decisions live in `docs/planning/adr/`. This document describes the
current state of the 1.x line; the ADRs record why it changed. The decisions that
shape this architecture are:

| ADR                                                    | Decision                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [0002](adr/0002-remove-imago-and-recognize-locally.md) | Remove Imago and recognize through a local ONNX pipeline                  |
| [0003](adr/0003-dynamic-onnx-runtime-loading.md)       | Load ONNX Runtime dynamically and ship the runtime, not weights           |
| [0004](adr/0004-hugging-face-model-delivery.md)        | Deliver models from Hugging Face on demand (B3)                           |
| [0005](adr/0005-ketcher-parametrizeurl-patch.md)       | Patch Ketcher per version through pnpm, never `node_modules`              |
| [0006](adr/0006-ocsr-single-model-parity.md)           | One hand-drawn OCSR model with a calibrated parity gate                   |
| [0007](adr/0007-two-line-repository-model.md)          | Maintain two repository lines                                             |
| [0009](adr/0009-update-1x-from-main-baseline.md)       | Update 1.x from the `main` 0.1.8 baseline, keeping the 1.x ML surface     |
| [0010](adr/0010-app-integration-and-model-surface.md)  | One command path, two entry points: workflow from `main`, Models from 1.x |

If a story changes the architecture, it must update this document and add an ADR
in the same activity.
