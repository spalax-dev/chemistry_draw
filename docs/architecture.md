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

| Piece             | Technology                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Desktop shell     | Tauri v2 (Rust)                                                                               |
| Frontend          | React 18 + TypeScript + Vite                                                                  |
| Editor            | `ketcher-react` / `ketcher-core` 3.18.x (patched, see §11)                                    |
| Chemistry backend | `indigo-server` sidecar: Rust + axum                                                          |
| Native chemistry  | `libindigo`, `libindigo-renderer` (FFI)                                                       |
| Image inference   | ONNX Runtime 1.31.0 (shipped) via `ort` 2.0.0-rc.15 (dynamic, CPU, DECIMER classifier + OCSR) |
| Packaging         | Linux: Docker builder → `.deb`, `.rpm`, AppImage; Windows: NSIS                               |

---

## 2. Process and data flow

```text
┌──────────────────────────── WebView ────────────────────────────┐
│  React + Ketcher                                                │
│  App.tsx → resolveApiBase() → StaleSafeStructServiceProvider    │
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

The sidecar links Indigo and Indigo Renderer on every platform. It ships no
Imago backend: no Imago library, worker binary or native dependency, and
`/v2/health` has no Imago fields. Ketcher's built-in **Recognize Molecule**
control, however, hardcodes the Imago job protocol: `POST
{apiPath}imago/uploads` followed by `GET {apiPath}imago/uploads/:id`. The
sidecar registers that pair as a **compatibility shim**: the route name is
Ketcher's, the pipeline behind it is the local filter + OCSR + Indigo path, and
the real Imago library never runs. `/v2/info` advertises one synthetic
`imago_versions` entry (`local-ocsr`) because Ketcher disables the control when
the list is empty; it is capability advertisement, not an Imago build.

Phase B1 adds an ONNX Runtime classifier (`POST /v2/filter/classify`) that
decides whether an image contains a chemical structure. Phase B2 adds OCSR
inference (image → SMILES) through `POST /v2/ocsr/recognize`, the contract
activity 8 defines. Activity 9 (`phase-b2-recognize-e2e`) wires them end to end
— filter gate → OCSR → SMILES → V2000 molfile through Indigo — behind the
`imago/uploads` job protocol and re-enables the **Recognize Molecule** UI. The
flow is implemented; section 7 is its contract.

The inference paths are HTTP → `transport/{filter,ocsr}.rs` → `service/ml/` →
ONNX Runtime (CPU). They do not touch Indigo. The compatibility path is the one
exception: `transport/imago.rs` → `service/recognition.rs` runs the two ML
stages and then converts the SMILES through `ffi/` Indigo, because Ketcher needs
a molfile, not a SMILES. `/v2/info` keeps the fields Ketcher parses (plus the
synthetic capability list above); the inference diagnostics live only in
`/v2/health`.

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
- Ketcher is mounted through `StaleSafeStructServiceProvider` (a thin
  `RemoteStructServiceProvider` subclass) pointing at
  `http://127.0.0.1:<port>/v2/`; it discards stale recognition results (§7).
- `src/logging.ts` transparently mirrors `console.*`, uncaught errors and
  unhandled rejections into the Tauri log. It is a no-op outside Tauri.
- **Recognize Molecule** is Ketcher's built-in "Import Structure from Image"
  dialog. `App.tsx` removes the `hidden` button option and the sidecar
  advertises the synthetic `imago_versions` capability; Ketcher POSTs the
  image and polls the compatibility job. Failures reach `errorHandler` as JSON
  text; `src/recognizeErrors.ts` unwraps and maps them, and `App.tsx` renders
  every one in the in-app `ErrorDialog` (title `Structure problem`), never a
  native OS alert.
- Hash/`file-saver` shims exist for the webview; do not add Node-only APIs.
  `file-saver` resolves through the Vite alias described in §5.7.

---

## 5. Document model and file workflow

Chemistry Draw behaves like a word processor: **one document per window**,
identified by its path, and `.ket` is the only format Save ever writes.

### 5.1 Document state

```ts
interface DocumentState {
  path: string | null; // user-chosen .ket file, null = never saved
  format: "ket"; // the only save format
  dirty: boolean; // unsaved edits since the last save/open/new
}
```

- The window title shows the file's base name without the extension
  (`benzene`), or `Untitled` when `path` is `null`, plus `*` while dirty
  (`benzene*`). `documentTitle(state)` is a pure helper.
- `dirty` starts `false`, becomes `true` on the first editor change and returns
  to `false` only after a successful Save, Open or New.

### 5.2 Save policy

- **Save** (`Ctrl+S`) writes `ketcher.getKet()` as UTF-8 text to `path`. With
  `path === null` it behaves as Save As defaulting to `untitled.ket`.
- **Save As** (`Ctrl+Shift+S`) asks for a destination through the Tauri `save`
  dialog filtered to `.ket`, appends the extension when missing, writes, and
  adopts the new path. The previous file is left untouched.
- Save never writes another format and never changes `format`.
- Both commands are available from Ketcher's toolbar (§5.7) and the keyboard.

### 5.3 Save vs Save As vs Export

| Command | Shortcut       | Writes                        | Changes `path`                      | Changes `format` |
| ------- | -------------- | ----------------------------- | ----------------------------------- | ---------------- |
| Save    | `Ctrl+S`       | `.ket` to `path` (or Save As) | on first save                       | no               |
| Save As | `Ctrl+Shift+S` | `.ket` to the chosen path     | yes                                 | no               |
| Export  | —              | one other format to a file    | **no**                              | **no**           |
| New     | `Ctrl+N`       | nothing                       | set to `null`                       | stays `ket`      |
| Open    | `Ctrl+O`       | nothing                       | the `.ket` path, `null` for imports | stays `ket`      |

Export is the only route to another format. It writes a separate file and
never changes the document path or the save format.

**Open** behaves differently per format:

- A `.ket` file becomes the document: `path` is the chosen file and the
  document is clean, so the title shows its base name without `*`.
- `.mol`, `.smi`, `.sdf`, `.rxn` and any other structure format are imported
  through `ketcher.setMolecule`; no `.ket` file backs them, so `path` stays
  `null` (`Untitled`) and the document is marked dirty.

**New** and **Open** replace the current document, so with unsaved edits they
ask first, using the same Save / Discard / Cancel prompt as the close guard
(§5.5): Save writes the document and then proceeds, Discard proceeds without
saving, Cancel aborts the command. Export never replaces the document and never
prompts.

| Export format | Source                                                |
| ------------- | ----------------------------------------------------- |
| Molfile V2000 | `ketcher.getMolfile("v2000")`                         |
| Molfile V3000 | `ketcher.getMolfile("v3000")`                         |
| SMILES        | `ketcher.getSmiles()`                                 |
| InChI         | `ketcher.getInchi()`                                  |
| SVG           | `ketcher.generateImage(ket, { outputFormat: "svg" })` |
| PNG           | `ketcher.generateImage(ket, { outputFormat: "png" })` |

Image formats render through `generateImage`, which returns a `Blob` that goes
through the same save dialog as the text formats. `ketcher.exportImage` is
deliberately **not** used: in Ketcher 3.18 it supports only `"svg"` and throws
for `"png"`, while `generateImage` covers both through the same save route.

`getSdf`, `getCml`, `getCDXml` and `getRxn` exist on the same API if more
export entries are added later, but they are not part of this contract.

### 5.4 Autosave and recovery

Snapshots live in the Tauri app data directory, never next to the user's file:

```text
<appDataDir>/recovery/autosave.ket    working structure (.ket text)
<appDataDir>/recovery/autosave.json   { path, savedAt, dirty }
```

- **Signal**: subscribe to `ketcher.changeEvent` (`Subscription.add` /
  `Subscription.remove`); the typed alternative is
  `ketcher.editor.subscribe("change", handler)`.
- **Scheduling**: debounce about 2 s after the last change, plus a slow
  interval (30 s) as a safety net. Both timers are pure inputs to
  `autosave.ts`; the interval only writes while `dirty`.
- **Writes**: the `.ket` text first, then `autosave.json` last as the commit
  record. A `.ket` without matching metadata is never restored. When `rename`
  is available, write `autosave.ket.part` and rename it over the snapshot.
- **Never while clean**: no writes once the document is saved, opened or new.
- **Never touches** `path`: autosave is not a save and does not clear `dirty`.
- **Cleared** after a successful Save, New or Open: remove the metadata first
  (and the `.ket` file after it), so an interrupted cleanup cannot resurrect a
  stale snapshot.
- **Recovery decision on launch**: read `autosave.json`; offer recovery when it
  is present, `dirty` is true and `savedAt` is newer than the last clean save
  (the file's mtime at `path`). With no `path` the snapshot always counts as
  newer. `shouldOfferRecovery(meta, lastCleanSave)` is pure.
- **Unknown original file**: a `path` that is missing, moved or unreadable has
  no mtime to compare, so the snapshot always wins — it is the only remaining
  copy of the work and offering recovery is safe, whereas silently dropping it
  is not. When the file is gone the prompt says so and Restore keeps the path,
  so the next Save recreates the file; an unreadable file keeps the same
  behaviour without the extra note.
- **Prompt**: in-app **Restore** / **Discard**.
  Restore loads the snapshot with `ketcher.setMolecule(text)`, re-attaches
  `path` when metadata has one and marks the document dirty so a Save persists
  it. Discard deletes the snapshot and leaves an empty editor.
- **Write/cleanup race**: `clearSnapshot()` advances a write generation, and a
  snapshot write that started earlier stops at its next commit step (and
  removes whatever it already wrote). Saving or leaving a document can
  therefore never be overwritten by an autosave that was already in flight.

### 5.5 Close guard

`getCurrentWindow().onCloseRequested()` is registered once the editor is
ready. The handler is a small state machine:

| Document state         | Handler behaviour                                               |
| ---------------------- | --------------------------------------------------------------- |
| clean                  | allow the close                                                 |
| dirty, no decision yet | `event.preventDefault()`, show in-app Save / Discard / Cancel   |
| dirty, **Cancel**      | do nothing — the window stays open                              |
| dirty, **Discard**     | delete the snapshot, then `window.destroy()`                    |
| dirty, **Save**        | run Save (Save As if `path` is `null`), then `window.destroy()` |

If Save As is cancelled, the close is aborted too. `window.destroy()` bypasses
`onCloseRequested`, so a successful Save cannot loop back into the dialog.

### 5.6 Modules and APIs

| Module                       | Responsibility                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/document.ts`            | state, titles and names, dirty transitions, save/export mapping, close-guard decisions                                                    |
| `src/autosave.ts`            | debounce/interval scheduling, write-generation counter, recovery decision (all pure)                                                      |
| `src/autosaveStore.ts`       | app-data paths, atomic snapshot write, read/clear, original-file `stat`, no-op outside Tauri                                              |
| `src/fileSaver.ts`           | Vite alias target for `file-saver`: `saveAs` delegates to the registered handler, browser download otherwise; direct text writer for Save |
| `src/saveRoute.ts`           | pure routing of a saved blob by extension and document state (§5.7.1)                                                                     |
| `src/recognizeErrors.ts`     | pure unwrapping/mapping of editor and recognition errors to dialog copy and title (section 7)                                             |
| `src/ui/Dialog.tsx`          | overlay, panel, title, action row                                                                                                         |
| `src/ui/Button.tsx`          | `primary`, `secondary`, `danger` button styles                                                                                            |
| `src/ui/DocumentDialogs.tsx` | recovery, close-guard / replace, export and error dialogs                                                                                 |
| `src/ui/editorButtons.ts`    | `Editor` `buttons` config: hides Ketcher's native Save As entry (§5.7)                                                                    |
| `src/ui/toolbarIcons.ts`     | transparent `imageLink` + mask-painted glyphs and the generated toolbar style (§5.7)                                                      |

Ketcher API used:

- `.ket` round-trip: `ketcher.getKet()` / `ketcher.setMolecule(str)`.
- Dirty signal: `ketcher.changeEvent` (`add` / `remove`).
- Export: `getMolfile(format)`, `getSmiles()`, `getInchi()`, and
  `generateImage(ket, { outputFormat: "svg" | "png" })` for image formats.
  `exportImage` is not used: it supports only SVG in Ketcher 3.18, while
  `generateImage` covers SVG and PNG through the same route.
- Import of non-`.ket` files: `ketcher.setMolecule` (Open prefers `.ket`;
  other formats go through the same Ketcher API).

Tauri API used:

- `appDataDir()` from `@tauri-apps/api/path` for the recovery directory.
- `readTextFile`, `writeTextFile`, `mkdir`, `rename`, `remove`, `stat` and
  `exists` from `@tauri-apps/plugin-fs`, under the filesystem scopes in
  section 5.6.1.
- `save` / `open` from `@tauri-apps/plugin-dialog`.
- Ketcher's remaining library saves (image export and any internal save) go
  through the `file-saver` alias (§5.7): a `.ket` blob writes the document
  directly once it has a path, and every other blob goes to the export dialog
  (§5.7.1).
- `getCurrentWindow()` from `@tauri-apps/api/window`: `setTitle()`,
  `onCloseRequested()` and `destroy()`.

#### 5.6.1 Filesystem scope

`src-tauri/capabilities/default.json` is the single source of truth for what the
webview may touch; the Rust host adds no scope at runtime. Tauri matches a
`fs:scope` entry against **absolute paths or a `$VAR` root**, so a bare `**`
matches nothing useful and leaves absolute app and user paths forbidden.

| Entry          | Grants                                                                                    | Why                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `$APPDATA/**`  | `<appDataDir>/**` — Linux `~/.local/share/<identifier>`, Windows `%APPDATA%\<identifier>` | Autosave writes `<appDataDir>/recovery/autosave.ket` and `.json` with no dialog, so it can never be granted at runtime                     |
| `$HOME/**`     | the user's home directory, recursively                                                    | A document opened in an earlier session, or restored from a snapshot, is saved again without a dialog, so its path is never dialog-granted |
| runtime grants | one picked file or directory                                                              | `plugin-dialog`'s `open` / `save` commands call `allow_file` / `allow_directory` on the fs scope, granting that path for the session       |

`$APPDATA` resolves to Tauri's `app_data_dir()`, i.e. `data_dir()/<identifier>` —
exactly the recovery root. Files picked through a dialog are added to the scope
at runtime, but autosave paths and snapshot-restored document paths never are,
which is why both static entries are required.

`$HOME/**` is a deliberate trade-off for a document editor that reopens files
without a dialog: the webview only loads local app code, and paths outside
`$HOME` stay reachable only when the user picks them through a dialog. Scope
entries grant no command on their own; the fs commands (`readTextFile`,
`writeTextFile`, `mkdir`, `rename`, `remove`, `stat`, `exists`, plus the
non-text variants) stay listed explicitly in the same capability file.

**Browser fallback** (`pnpm dev` without Tauri): no autosave, no recovery
prompt and no close guard. Save and Export fall back to a download, following
`src/fileSaver.ts`; the document keeps `path === null` because a browser
download has no writable path.

### 5.7 Toolbar integration

The document commands live in **Ketcher's own top toolbar**. The app renders no
toolbar, dock or floating control group of its own; it adds no toolbar chrome
over the canvas.

**Custom buttons.** `Editor` accepts
`customButtons: Array<{ id: string; imageLink: string; title: string }>`
(`ketcher-react` `CustomButtons.d.ts`). The app registers three:

| `id`                    | `title` | Action                                                                   |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `chemistry-draw:save`   | Save    | Save the document (§5.2); Save As when `path` is `null`                  |
| `chemistry-draw:new`    | New     | replace the document under the dirty guard (§5.3) and clear the snapshot |
| `chemistry-draw:export` | Export  | open the in-app format dialog; never changes `path` or `format`          |

A click calls `ketcher.sendCustomAction(id)`, which emits
`CUSTOM_BUTTON_PRESSED` with the id on `ketcher.eventBus`; `App.tsx` subscribes
once the editor is ready and dispatches by id. `title` (also the tooltip) is the
sentence-case command name.

Icons are transparent `imageLink` data URIs whose glyph is painted by a CSS
`mask-image` with `background-color: currentColor`, keyed by the `alt` text
Ketcher derives from the title (`img[alt="Save"]`, `img[alt="New"]`,
`img[alt="Export"]`, scoped to `.Ketcher-root`) and generated once in
`src/ui/toolbarIcons.ts`. Because an `<img>` cannot inherit `currentColor`, the
mask is what lets each glyph take the button colour: `#333333` by default,
`#167782` on hover and the active-state colour on press, at Ketcher's native
28/32/40 px button metrics with the icon filling the content box. Ketcher's
source is untouched and no DOM query selects the buttons (`docs/conventions.md`
§6.5.1).

**Native Save As is hidden.** Ketcher's top-toolbar entry is
`save: { title: "Save As…", shortcut: "Mod+s", action: { dialog: "save" } }`,
and that dialog defaults to `format: "mol"`. Molfile is an export format, not a
document format, so Save never goes through it: `.ket` defaulting comes from our
own Save action and its Save As dialog. The app owns Save, New and Export, so the
native entry is removed from the UI through the `Editor` `buttons` prop supplied
by `src/ui/editorButtons.ts`:
`buttons: { save: { hidden: true } }`. Ketcher's built-in **Recognize** entry
stays visible so the ONNX/OCSR flow is reachable; its unused Imago version
selector is hidden by `src/overrides.css` (§7).

Ketcher's `isHidden(options, name)` reads `options.buttons[name]?.hidden`
(`ketcher-react` `dist/index.js`), the top toolbar derives `hiddenButtons` from
that config and `FileControls` drops Save when `hiddenButtons` contains
`"save"`. Ketcher's `ButtonName` union does not list `save`, so the object is
cast to `ButtonsConfig`; that cast is the documented workaround and the runtime
lookup still matches the key. The hiding is configuration only: no CSS
`display: none`, no DOM query and no Ketcher source edit.

Consequences:

- The native Save As entry disappears from the toolbar; **Export is the only
  format route** — Molfile V2000/V3000, SMILES, InChI, SVG and PNG through the
  in-app dialog cover every format the native dialog used to offer.
- Any remaining library save still goes through the `file-saver` alias, so
  nothing bypasses the Tauri writer; the native save dialog and its image-save
  entry are hidden, so Ketcher's own image saver is no longer reachable.
- `Ctrl/Cmd+S` runs the app Save; Ketcher's `Mod+S` stays intercepted in the
  capture phase, so hiding the button leaves no keyboard-only path to the native
  dialog.

This reverses the earlier "keep native Save As" decision (§5.7, activity 2).

**`file-saver` alias.** Ketcher saves through its bundled `file-saver`
(`saveAs` for text and image blobs). `vite.config.ts` maps `file-saver` to
`src/fileSaver.ts` through `resolve.alias`; no file under `node_modules/` is
modified. The shim exposes `saveAs` and delegates to a handler the app
registers; without Tauri or without a registered handler it downloads in the
browser. Every remaining library save therefore writes through the Tauri
filesystem instead of a browser download.

#### 5.7.1 Routing rule for the aliased saver

`saveRoute` is a pure helper: given the suggested filename and the current
`DocumentState` it returns where the blob goes. The extension is
case-insensitive.

| Blob                                                              | Route                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| extension `.ket`                                                  | **document save**: write to `path`; when `path` is `null`, open the Save As dialog (default `untitled.ket`); clear `dirty` and the recovery snapshot |
| any other extension (`.mol`, `.smi`, `.inchi`, `.svg`, `.png`, …) | **export save**: Tauri Save dialog defaulting to the supplied name; `path` and `format` stay unchanged                                               |
| no Tauri, or no registered handler                                | **browser download**: no dialog and no writable path                                                                                                 |

The aliased saver routes image blobs (`.svg`, `.png`) the export way, so they
never touch the document.

**Shortcut map.**

| Keys           | Command                                                         |
| -------------- | --------------------------------------------------------------- |
| `Ctrl+S`       | app Save; capture-phase listener stops Ketcher's `Mod+S` dialog |
| `Ctrl+Shift+S` | app Save As                                                     |
| `Ctrl+O`       | Open                                                            |
| `Ctrl+N`       | New                                                             |
| `Mod+S`        | intercepted; opens nothing                                      |

Ketcher still binds `Mod+S` internally for its (now hidden) Save As entry.
Ketcher binds its hotkeys on the editor container in the bubble phase
(`initKeydownListener` in `ketcher-react/dist/index.js`), so the app registers
its own listener on `window` with `capture: true`, calls `preventDefault()`
**and** `stopPropagation()` for the document shortcuts, and Ketcher never sees
the event. `preventDefault()` alone is not enough: Ketcher does not check
`defaultPrevented`. A matched combination is swallowed even while a dialog is
open or a save is running, so a repeated shortcut cannot fall through to
Ketcher; only the command is skipped then. The hidden **Save As…** entry leaves
no mouse or keyboard route to the native dialog.

---

## 6. Sidecar API surface

| Method | Path                                                                | Backend                               |
| ------ | ------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/v2/info`                                                          | versions + `api_path` (real port)     |
| GET    | `/v2/health`                                                        | diagnostics for bug reports           |
| GET    | `/v2/indigo/info`                                                   | alias of `/v2/info`                   |
| POST   | `/v2/indigo/convert`, `aromatize`, `dearomatize`, `layout`, `clean` | Indigo                                |
| POST   | `/v2/indigo/render`                                                 | Indigo Renderer                       |
| POST   | `/v2/indigo/calculate`, `check`, `calculate_cip`, `automap`         | Indigo                                |
| POST   | `/v2/filter/classify`                                               | ONNX Runtime classifier               |
| POST   | `/v2/ocsr/recognize`                                                | ONNX Runtime OCSR (encoder + decoder) |
| POST   | `/v2/imago/uploads`                                                 | compatibility shim (filter + OCSR)    |
| GET    | `/v2/imago/uploads/{id}`                                            | in-memory recognition job store       |

Errors are `AppError` → `{ "error": "..." }`: 400 invalid input (including an
undecodable or unsupported image), 404 unknown id (including an unknown,
expired or restarted recognition job), 413 payload over the 10 MiB cap, 422
incomplete OCSR decoding (the decoder did not finish the structure), 500
backend failure, 503 model unavailable (missing, checksum mismatch or contract
mismatch). The `413` is the exception to the JSON shape: it comes from axum's
`DefaultBodyLimit`, whose body is plain text, not `{ "error": ... }`.
`/v2/info` exposes Indigo versions plus the synthetic `imago_versions`
capability list (the rest of its payload is unchanged); `/v2/health` adds the
targeted ONNX Runtime API generation and
the model ids whose artifacts are present on disk. The `/v2/imago/uploads`
pair is a compatibility shim for Ketcher's built-in job protocol, not an Imago
backend: the implementation is the local filter → OCSR → Indigo pipeline, no
Imago library or worker ships, and `/v2/health` exposes no Imago fields. The
only Imago-looking field is the synthetic capability list, which Ketcher needs
to enable its Recognize control.

---

## 7. ONNX inference foundation

Phase B replaces Imago with a two-model pipeline: a **filter** (does the image
contain a chemical structure?) and an **OCSR** model (image → SMILES). B1
delivers the runtime foundation, the filter and the shipped ONNX Runtime. B2
adds OCSR inference: one hand-drawn model, a separate preprocessing pipeline
and `POST /v2/ocsr/recognize`. Activity 9 (`phase-b2-recognize-e2e`) adds the
implemented filter gate, the Ketcher-compatible job adapter and the re-enabled
Recognize UI on top of it; model download (B3) stays out of scope.

### Runtime

- Rust binding: `ort` **2.0.0-rc.15** (pykeio), pinned, built with
  `default-features = false` and features `std`, `api-31`, `load-dynamic`.
- `libonnxruntime` is **loaded dynamically at runtime**: the sidecar has no
  link-time dependency on it. The path comes from `ORT_DYLIB_PATH`; when unset,
  the bare platform name (`libonnxruntime.so` / `onnxruntime.dll`) is passed to
  the loader, so `LD_LIBRARY_PATH` / `PATH` applies. Activity 7
  (`ship-onnx-runtime`) also **ships** the pinned library with Linux and Windows
  packages (§8); a failed load stays an actionable error (HTTP 503), never a
  panic.
- Developer setup: `scripts/fetch-onnxruntime.sh` downloads the pinned ONNX
  Runtime **1.31.0** Linux x86_64 shared build, verifies its SHA-256 and
  extracts only `lib/libonnxruntime.so*` into the gitignored
  `.ort/linux-x86_64/`, preserving the `libonnxruntime.so` ->
  `libonnxruntime.so.1` -> `libonnxruntime.so.1.31.0` chain. It is idempotent,
  fails with a clear message on other platforms, and never downloads models.
  The pinned URL and checksum live in the script.
- Host resolution: `src-tauri/src/lib.rs` sets `ORT_DYLIB_PATH` on the sidecar
  and logs the resolved path. Debug prefers the `.ort/<platform>/` developer
  override and falls back to the bundled `lib/<platform>/`; release always uses
  the bundled library. If neither exists, the sidecar keeps serving Indigo and
  the classifier returns `503`.
- Execution provider: **CPU only**, one intra-op thread, telemetry disabled. No
  GPU providers.
- Sessions are created lazily on first use and cached for the process lifetime,
  so the sidecar starts — and keeps serving Indigo — with no models and no
  runtime installed.

### Model directory and manifest

Models are never bundled with the app and never committed. The contract
delivered by activity 5 (`model-root-resolution`) resolves the model root in
this order (first match wins):

1. `CHEMISTRY_MODELS_DIR` when set — absolute or relative, used as-is and never
   rewritten.
2. An existing `<repo>/models`, the compile-time candidate derived from the
   sidecar crate location (gitignored).
3. `models` in the sidecar's working directory.

In development the Tauri host passes `<repo>/models` as an **absolute**
`CHEMISTRY_MODELS_DIR` to the sidecar, so `task run` and `pnpm tauri dev` find
the model store without a manual export and the startup log names the absolute
root. Release delivery (the host providing a downloaded model root) remains
Phase B3 and is not implemented yet.

```text
models/
  manifest.json
  image-classifier-fp16/
    classifier.fp16.onnx
  ocsr-handdrawn-fp32/
    encoder.onnx
    decoder_step.onnx
    vocab.json
```

`manifest.json` is the source of truth for each model: artifact paths,
SHA-256 checksums, provenance id and the exact tensor contracts. Loading checks
each file checksum, then validates input/output names, shapes and dtype against
the graph. A missing file, checksum mismatch or contract mismatch is a
configuration error (HTTP 503), never a silent fallback.

The classifier entry keeps the single-artifact schema-1 shape below. The OCSR
entry is a second key in the same `models` map; it declares two graphs and a
vocabulary, so it is described separately in the OCSR subsection. Adding it
does not change the classifier entry or the schema version.

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

### OCSR inference contract (Phase B2)

> **Status:** activity 8 (`phase-b2-ocsr-inference`) delivered this contract.
> Activity 9 (`phase-b2-recognize-e2e`) consumes it from the filter-gated
> pipeline and the Ketcher `imago/uploads` adapter described below. The
> endpoint itself stays a single-image API and does not gate on confidence.

**Model choice.** Phase B2 pins **one** OCSR model and **no router**:
`ocsr-handdrawn-fp32`, provenance `ocsr-handdrawn@zenodo:10781330`. The DECIMER
v2 hand-drawn FP32 export is the single-model compromise for a drawing app:

| Evaluation set       | Hand-drawn FP32 (chosen) | Printed model |
| -------------------- | ------------------------ | ------------- |
| Hand-drawn canonical | **0.7300 (711/974)**     | 0.677         |
| Printed canonical    | 0.694                    | **0.704**     |

The hand-drawn model gives up only **1.0 pp** on printed images, while the
printed model loses **5.3 pp** on hand-drawn input. One model therefore serves
every filter-approved image; a per-style router or ensemble would add a second
failure mode without a measured win. CPU latency measured in the integration
report is p50 **1115 ms**, p95 **2156 ms**.

Artifacts are downloaded from
`spalax-dev/chemistry-draw-ocsr` into `models/ocsr-handdrawn-fp32/`, are
licensed **CC-BY-4.0** (Zenodo record 10781330, see `NOTICE`), and are never
bundled or committed. The encoder + decoder pair is 315,818,957 bytes
(~301 MiB):

| Artifact            | Bytes       | SHA-256                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `encoder.onnx`      | 208,801,677 | `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52` |
| `decoder_step.onnx` | 107,017,280 | `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197` |
| `vocab.json`        | 5,316       | `62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd` |

The vocabulary hash is not derived from the graph export: the manifest records
the SHA-256 of the downloaded `vocab.json`, so a corrupted, truncated or
substituted vocabulary is rejected exactly like a bad graph file.

**Manifest extension.** The OCSR model is a second key in the existing `models`
map. Schema 1 and the `image-classifier` entry are unchanged; the new entry uses
the same `file`/`artifact_sha256` spelling per artifact:

```json
"ocsr-handdrawn": {
  "id": "ocsr-handdrawn@zenodo:10781330",
  "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
  "license": "CC-BY-4.0",
  "preprocessing": "decimer_ocsr",
  "start_id": 13,
  "end_id": 14,
  "max_len": 302,
  "confidence_threshold": 0.901,
  "encoder": {
    "file": "ocsr-handdrawn-fp32/encoder.onnx",
    "artifact_sha256": "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
    "inputs": [
      { "name": "image", "dtype": "float32", "shape": [1, 512, 512, 3] }
    ],
    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 256, 512] }
  },
  "decoder": {
    "file": "ocsr-handdrawn-fp32/decoder_step.onnx",
    "artifact_sha256": "cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197",
    "inputs": [
      { "name": "tokens", "dtype": "int32", "shape": [1, -1] },
      { "name": "enc_out", "dtype": "float32", "shape": [1, 256, 512] }
    ],
    "zero_inputs": [],
    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, -1, 156] }
  },
  "vocab": {
    "file": "ocsr-handdrawn-fp32/vocab.json",
    "artifact_sha256": "62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd"
  }
}
```

`-1` marks a dynamic graph axis. For OCSR it is the decode-sequence axis of the
decoder (`tokens` axis 1 and `Identity:0` axis 1); batch may also be dynamic
`-1` as for the classifier. Every non-dynamic dimension must match exactly.
The hand-drawn export has **no additional graph inputs**: the `217602:0` and
`217606:0` names are baked initializers, so `zero_inputs` is `[]`. The printed
export is the one that exposes them as inputs. The loader still supports extra
graph inputs for other exports: every name in `zero_inputs` must be an input of
the graph, and each is fed an all-zero tensor with the dtype and shape the graph
declares. A graph input that is neither one of the declared inputs nor listed in
`zero_inputs` is a contract error (503), and the entry is not used.

Loading is per model family and lazy: the first `/v2/ocsr/recognize` request
verifies the three checksums, validates both graphs and creates the two
sessions; the pair is cached for the process lifetime. Startup, `/v2/health`
and `/v2/filter/classify` never open the OCSR graphs, so the ~316 MB pair does
not slow them.

**Tensor contract.** Encoder artifact
`ocsr-handdrawn-fp32/encoder.onnx`:

| Tensor       | Direction | dtype   | Shape              | Content                      |
| ------------ | --------- | ------- | ------------------ | ---------------------------- |
| `image`      | input     | float32 | `[1, 512, 512, 3]` | `decimer_ocsr` image, NHWC   |
| `Identity:0` | output    | float32 | `[1, 256, 512]`    | encoder features (`enc_out`) |

Decoder-step artifact `ocsr-handdrawn-fp32/decoder_step.onnx`:

| Tensor       | Direction | dtype   | Shape           | Content                             |
| ------------ | --------- | ------- | --------------- | ----------------------------------- |
| `tokens`     | input     | int32   | `[1, seq]`      | start id plus generated ids         |
| `enc_out`    | input     | float32 | `[1, 256, 512]` | encoder output, fed unchanged       |
| `Identity:0` | output    | float32 | `[1, seq, 156]` | next-token probabilities, softmaxed |

Other exports may expose additional auxiliary inputs; those are listed in
`zero_inputs` and fed zeros. The hand-drawn export stubs only the three tensors
above.

The decoder output is **already softmaxed**: values are probabilities, `argmax`
is taken directly, and softmax is never applied again. The vocabulary size is
156 (output axis 2).

**Greedy decode and tokenizer.** One encoder run produces `enc_out`; the
decoder then runs once per emitted token:

1. Seed the token sequence with `[start_id]`, `start_id = 13`.
2. Feed the full sequence as `tokens` int32 `[1, seq]` plus `enc_out` and the
   zero inputs.
3. Take the last position's `[156]` probability row, choose its `argmax` and
   append the id; the chosen value is that step's probability.
4. Stop after appending `end_id = 14`, or after at most `max_len = 302` decoding
   steps.
5. `incomplete` is `true` when the loop stopped at `max_len` and the last id is
   not `end_id`; otherwise it is `false`.

`confidence` is the arithmetic mean of the chosen-token probabilities over the
steps, including the final `end_id` step. `/v2/ocsr/recognize` does **not**
gate on it: a complete low-confidence decode is still a `200` with the value.
The in-domain hand-drawn threshold measured in the integration report is
**0.901** and the manifest records it as `confidence_threshold`. The
Recognize Molecule compatibility flow (below) enforces that gate, but the value
is provisional and must be recalibrated on real inputs before it is treated as
final.

Detokenization uses the two maps in `vocab.json`, `id_to_token` and
`token_to_id`. Ids `0` (pad), `13` (start) and `14` (end) are skipped; `end_id`
terminates the string. DECIMER's digit remap is applied **after** token lookup:
`! $ ^ < > ? £ ¢ € §` become `1 2 3 4 5 6 7 8 9 0`. The remap changes the SMILES
text only; it never changes token ids.

The loader also checks the vocabulary against the manifest before opening any
session: `vocab.start_id` and `vocab.end_id` must equal the manifest values, and
`vocab.vocab_size` must equal the decoder output's class axis (`156`). A
disagreement is a configuration error (`503`), not a decode-time surprise.

**Preprocessing (`decimer_ocsr`, must not drift).** This is a separate pipeline
from `runtime_default`; the classifier path is unchanged. It is a port of the
toolchain's `runtime/preprocess.py`, and the order is the contract:

1. Open the image as RGBA and composite it on white.
2. Contrast stretch: build a LUT mapping the current per-image minimum..maximum
   (across all channels) to `0..255`, then apply it.
3. BGR2GRAY quirk on the RGB array: `gray = 0.114*R + 0.587*G + 0.299*B` — the
   OpenCV BGR weights applied **without** swapping the channels. Clip to
   `0..255`, convert to mode `L`, then apply PIL `ImageEnhance.Contrast(1.8)`.
4. Resize rules, in this order: a square image with side `< 512` becomes
   `512×512`; if either side is `>= 512` it is not resized; otherwise both sides
   are scaled by `512 / max(w, h)` with `int()` truncation and LANCZOS.
5. Crop empty borders: pixels `> 200` are background; crop to the bounding box
   of pixels `<= 200`; if every pixel is background, keep the image unchanged.
6. Central square: `side = max(512, int(1.2 * max(w, h)))`, white canvas, paste
   centered. A canvas over `8,192` px per side is rejected as an extreme aspect
   ratio (`400`) before the allocation, so a pathological but under-cap image
   cannot balloon into a many-hundred-megabyte canvas.
7. Brightness ×1.6 (PIL `ImageEnhance.Brightness` semantics, clipped).
8. Resize to exactly `512×512` with LANCZOS, RGB, float32.
9. Convert to `0..1`, normalize per channel with ImageNet mean
   `[0.485, 0.456, 0.406]` and std `[0.229, 0.224, 0.225]`, and emit NHWC
   float32 `[1, 512, 512, 3]`.

Decoding is bounded by the same `12,000 px` per side and `128 MiB` of decoder
allocations as the classifier; over-limit input is `400`. The central canvas is
additionally capped at `8,192 px` per side after the border crop (an extreme
aspect ratio is `400`), so the intermediate allocation stays bounded. As with
`runtime_default`, any change to this pipeline requires a measured delta on the
frozen evaluation.

**Endpoint.** `POST /v2/ocsr/recognize`

- Body: raw image bytes with `Content-Type: image/png`, `image/jpeg` or
  `image/webp`. No multipart, no base64, no job id.
- Limit: 10 MiB (10,485,760 bytes), inclusive. Larger bodies get `413` from
  axum's `DefaultBodyLimit`; that body is plain text, not `{ "error": ... }`.
- The handler validates the media type and decodes the image **before**
  resolving the model, so malformed input is `400` even without a model; a
  well-formed image without a usable model is `503`.
- `200` response:

```json
{
  "smiles": "CCO",
  "confidence": 0.93,
  "incomplete": false,
  "model": "ocsr-handdrawn@zenodo:10781330"
}
```

`smiles` is the detokenized, digit-remapped string; `confidence` is the mean
chosen-token probability; `incomplete` is `false` on success; `model` is the
manifest provenance id.

- `422` when decoding is incomplete (`incomplete: true`): the image decoded and
  the model ran, but the decoder reached `max_len = 302` without `end_id`. The
  body is the standard error envelope with an actionable message:

```json
{ "error": "could not finish the structure; try a sharper image" }
```

A truncated SMILES is **not** returned: an unfinished structure is not a
result. `AppError::Unprocessable` maps this variant to `422`.

- Errors: `400` undecodable or unsupported image (including over-limit
  dimensions or decoder allocations), `413` payload over 10 MiB, `422`
  incomplete decode, `500` unexpected inference failure, `503` model or runtime
  unavailable (missing, checksum mismatch or contract mismatch).

This endpoint is stateless and returns the SMILES with its confidence. The
confidence gate, the filter and the molfile conversion belong to the
compatibility flow below; `/v2/ocsr/recognize` itself keeps returning `200` for
a complete low-confidence decode.

### Recognize Molecule compatibility flow (Phase B2)

> **Status:** implemented by activity 9 (`phase-b2-recognize-e2e`). This
> subsection describes the shipped contract and the tests that pin it.

**Why a shim.** Ketcher 3.18 hardcodes the Imago job protocol in
`RemoteStructService.recognize()`: `POST {apiPath}imago/uploads` with the image
blob, then `GET {apiPath}imago/uploads/:id` every 500 ms after a 300 ms
delay. The route name is Ketcher's, not ours. The sidecar implements the
protocol as a **compatibility shim** — same paths, same states, same
`metadata.mol_str` — backed by the local filter, OCSR and Indigo. No Imago library, worker, job format or native
dependency is involved, and the version query is accepted and ignored because
one local OCSR model serves every request. Patching Ketcher to call a new path
would be a second permanent fork; the shim keeps the Ketcher boundary at the
existing `parametrizeUrl` patch only.

**Ketcher protocol.**

1. `POST {apiPath}imago/uploads[?version=<v>]` with the raw image as the body
   and the blob's `Content-Type` (`application/octet-stream` is Ketcher's
   fallback). The shim accepts `image/png`, `image/jpeg` and `image/webp`; any
   other media type is `400`, and a body over 10 MiB (10,485,760 bytes) is
   `413` from axum's `DefaultBodyLimit` (plain text, not `{ "error": ... }`).
   The `version` query is ignored.
2. `200 { "upload_id": "<id>" }` — Ketcher reads `upload_id` from the body.
3. Ketcher waits **300 ms** before the first poll, then polls
   `GET {apiPath}imago/uploads/<id>` every **500 ms** until the job leaves
   `PENDING`; there is no fixed attempt limit. The bound on a stuck job is the
   sidecar's, not the client's (see the job store below).
4. `{ "state": "PENDING" }` keeps polling.
5. `{ "state": "SUCCESS", "metadata": { "mol_str": "<V2000 molfile>" } }` ends
   the poll; Ketcher parses `mol_str` and adds the structure to the canvas.
6. `{ "state": "FAILURE", "error": "<message>" }` ends the poll. Ketcher throws
   `new Error(JSON.stringify(response))`, so the whole JSON reaches the editor
   error handler; the UI owns the friendly copy.
7. An unknown, expired or restarted job id is `404 { "error": ... }`; Ketcher
   rejects with that message, which the UI also maps.

POST does not decode the image: the body is stored and a worker runs
`spawn_blocking` (ONNX Runtime and Indigo are synchronous) so the async runtime
keeps serving Indigo. Decode failures, including the 12,000 px / 128 MiB bounds
and the `8,192` px central canvas, are therefore FAILURE states, not `400`.
Only the media type and the 10 MiB cap are validated at POST time.

**Pipeline.** One job runs, in order:

1. **Filter gate.** `contains_molecule` from the classifier. `false` fails the
   job with `No molecule was detected in this image.` This is the binary
   classifier from B1: it cannot count molecules or detect reactions, and 146
   of 250 multi-molecule images (~58%) were `no-structure` in the frozen
   evaluation. `no-structure` is not proof that no structure exists, so the
   copy does not tell the user they drew nothing.
2. **OCSR.** The same encoder/decoder pair as `/v2/ocsr/recognize`. An
   `incomplete` decode or `confidence < confidence_threshold` (manifest value
   `0.901`, provisional) fails the job with the message
   `The structure could not be read confidently. Try a sharper or larger image.`
   A truncated SMILES is never converted: an unfinished structure is an error,
   exactly as in activity 8. Unlike the single-image endpoint, the shim **does**
   gate on confidence. The threshold is the in-domain hand-drawn value measured
   in the integration report; it has not been calibrated on real Chemistry Draw
   inputs. Changing it requires a measured delta, a manifest update and a docs
   update, following the classifier-threshold rule in `docs/conventions.md` §10.
3. **SMILES → molfile.** The SMILES goes through the same
   `indigo_ops::convert` as `/v2/indigo/convert`, with
   `chemical/x-mdl-molfile` (V2000) as the output format. Convert lays the
   structure out before writing, so the molfile carries usable 2D coordinates.
   A conversion failure (empty or rejected SMILES, Indigo error) fails the job
   with the message
   `The recognized structure could not be prepared for the editor. Try again.`
4. **SUCCESS.** `{ "state": "SUCCESS", "metadata": { "mol_str": "<molfile>" } }`.

**Failure states.** The `FAILURE` body is always
`{ "state": "FAILURE", "error": "<message>" }` with HTTP `200`; only an
unknown, expired or restarted job id is `404`.

| Condition                                             | FAILURE `error`                                                               | `ErrorDialog` copy                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| filter returns `no-structure`                         | `No molecule was detected in this image.`                                     | No chemical structure was detected in this image. Try a clear image of one drawn molecule, or draw the structure in the editor.                   |
| `incomplete` or low confidence                        | `The structure could not be read confidently. Try a sharper or larger image.` | The structure could not be read confidently. Try a sharper or larger image of one molecule.                                                       |
| undecodable / unsupported / over-dimension image      | `Unsupported image. Use a PNG, JPEG or WebP file.`                            | This image cannot be used. Choose a PNG, JPEG or WebP file.                                                                                       |
| model missing, checksum/contract mismatch, no runtime | `Recognition models are not available. Check the model setup.`                | Molecule recognition is not set up. Check that the image-classifier and OCSR models are installed (see CHEMISTRY_MODELS_DIR) and restart the app. |
| SMILES → molfile failure                              | `The recognized structure could not be prepared for the editor. Try again.`   | The structure was recognized but could not be prepared for the editor. Please try again.                                                          |
| still `PENDING` after the TTL                         | `Recognition timed out. Try again.`                                           | Recognition took too long. Please try again.                                                                                                      |
| unknown, expired or restarted job id (`404`)          | `unknown recognition job`                                                     | The recognition result expired before it reached the editor. Please try again.                                                                    |

A POST with an unsupported `Content-Type` is `400` and maps to the unsupported
image copy. An over-cap POST is the documented **plain-text exception**: axum's
`DefaultBodyLimit` answers `413` with `Failed to buffer the request body`, not
`{ "error": ... }`. Ketcher parses every response with `response.json()`, so the
plain text makes that call throw a JSON syntax error (`Unexpected token`); the UI
maps it to "The server could not process the image. It may be too large."

**In-app dialog, never a native alert.** Every recognition failure above — the
no-molecule, low-confidence, model-unavailable, conversion, unsupported, timeout
and `404` cases, including a JSON body without a usable `error`/`message` —
renders in the Ketcher-styled in-app `ErrorDialog` (`src/ui/DocumentDialogs.tsx`
over `src/ui/Dialog.tsx`): title **Structure problem**, the friendly copy from
the table, a single **Close** button, and Ketcher's dimmed hatch backdrop above
the still-mounted editor. It is a webview component, not an OS window: the
Recognize path never calls the Tauri `message()` dialog and never falls back to
browser `alert()`. A failure with no mapped copy and no JSON body keeps the
generic **Error** title. Native dialogs remain only for file pickers: Tauri
`open` / `save` for Open, Save As and Export destinations.

The unwrapping and mapping live in `src/recognizeErrors.ts`, a pure module
covered by Vitest (`docs/testing.md` section 6.1): `unwrapError` strips
Ketcher's `Error:` wrapper and extracts the inner `error`/`message` from a
stringified `FAILURE` body, `friendly` maps the documented substrings to the
copy above, and the title selection picks `Structure problem` for a mapped copy
or any JSON body and `Error` for anything else. Raw JSON is never shown: an
unrecognized JSON body gets the generic `Recognition failed. Please try again.`
copy, and an unrecognized non-JSON failure is shown as the plain error under
`Error`.

`describeError` is only for the editor's `errorHandler`. The document workflow
(Save, Save As, Open, New, Export, recovery, reset and close) uses
`errorMessage(error)`, which returns an `Error`'s message or `String(value)`:
prefixing a document error with `describeError(...).message` would let a
document message that happens to contain a recognition hint (for example a path
or a server message with `Load failed`) be rewritten into unrelated structure
copy. Document failures keep their own text under the `Error` title.

**Job store and TTL.** The store is in-memory and per-process: an opaque id maps
to one job (`PENDING`, `SUCCESS` or `FAILURE`), the uploaded bytes and
timestamps. A sidecar restart drops every job, so a later poll is `404`. Two
independent bounds apply:

- **Worker bound: 120 s.** A pipeline still running after 120 seconds is
  abandoned and its job resolves as `FAILURE` with the timeout message. This is
  a bound on processing, not a fixed delay; it is generous because the first
  recognition loads the ~316 MB OCSR pair from disk.
- **Store TTL: 10 minutes (600 s).** A job still `PENDING` after 10 minutes
  (for example a lost worker) resolves as `FAILURE` with the timeout message on
  its next poll. A resolved job is discarded 10 minutes after it resolved, so a
  poll after that is `404` (the timeout `FAILURE` is reachable for 10 minutes).
  The uploaded bytes are dropped as soon as the job resolves.

Both the upload and the poll handler call `purge` before answering, so expired
entries leave the map instead of accumulating for the process lifetime; there is
no background reaper. The store is deliberately not persisted and exposes no
listing: it exists only to bridge Ketcher's asynchronous protocol to a
synchronous pipeline.

**UI re-enabled.** `App.tsx` no longer passes
`buttons={{ recognize: { hidden: true } }}`. The control is enabled by the
sidecar's synthetic `imago_versions` list, not by a local option: Ketcher
recomputes the button's `disabled` state from `app.imagoVersions` after
`GET /v2/info` and keeps the control disabled when the list is empty.

Ketcher's built-in dialog still renders an "Imago version" selector, so
`src/overrides.css` (imported by `App.tsx` after the Ketcher stylesheet) hides
the label with `label[class*="imagoVersion"] { display: none !important; }`.
The selector is meaningless here: Chemistry Draw serves one local OCSR model,
so there is no version choice; the label and the optional `?version=` query are
Ketcher protocol artifacts, not an Imago dependency. Ketcher defaults the value
to `imagoVersions[1]`, which is `undefined` for the single synthetic entry, so
it omits `?version=` entirely; when a version is present the shim accepts and
ignores it. Ketcher's built-in "Import Structure from Image" dialog uploads,
polls and inserts; no custom React upload UI is added. `handleError` renders the
failure mapping above in the in-app `ErrorDialog`, with a generic fallback for
unknown JSON.

**Stale recognition results.** Ketcher turns every `recognize` promise into a
dialog `setStruct` dispatch, so changing the image while the previous job is
still running can let the older result overwrite the new preview (or clear it
with an old error). `App.tsx` therefore uses `StaleSafeStructServiceProvider`,
a thin subclass of `RemoteStructServiceProvider`: each `recognize` call takes a
monotonic token, and only the latest token may resolve or reject. Older
resolutions and rejections return a never-settling promise, so the stale
Ketcher thunk never dispatches; the other struct-service methods are untouched.
Ketcher's `StructRender` additionally caches the rendered SVG by the molfile
title line, and the sidecar writes an empty title for every structure, so the
wrapper rewrites the latest result's title (`Recognized structure <token>`) to
keep the cache key distinct. The title is cosmetic: atoms and bonds are
untouched, and the editor loads the same molecule. This is app-level code, not
a Ketcher patch.

**Input and bounds.** Raw PNG/JPEG/WebP only, 10 MiB inclusive (10,485,760
bytes), no multipart and no base64. The classifier's `12,000 px` per side and
`128 MiB` decoder bounds and the OCSR `8,192 px` central-canvas bound still
apply inside the worker; they fail the job as an unsupported image.

### Health and module map

`/v2/health` adds `onnxruntime_version` and `models` to the existing
diagnostics. `onnxruntime_version` names the ONNX Runtime **API generation**
`ort` targets (for example `onnxruntime api 1.31.x (ort 2.0.0-rc.15)`), not the
loaded binary's exact patch version. `models` lists only ids declared by the
manifest **whose required artifact files exist on disk** (a cheap existence
check, no checksum, no session): the classifier's single file and the OCSR
model's encoder, decoder and vocab. With both installed it reports
`image-classifier@Iagea/d21f4cb` and `ocsr-handdrawn@zenodo:10781330`; an OCSR
model with only some of its files present is not listed. Health never opens an
OCSR session.
`/v2/info` adds the synthetic `imago_versions` capability list; the rest of the
payload (`Indigo`, `indigo_version`, `api_path`) is unchanged. Ketcher parses
the capability and needs no inference metadata.

```text
sidecar/src/
  transport/filter.rs     POST /v2/filter/classify
  transport/ocsr.rs       POST /v2/ocsr/recognize
  transport/imago.rs      POST /v2/imago/uploads, GET /v2/imago/uploads/{id}
  service/recognition.rs  filter → OCSR → molfile pipeline and failure mapping
  service/jobs.rs         in-memory recognition job store and TTL
  service/ml/
    mod.rs                shared cache and entry points
    runtime.rs            dynamically loaded ONNX Runtime environment and sessions
    registry.rs           manifest, checksums and contract validation (both models)
    paths.rs              model-root precedence (explicit, repo, cwd)
    preprocess.rs         runtime_default image → NHWC tensor (bounded decode)
    ocsr_preprocess.rs    decimer_ocsr image → normalized NHWC tensor
    ocsr_vocab.rs         vocab.json, detokenization and digit remap
    ocsr_decode.rs        greedy encoder/decoder loop and stop/incomplete rules
    ocsr.rs               encoder/decoder sessions and prediction post-processing
    classifier.rs         three-input run, sigmoid, threshold
```

The OCSR modules are the layout delivered by activity 8; the compatibility
modules are the layout delivered by activity 9.

---

## 8. Native libraries

Indigo, Indigo Renderer and ONNX Runtime are **not vendored in git**.

- **Linux**: built or fetched in the Docker builder and copied by `task libs`
  into `src-tauri/lib/linux-x86_64/` (gitignored). The same directory is what
  packaging ships. The **bundled set** is Indigo, Indigo Renderer, their
  non-platform dependencies and the pinned ONNX Runtime **1.31.0** chain.
  `libstdc++` and `libgcc_s` are **never** shipped: the target distro runtime is
  used. The real support floor is **glibc 2.36** (`arc4random@GLIBC_2.36` in
  `libindigo.so`): Debian 12+, Ubuntu 24.04+, current Fedora.
- **Host-provided**: `libfontconfig`, `libfreetype`, `libexpat`, `libpng` and
  `libbrotli` are **not** bundled, and neither are `libc`, `libm`, `libz` or the
  GL/X11/xcb family. The sidecar loads them from the distro through the normal
  loader path, and `ldd` on the bundled libraries shows the system paths. The
  reason is version mixing: the Debian 12 builder ships fontconfig **2.14**,
  whose parser rejects the newer `/etc/fonts` syntax of current distros (e.g.
  Fedora 45 with fontconfig **2.18**), so every PNG render logged about 45
  `Fontconfig warning` lines. The host libraries render the same output with
  **zero** warnings, and the support floor below already implies a
  fontconfig/freetype/expat/png family new enough for its own config.
- **Packaging implication**: `.deb`/`.rpm` ship only the bundled set and use the
  distribution's fontconfig/freetype/png libraries. GTK, already in the
  Tauri/WebKit dependency closure, pulls fontconfig and freetype, so the
  packages add no explicit runtime dependency for them. The custom AppImage
  likewise contains only our libraries and resolves the platform libraries from
  the host.
- **Windows**: `scripts/fetch-windows-libs.ps1` downloads the pinned EPAM
  Indigo **1.46.0** x86_64 archive, verifies its SHA-256, extracts
  `indigo.dll`, `indigo-renderer.dll`, `msvcp140.dll`, `vcruntime140.dll` and
  `vcruntime140_1.dll` into `src-tauri/lib/windows-x86_64/` (gitignored) and
  generates the MSVC import libraries `indigo.lib` / `indigo-renderer.lib`
  from the `indigo*` C exports.

Activity 7 (`ship-onnx-runtime`) adds the pinned ONNX Runtime **1.31.0** to
that shipped set on both platforms; both downloads are SHA-256 verified:

| Platform | Pinned archive                     | SHA-256                                                            | Payload                                           |
| -------- | ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Linux    | `onnxruntime-linux-x64-1.31.0.tgz` | `cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57` | `lib/libonnxruntime.so*` (real file 29,345,384 B) |
| Windows  | `onnxruntime-win-x64-1.31.0.zip`   | `3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195` | `onnxruntime.dll` (17,253,176 B)                  |

Both archives are the official 1.31.0 release assets:
[Linux x64](https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz)
and
[Windows x64](https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-win-x64-1.31.0.zip).

- Linux: `scripts/build-libs.sh` downloads, verifies and extracts
  `libonnxruntime.so*` into the builder output, so `/opt/chemistry/libs` holds
  the chain `libonnxruntime.so` -> `libonnxruntime.so.1` ->
  `libonnxruntime.so.1.31.0` (one real file). `task libs` and the packaging
  scripts copy it with `cp -a`, preserving the symlinks instead of shipping
  three copies. Tauri's resource copier dereferences symlinks, so
  `scripts/repack-native-payload.sh` restores the chain inside the `.deb` and
  `.rpm` payloads; the AppImage AppDir is assembled with `cp -a` directly.
- Windows: `scripts/fetch-windows-libs.ps1` downloads, verifies and extracts
  `onnxruntime.dll` next to the Indigo DLLs.

The runtime is still **loaded dynamically** through `ORT_DYLIB_PATH`: the
sidecar has no link-time dependency, `ldd` shows no `libonnxruntime`, and no
`OrtGetApiBase` symbol appears in the binary. Host precedence is
`.ort/<platform>/` (debug developer override, fetched by
`scripts/fetch-onnxruntime.sh`) over the bundled `lib/<platform>/`; release uses
the bundled copy only. Missing both leaves Indigo working and makes the
classifier answer `503`.

ONNX Runtime 1.31 needs **glibc 2.28** and **GLIBCXX 3.4.22**, below the Debian
12 builder (glibc 2.36, GLIBCXX 3.4.30), so the application floor stays
**glibc 2.36**. Model weights remain **not bundled**: no `.onnx` file or
`manifest.json` is shipped in any artifact; model download is Phase B3.

---

## 9. Packaging

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

The Linux payloads bundle the builder's `lib/linux-x86_64/` as a Tauri
resource: exactly one real `libonnxruntime.so.1.31.0` plus the
`libonnxruntime.so.1` and `libonnxruntime.so` symlinks, and no model files.
`check-native-libs.sh --allowlist /opt/chemistry/libs` runs before bundling and
rejects any file the builder image did not provide.

Windows: `pnpm tauri build --bundles nsis` produces an NSIS installer under
`target/release/bundle/nsis/`. It bundles `indigo-server.exe` plus the five
Indigo/MSVC DLLs and `onnxruntime.dll` under `lib/windows-x86_64/`; `externalBin`
lists only `indigo-server`.

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

## 10. Observability

- Rust host + frontend + sidecar output go to a rotating file via
  `tauri-plugin-log` (stdout + app log dir, 2 MB × 5 files).
- The sidecar's stdout/stderr is forwarded line by line with ANSI stripped.
- `GET /v2/health` exposes uptime, PID, port, the Indigo version, the targeted
  ONNX Runtime API generation and the model ids whose artifacts are on disk. It
  is for support, not for Ketcher.
- Panics are logged with location.

---

## 11. Temporary workarounds

`ketcher-core` 3.18.0 has a bug in `parametrizeUrl` that turns the port in
`127.0.0.1:9321` into a placeholder. We ship `patches/ketcher-core@3.18.0.patch`
(registered in `pnpm-workspace.yaml`). Upstream fixed it in
[epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552) but has not
published a release with the fix yet. Removal procedure:
`docs/KETCHER-BUG-parametrizeUrl.md`.

The same patch file guards `ReBond` against a struct/render desync. When a bond
still references a half-bond that is no longer in `restruct.molecule.halfBonds`
(invalid-valence edits, undo of deletions), `ReBond.getSelectionPoints` dereferences
`undefined` (`halfBonds.get(bond.hb1).p`) and throws every frame, flooding the
console with uncaught render-loop errors. The patch mirrors
[epam/ketcher#11165](https://github.com/epam/ketcher/pull/11165) in both
`dist/application/render/restruct/rebond.js` and `rebond.modern.js`: a missing
half-bond returns an empty point list, `getSelectionContour` returns `null` for
that list, and `makeHoverPlate`, `makeSelectionPlate`, `makeHighlitePlate` and
`drawHover` no-op on `null`. The bond then simply renders without hover or
selection instead of crashing. The patch rules are in `docs/conventions.md` §12
and the manual check is in `docs/verification.md` §2.

---

## 12. Non-goals

- Online accounts, telemetry, or cloud sync.
- Shipping prebuilt binaries in git.
- Reimplementing Ketcher's editor UI.
- Supporting glibc < 2.36 or webkit2gtk < 4.1.
- Shipping Imago or OpenCV. B1 ships an ONNX classifier gate; B2 adds OCSR
  inference through the two-model pipeline plus the Ketcher-compatible job
  shim. No Imago code, worker or native library is shipped. The pinned ONNX
  Runtime 1.31.0 native library (loaded dynamically) is shared by both, but
  model weights are never bundled; downloading models is Phase B3.
