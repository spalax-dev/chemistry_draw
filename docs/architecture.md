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
  `file-saver` resolves through the Vite alias described in §5.9.

---

## 5. Document tabs and file workflow

Chemistry Draw behaves like a tabbed word processor: **several documents per
window**, shown as tabs at the top of the window and backed by a **single
Ketcher instance**. A tab is file state (`path`, serialized `.ket`, dirty),
never a second editor, and `.ket` is the only format Save ever writes.

### 5.1 Tab state

```ts
interface TabState {
  id: string; // stable identifier, names the tab's snapshot files
  path: string | null; // user-chosen .ket file, null = never saved
  ket: string; // last committed .ket content, "" for an untouched tab
  dirty: boolean; // unsaved edits since the last save/open/new
}

interface TabSet {
  tabs: TabState[]; // left to right; never empty
  activeId: string; // the tab the single editor currently shows
}
```

- Tab ids come from a `tab-<n>` counter (`tab-1`, `tab-2`, …), stay
  filesystem-safe and name the tab's snapshot files.
- `src/tabs.ts` owns the pure model: create, close, activate, commit serialized
  content, dirty counting and the guard decisions (§5.6, §5.7).
- The tab title is the file's base name without the extension (`benzene`) or
  `Untitled` when `path` is `null`. Dirty tabs show a **dot**, never an
  asterisk in the strip. `tabTitle()` still returns the base name plus `*`
  while dirty: the strip removes it and paints the dot instead, while the
  window title and dialog copy use `tabTitle()` verbatim.
- An **untouched empty tab** has `path === null`, `dirty === false` and an empty
  structure (`ket` empty or a blank Ketcher document). Open reuses it (§5.4).
- `dirty` starts `false`, becomes `true` on the first editor change while that
  tab is active, and returns to `false` only after a successful Save, Open or
  New for that tab. An inactive tab cannot change: it has no editor.

### 5.2 One editor, switching protocol

Exactly one `<Editor>` is mounted for the window's lifetime; the strip only
changes what that editor shows. Switching is a fixed four-step sequence:

1. **Serialize the outgoing tab** — `ketcher.getKet()` is stored in the outgoing
   tab's `ket`.
2. **Flush the outgoing tab** — its snapshot is written (§5.5) before the editor
   changes, so the content survives a crash between the two actions.
3. **Set a `loading` flag**, then `ketcher.setMolecule(target.ket)` loads the
   incoming tab. An untouched tab loads an empty structure.
4. **Clear the flag** once the load settles.

- Change events emitted while `loading` is set are ignored, so a programmatic
  load never marks the incoming tab dirty.
- Switches are serialized by a `busyRef` guard in `App.tsx`: a switch that
  arrives while one is still running is ignored, so two loads never interleave.
  After every `await` the code re-checks the active id before applying state,
  and snapshot writes capture the tab id and the text at call time instead of
  reading the live editor again. `loadingRef` covers the programmatic load, and
  the active-id checks discard a flush whose tab changed meanwhile, so rapid
  switching cannot write one tab's content into another.
- The strip is the only app chrome above Ketcher; there is no per-tab toolbar,
  dock or second canvas (`docs/conventions.md` §6.6).

### 5.3 Save policy

All document commands act on the **active tab**.

- **Save** (`Ctrl+S`) writes the active tab's `ketcher.getKet()` as UTF-8 text
  to its `path`. With `path === null` it behaves as Save As defaulting to
  `untitled.ket`.
- **Save As** (`Ctrl+Shift+S`) asks for a destination through the Tauri `save`
  dialog filtered to `.ket`, appends the extension when missing, writes, and
  adopts the new path for the active tab. The previous file is left untouched.
- Save never writes another format and never changes another tab.
- Both commands are available from Ketcher's toolbar (§5.9) and the keyboard.

### 5.4 Save vs Save As vs Export

| Command | Shortcut       | Target        | Writes                                         | Changes the tab's `path`            |
| ------- | -------------- | ------------- | ---------------------------------------------- | ----------------------------------- |
| Save    | `Ctrl+S`       | active tab    | `.ket` to `path` (or Save As) + clean snapshot | on first save                       |
| Save As | `Ctrl+Shift+S` | active tab    | `.ket` to the chosen path + clean snapshot     | yes                                 |
| Export  | —              | active tab    | one other format to a file                     | **no**                              |
| New     | `Ctrl+N`       | a **new** tab | its clean snapshot                             | new tab starts at `null`            |
| Open    | `Ctrl+O`       | reused or new | the tab's snapshot                             | the `.ket` path, `null` for imports |

Export is the only route to another format. It writes a separate file and never
changes the active tab's path or any other tab.

**New** always opens a tab: a clean tab with `path === null` and an empty
structure. It never replaces, saves or discards the active tab, so it needs no
dirty prompt and never writes a user file; like every tab it gets a clean
recovery snapshot (§5.5), so the tab set restores.

**Open** reuses the active tab only when it is an untouched empty tab
(`path === null`, not dirty, empty structure); otherwise it opens a new tab.
Within the target tab it behaves differently per format:

- A `.ket` file becomes that tab's document: `path` is the chosen file and the
  tab is clean, so the title shows its base name without a dot.
- `.mol`, `.smi`, `.sdf`, `.rxn` and any other structure format are imported
  through `ketcher.setMolecule`; no `.ket` file backs them, so `path` stays
  `null` (`Untitled`) and the tab is marked dirty.

Open never prompts: a dirty tab is left open and untouched, and the file lands in
a new tab instead.

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

### 5.5 Autosave, per-tab snapshots and restore

Every tab owns a snapshot in the Tauri app data directory, never next to the
user's file:

```text
<appDataDir>/recovery/tabs/<id>.ket    working structure (.ket text)
<appDataDir>/recovery/tabs/<id>.json   { path, savedAt, dirty }
<appDataDir>/recovery/tabs/index.json  { order: id[], activeId }
```

- **Signal**: subscribe to `ketcher.changeEvent` (`Subscription.add` /
  `Subscription.remove`); the typed alternative is
  `ketcher.editor.subscribe("change", handler)`.
- **Scheduling**: only the **active** tab is scheduled — debounce about 2 s
  after the last change plus a slow interval (30 s) as a safety net. Both timers
  are pure inputs to `autosave.ts`; the interval only writes while the active tab
  is dirty.
- **Switch flush**: switching tabs (§5.2) writes the outgoing tab immediately
  instead of waiting for its debounce, then the incoming tab becomes the only
  one scheduled.
- **Writes**: `<id>.ket` first, then `<id>.json` last as that tab's commit
  record. A `.ket` without matching metadata is never restored. When `rename` is
  available, write `<id>.ket.part` and rename it over the snapshot. `index.json`
  is written last after every structural change (create, close, activate, path
  change) so it never names a tab whose files are missing.
- **Serialized writes**: each tab has a FIFO queue shared by its snapshot write
  and its cleanup, and `index.json` has one queue of its own. Concurrent writers
  therefore never share a `.part` file or finish out of order; the last
  submitted index wins. A writer that became stale removes only its own
  `.part` (and, for a tab, files it committed while it still held the queue),
  so it can never delete a newer committed snapshot or the current index.
- **Never while clean (autosave)**: the debounce and the interval never write
  while that tab is clean. This scopes the scheduler only: Save, Open and New
  still write a **clean** snapshot for their tab (below) so the set restores.
- **Never touches** `path`: autosave is not a save and does not clear `dirty`.
- **Written, not cleared, by Save/Open/New**: after a successful Save, Open or
  New the tab's snapshot is rewritten with its new `path`, `dirty: false` and
  content, so the tab set (paths included) restores on the next launch. The
  user's file and the snapshot stay in sync; only a **tab close** or
  **Discard** (single tab or window) removes snapshot files, metadata first,
  so an interrupted cleanup cannot resurrect a stale snapshot.
- **Per-tab write generation**: `clearSnapshot(tabId)` advances that tab's
  generation, and a snapshot write that started earlier stops before its next
  commit step. A flush captures the tab id and text at call time, so a write
  that lands after its tab was closed or after a newer switch is discarded —
  one tab's content is never written into another.
- **Restore on launch**: read `index.json`, then each listed tab's `.json` and
  `.ket`. The set is restored **silently** — no prompt; content, paths, order,
  dirty flags and the active id come back as they were. A snapshot marked dirty
  keeps `dirty`, so the next Save persists it.
- **Corrupt or missing snapshot**: a tab whose metadata or `.ket` file is
  missing or unreadable is dropped, and a `.ket` that does not pass
  `isKetDocument` (empty, or JSON without a `root`) is dropped too. If the
  restored **active** tab still fails to load into Ketcher, `App.tsx` drops it
  and falls back to the next tab (or one empty tab), so a bad snapshot never
  leaves an unusable window. When `index.json` is missing, unreadable or empty,
  or no listed tab survives, launch yields one empty tab. Launch never shows an
  error dialog for snapshot state.
- **Unknown original file**: a `path` that is missing, moved or unreadable is
  not an error. The restored tab keeps the path and the first Save recreates the
  file.

### 5.6 Close guard

`getCurrentWindow().onCloseRequested()` is registered once the editor is ready.
The handler decides from the set of dirty tabs, not just the active one:

| Dirty tabs                            | Handler behaviour                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                                  | allow the close                                                                                                                                                              |
| exactly one, and it is the active tab | `event.preventDefault()`, show in-app **Save / Discard / Cancel**: title "Save changes?", "<name> has unsaved changes.", question "Do you want to save them before closing?" |
| exactly one, and it is not active     | `event.preventDefault()`, show **Discard / Cancel only**: title "Unsaved changes", "<name> has unsaved changes.", question "Are you sure you want to discard them?"          |
| more than one                         | `event.preventDefault()`, show **Discard / Cancel only**: title "Unsaved changes", "<n> documents have unsaved changes.", question "Are you sure you want to discard them?"  |

Follow-up states:

- **Cancel** — do nothing; the window and every tab stay open.
- **Discard** — stop the autosave scheduler and set the busy guard **before**
  the cleanup, delete the snapshot of every **dirty** tab, drain the snapshot
  and index queues, then rewrite `index.json` with the surviving clean tabs and
  `window.destroy()`. `flushActiveTab` refuses to run while closing, busy or
  loading (checked again after `getKet`), and cleared tab ids are tombstoned,
  so an in-flight or late debounce cannot recreate a discarded snapshot or
  overwrite the survivors index. Clean tabs keep restoring on the next launch;
  only discarded work is dropped. When every tab is dirty the index is written
  empty, which restores one empty tab.
- **Save** (only offered for the single active dirty tab) — run Save (Save As if
  `path` is `null`), then `window.destroy()`. If Save As is cancelled, the close
  is aborted too.

`window.destroy()` bypasses `onCloseRequested`, so a successful Save cannot loop
back into the dialog. The multi-dirty case never offers Save because the
inactive documents cannot be written without loading each one into the editor.

### 5.7 Closing a single tab

The strip's close control (X) and a middle click close one tab:

- A **clean** tab closes immediately.
- A **dirty** tab activates first when it is not active, then shows Save /
  Discard / Cancel for that tab. Save writes it, Discard deletes its snapshot,
  Cancel keeps the tab open.
- The next active tab is the one to its right, otherwise the one to its left;
  closing the last tab leaves one fresh empty tab, so a window never has zero
  tabs.
- Closing an inactive clean tab does not touch the editor or the active tab's
  content.

### 5.8 Modules and APIs

| Module                       | Responsibility                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tabs.ts`                | pure tab model: create/close/activate, titles and dirty counting, commit content, open-target choice (`isUntouchedTab` / `importedTab`), `isKetDocument`, close-guard decisions                                                                                                                                                                                        |
| `src/tabStore.ts`            | `recovery/tabs/` paths, per-tab snapshot write/read/clear (validated, cleared-id tombstoned), serialized `index.json` write/read, Discard cleanup by dirty tab, no-op outside Tauri                                                                                                                                                                                    |
| `src/document.ts`            | names and export mapping shared by a tab's save/export actions                                                                                                                                                                                                                                                                                                         |
| `src/autosave.ts`            | debounce/interval scheduling per active tab, write-generation counter and serial task queue (all pure)                                                                                                                                                                                                                                                                 |
| `src/autosaveStore.ts`       | app-data paths, atomic snapshot write, read/clear, original-file `stat`, no-op outside Tauri                                                                                                                                                                                                                                                                           |
| `src/fileSaver.ts`           | Vite alias target for `file-saver`: `saveAs` delegates to the registered handler, browser download otherwise; direct text writer for Save                                                                                                                                                                                                                              |
| `src/saveRoute.ts`           | pure routing of a saved blob by extension and active-tab state (§5.9.1)                                                                                                                                                                                                                                                                                                |
| `src/ui/TabStrip.tsx`        | top tab strip: tabs, active tab, dirty dot, close (X / middle click), `+` button; separator = two layers of the same 1 px `#cad3dd` line: the strip's full-width `inset 0 -1px 0` box shadow for padding/gaps/after the last tab, plus a `borderBottom` on every inactive tab, while the active tab sets `borderBottom: none` and its white background covers the line |
| `src/ui/Dialog.tsx`          | overlay, panel, title, action row                                                                                                                                                                                                                                                                                                                                      |
| `src/ui/Button.tsx`          | `primary`, `secondary`, `danger` button styles                                                                                                                                                                                                                                                                                                                         |
| `src/ui/DocumentDialogs.tsx` | close-guard (window and single tab) and export and error dialogs                                                                                                                                                                                                                                                                                                       |
| `src/ui/editorButtons.ts`    | `Editor` `buttons` config: hides Ketcher's native Save As and recognize entries (§5.9)                                                                                                                                                                                                                                                                                 |
| `src/ui/toolbarIcons.ts`     | transparent `imageLink` + mask-painted glyphs and the generated toolbar style (§5.9)                                                                                                                                                                                                                                                                                   |

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
  section 5.8.1.
- `save` / `open` from `@tauri-apps/plugin-dialog`.
- Ketcher's remaining library saves (image export and any internal save) go
  through the `file-saver` alias (§5.9): a `.ket` blob writes the active tab
  directly once it has a path, and every other blob goes to the export dialog
  (§5.9.1).
- `getCurrentWindow()` from `@tauri-apps/api/window`: `setTitle()`,
  `onCloseRequested()` and `destroy()`.

#### 5.8.1 Filesystem scope

`src-tauri/capabilities/default.json` is the single source of truth for what the
webview may touch; the Rust host adds no scope at runtime. Tauri matches a
`fs:scope` entry against **absolute paths or a `$VAR` root**, so a bare `**`
matches nothing useful and leaves absolute app and user paths forbidden.

| Entry          | Grants                                                                                    | Why                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `$APPDATA/**`  | `<appDataDir>/**` — Linux `~/.local/share/<identifier>`, Windows `%APPDATA%\<identifier>` | Autosave writes `<appDataDir>/recovery/tabs/` (`<id>.ket`, `<id>.json`, `index.json`) with no dialog, so it can never be granted at runtime |
| `$HOME/**`     | the user's home directory, recursively                                                    | A document opened in an earlier session, or restored from a snapshot, is saved again without a dialog, so its path is never dialog-granted  |
| runtime grants | one picked file or directory                                                              | `plugin-dialog`'s `open` / `save` commands call `allow_file` / `allow_directory` on the fs scope, granting that path for the session        |

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

**Browser fallback** (`pnpm dev` without Tauri): tabs live in memory only — no
autosave, no restore on launch and no close guard. Save and Export fall back to a
download, following `src/fileSaver.ts`; a tab keeps `path === null` because a
browser download has no writable path.

### 5.9 Toolbar integration

The document commands live in **Ketcher's own top toolbar**. The app renders no
toolbar, dock or floating control group of its own; the only app chrome above the
canvas is the document tab strip (§5.1, `docs/conventions.md` §6.6), which
carries tab management only.

**Custom buttons.** `Editor` accepts
`customButtons: Array<{ id: string; imageLink: string; title: string }>`
(`ketcher-react` `CustomButtons.d.ts`). The app registers three:

| `id`                    | `title` | Action                                                                      |
| ----------------------- | ------- | --------------------------------------------------------------------------- |
| `chemistry-draw:save`   | Save    | Save the active tab (§5.3); Save As when its `path` is `null`               |
| `chemistry-draw:new`    | New     | open a new empty tab (§5.4); never replaces or saves the active tab         |
| `chemistry-draw:export` | Export  | open the in-app format dialog for the active tab; never changes path/format |

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

This reverses the earlier "keep native Save As" decision (§5.9, activity 2).

**`file-saver` alias.** Ketcher saves through its bundled `file-saver`
(`saveAs` for text and image blobs). `vite.config.ts` maps `file-saver` to
`src/fileSaver.ts` through `resolve.alias`; no file under `node_modules/` is
modified. The shim exposes `saveAs` and delegates to a handler the app
registers; without Tauri or without a registered handler it downloads in the
browser. Every remaining library save therefore writes through the Tauri
filesystem instead of a browser download.

#### 5.9.1 Routing rule for the aliased saver

`saveRoute` is a pure helper: given the suggested filename and the active tab's
`TabState` it returns where the blob goes. The extension is case-insensitive.

| Blob                                                              | Route                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| extension `.ket`                                                  | **document save**: write to the active tab's `path`; when `path` is `null`, open the Save As dialog (default `untitled.ket`); clear that tab's `dirty` and snapshot |
| any other extension (`.mol`, `.smi`, `.inchi`, `.svg`, `.png`, …) | **export save**: Tauri Save dialog defaulting to the supplied name; the tab's `path` stays unchanged                                                                |
| no Tauri, or no registered handler                                | **browser download**: no dialog and no writable path                                                                                                                |

The aliased saver routes image blobs (`.svg`, `.png`) the export way, so they
never touch the active tab.

**Shortcut map.**

| Keys           | Command                                                           |
| -------------- | ----------------------------------------------------------------- |
| `Ctrl+S`       | app Save for the active tab; capture-phase listener stops `Mod+S` |
| `Ctrl+Shift+S` | app Save As for the active tab                                    |
| `Ctrl+O`       | Open (reuse an untouched empty tab, otherwise a new tab)          |
| `Ctrl+N`       | New tab                                                           |
| `Ctrl+Tab`     | next tab; `Ctrl+Shift+Tab` previous tab                           |
| `Mod+S`        | intercepted; opens nothing                                        |

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
  packaging ships. The **bundled set** is Indigo, Indigo Renderer, Imago, the
  **minimal OpenCV** (core, imgproc, imgcodecs; PNG/JPEG only) and their
  non-platform dependencies such as `libjpeg`. `libstdc++` and `libgcc_s` are
  **never** shipped: the target distro runtime is used.
- **Host-provided**: `libfontconfig`, `libfreetype`, `libexpat`, `libpng` and
  `libbrotli` are **not** bundled, and neither are `libc`, `libm`, `libz` or the
  GL/X11/xcb family. The sidecar loads them from the distro through the normal
  loader path, and `ldd` on the bundled libraries shows the system paths. The
  reason is version mixing: the Debian 12 builder ships fontconfig **2.14**,
  whose parser rejects the newer `/etc/fonts` syntax of current distros (e.g.
  Fedora 45 with fontconfig **2.18**), so every PNG render logged about 45
  `Fontconfig warning` lines. The host libraries render the same output with
  **zero** warnings, and the support floor below already implies a
  fontconfig/freetype/expat/png family new enough for its own config. The real
  support floor is **glibc 2.36** (`arc4random@GLIBC_2.36` in `libindigo.so`):
  Debian 12+, Ubuntu 24.04+, current Fedora.
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

## 10. Temporary workarounds

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
selection instead of crashing. The patch rules are in `docs/conventions.md` §11
and the manual check is in `docs/verification.md` §2.

---

## 11. Non-goals

- Online accounts, telemetry, or cloud sync.
- Shipping prebuilt binaries in git.
- Reimplementing Ketcher's editor UI.
- Supporting glibc < 2.36 or webkit2gtk < 4.1.
- Shipping Imago/OpenCV or image recognition on Windows.
