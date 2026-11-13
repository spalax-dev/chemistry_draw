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
| Editor            | `ketcher-react` / `ketcher-core` 3.18.x (patched, see §10)      |
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
| `src/ui/Dialog.tsx`          | overlay, panel, title, action row                                                                                                         |
| `src/ui/Button.tsx`          | `primary`, `secondary`, `danger` button styles                                                                                            |
| `src/ui/DocumentDialogs.tsx` | recovery, close-guard / replace, export and error dialogs                                                                                 |
| `src/ui/editorButtons.ts`    | `Editor` `buttons` config: hides Ketcher's native Save As and recognize entries (§5.7)                                                    |
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
  `exists` from `@tauri-apps/plugin-fs`; the `fs:scope` capability is already
  `**`.
- `save` / `open` from `@tauri-apps/plugin-dialog`.
- Ketcher's remaining library saves (image export and any internal save) go
  through the `file-saver` alias (§5.7): a `.ket` blob writes the document
  directly once it has a path, and every other blob goes to the export dialog
  (§5.7.1).
- `getCurrentWindow()` from `@tauri-apps/api/window`: `setTitle()`,
  `onCloseRequested()` and `destroy()`.

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
`buttons: { save: { hidden: true }, recognize: { hidden: true } }`.

Ketcher's `isHidden(options, name)` reads `options.buttons[name]?.hidden`
(`ketcher-react` `dist/index.js`), the top toolbar derives `hiddenButtons` from
that config and `FileControls` drops Save when `hiddenButtons` contains
`"save"`. Ketcher's `ButtonName` union does not list `save`, so the object is
cast to `ButtonsConfig`; that cast is the documented workaround and the runtime
lookup still matches the key. The hiding is configuration only: no CSS
`display: none`, no DOM query and no Ketcher source edit.
`recognize` is hidden for the same reason.

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

## 7. Native libraries

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
Indigo/MSVC DLLs under `lib/windows-x86_64/`; `imago-worker` is not in
`externalBin` and Imago is not packaged.

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
- `GET /v2/health` exposes uptime, PID, port, versions and whether
  `imago-worker` was found. It is for support, not for Ketcher.
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
- Shipping Imago/OpenCV or image recognition on Windows.
