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
Ketcher instance**. A tab is file state (`name`, `path`, serialized `.ket`,
dirty), never a second editor, and `.ket` is the only format Save ever writes.

### 5.1 Tab state

```ts
interface TabState {
  id: string; // stable identifier, names the tab's snapshot files
  name: string | null; // display identity from the opened/imported file
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
- `name` is the display identity of the file a tab was opened or imported
  from: `openProject` sets it to the `.ket` base name, `importStructure` to the
  imported file's base name. It is never edited after open; only Open replaces
  it.
- The tab title follows a **precedence**: base name of `path` (without the
  extension), then `name`, then `Untitled` when both are `null`. Dirty tabs show
  a **dot**, never an asterisk in the strip. `tabTitle()` still returns the
  title plus `*` while dirty: the strip removes it and paints the dot instead,
  while the window title and dialog copy use `tabTitle()` verbatim.
  `tabDisplayName()` returns the same title without the `*`, for dialog copy.
- An **untouched empty tab** has `name === null`, `path === null`,
  `dirty === false` and an empty structure (`ket` empty or a blank Ketcher
  document). Open reuses it (§5.4). An imported clean tab is not untouched: it
  has a `name` and content, so it is never mistaken for an empty tab.
- `dirty` starts `false`, becomes `true` on the first editor change while that
  tab is active, and returns to `false` only after a successful Save, Open or
  New for that tab. An inactive tab cannot change: it has no editor. An import
  starts **clean** because its content equals the source file (§5.4).
- **A path belongs to at most one tab.** Every tab with a non-`null` `path`
  owns a unique document; two tabs never point at the same `.ket`. The
  comparison is the pure `pathKey` / `findTabByPath` helper in `src/tabs.ts`
  (§5.10).

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
- The strip — with the File button at its left (§5.9) — is the only app chrome
  above Ketcher; there is no per-tab toolbar, dock or second canvas
  (`docs/conventions.md` §6.5, §6.6).

### 5.3 Save policy

All document commands act on the **active tab**.

- **Save** (`Ctrl+S`) writes the active tab's `ketcher.getKet()` as UTF-8 text
  to its `path`. With `path === null` it behaves as Save As defaulting to
  `<name>.ket`, or `untitled.ket` when the tab has no name either.
- **Save As** (`Ctrl+Shift+S`) asks for a destination through the Tauri `save`
  dialog filtered to `.ket`, prefilled with `<name>.ket` (fallback
  `untitled.ket`), appends the extension when missing, writes, and adopts the
  new path for the active tab. The previous file is left untouched.
- Save As **refuses** a destination that already belongs to **another** tab: it
  shows the **Already open** notice and writes nothing (§5.10). Saving the
  active tab to its own path is unaffected.
- Save never writes another format and never changes another tab.
- Both commands are available from the File menu (§5.9) and the keyboard.

### 5.4 Save vs Save As vs Export

| Command | Shortcut       | Target        | Writes                                         | Changes the tab's `path`            |
| ------- | -------------- | ------------- | ---------------------------------------------- | ----------------------------------- |
| Save    | `Ctrl+S`       | active tab    | `.ket` to `path` (or Save As) + clean snapshot | on first save                       |
| Save As | `Ctrl+Shift+S` | active tab    | `.ket` to the chosen path + clean snapshot     | yes                                 |
| Export  | —              | active tab    | one other format to a file                     | **no**                              |
| New     | `Ctrl+N`       | reused or new | its clean snapshot                             | `null` on the reused or new tab     |
| Open    | `Ctrl+O`       | reused or new | the tab's snapshot                             | the `.ket` path, `null` for imports |

Export is the only route to another format. It writes a separate file and never
changes the active tab's path or any other tab.

**New** reuses the active tab only when it is an untouched empty tab
(`isUntouchedTab`: `name === null`, `path === null`, not dirty, empty structure);
otherwise it opens a new tab. The target is a clean tab with `path === null` and
an empty structure. New never saves or discards a document, so it needs no dirty
prompt and never writes a user file; like every tab it gets a clean recovery
snapshot (§5.5), so the tab set restores.

**Open** reuses the active tab only when it is an untouched empty tab
(`name === null`, `path === null`, not dirty, empty structure); otherwise it
opens a new tab. It is **two entries** — File → **Open…** (`Ctrl+O`) and
File → **Import…** — that route to one of two functions by file kind:

| Command | Function                | Input                               | Tab result                                       | Save target          |
| ------- | ----------------------- | ----------------------------------- | ------------------------------------------------ | -------------------- |
| Open…   | `openProject(path)`     | `.ket` only                         | `{ path, name: base(path), dirty: false }`       | overwrites `path`    |
| Import… | `importStructure(path)` | `mol`, `smi`, `inchi`, `sdf`, `rxn` | `{ path: null, name: base(file), dirty: false }` | Save As `<name>.ket` |

Both share the same steps: busy guard → commit and flush the outgoing tab →
reuse or allocate the target tab → `readTextFile` → `setMolecule` behind the
loading flag → set the tab fields → snapshot and index → restart the scheduler.
Open… filters `.ket` only and is titled "Open"; Import… keeps the structure
filter groups and is titled "Import".

- A `.ket` file **becomes the tab's document** through `openProject`: `path` is
  the chosen file, `name` its base name, the tab is clean, so the title shows
  that base name without a dot and Save overwrites the file.
- `.mol`, `.smi`, `.sdf`, `.rxn`, InChI and any other structure format are
  **imported** through `importStructure`: no `.ket` file backs them, so `path`
  stays `null` while `name` carries the source base name. The import is
  **clean** — its content equals the source file, and `dirty` means "the editor
  changed since load/save", not "no `.ket` exists". Autosave restores it like
  any other tab. Its first Save is a Save As prefilled `<name>.ket`; once saved
  the tab adopts the `.ket` path and behaves as a document.

Open never prompts: a dirty tab is left open and untouched, and the file lands in
a new tab instead. Export file names and the window title use the same
precedence as the tab title (§5.1); Export never changes `path`, so an imported
tab exports as `<name>.<ext>`.

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
<appDataDir>/recovery/tabs/<id>.json   { name, path, savedAt, dirty }
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
  or name change) so it never names a tab whose files are missing.
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
  New the tab's snapshot is rewritten with its new `name`, `path`,
  `dirty: false` and content, so the tab set (names and paths included) restores
  on the next launch. The
  user's file and the snapshot stay in sync; only a **tab close** or
  **Discard** (single tab or window) removes snapshot files, metadata first,
  so an interrupted cleanup cannot resurrect a stale snapshot.
- **Per-tab write generation**: `clearSnapshot(tabId)` advances that tab's
  generation, and a snapshot write that started earlier stops before its next
  commit step. A flush captures the tab id and text at call time, so a write
  that lands after its tab was closed or after a newer switch is discarded —
  one tab's content is never written into another.
- **Restore on launch**: read `index.json`, then each listed tab's `.json` and
  `.ket`. The set is restored **silently** — no prompt; content, names, paths,
  order, dirty flags and the active id come back as they were. A snapshot marked
  dirty keeps `dirty`, so the next Save persists it.
- **Snapshot `name`**: `<id>.json` persists `name` so an imported tab restores
  with its title even though its `path` is `null`. A metadata entry without
  `name` (written before this field existed) falls back to the base name of its
  `path`; a legacy **import** has neither, so it restores as `Untitled` with its
  content intact. There is no index migration: `index.json` stores only ids and
  the active id.
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

| Module                       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tabs.ts`                | pure tab model: create/close/activate, `name` and the title precedence (`tabTitle` / `tabDisplayName`), dirty counting, commit content, open-target choice (`isUntouchedTab` / `importedTab`), `isKetDocument`, path ownership (`pathKey` / `findTabByPath`), close-guard decisions                                                                                                                  |
| `src/tabStore.ts`            | `recovery/tabs/` paths, per-tab snapshot write/read/clear (validated, cleared-id tombstoned), serialized `index.json` write/read, Discard cleanup by dirty tab, no-op outside Tauri                                                                                                                                                                                                                  |
| `src/document.ts`            | save target and export names shared by a tab's save/export actions: `<name>.ket` prefill with the `untitled.ket` fallback                                                                                                                                                                                                                                                                            |
| `src/App.tsx`                | tab orchestration: single-editor switching, `openProject` / `importStructure` wiring, Save/Export/window-title wiring, autosave scheduling, the close guard and the File menu actions                                                                                                                                                                                                                |
| `src/autosave.ts`            | debounce/interval scheduling per active tab, write-generation counter and serial task queue (all pure)                                                                                                                                                                                                                                                                                               |
| `src/autosaveStore.ts`       | app-data paths, atomic snapshot write, read/clear, original-file `stat`, no-op outside Tauri                                                                                                                                                                                                                                                                                                         |
| `src/fileSaver.ts`           | Vite alias target for `file-saver`: `saveAs` delegates to the registered handler, browser download otherwise; direct text writer for Save                                                                                                                                                                                                                                                            |
| `src/saveRoute.ts`           | pure routing of a saved blob by extension and active-tab state (§5.9.1)                                                                                                                                                                                                                                                                                                                              |
| `src/ui/TabStrip.tsx`        | top tab strip: File button slot at the left, tabs, active tab, dirty dot, close (X / middle click), `+` button; separator = two layers of the same 1 px `#cad3dd` line: the strip's full-width `inset 0 -1px 0` box shadow for padding/gaps/after the last tab, plus a `borderBottom` on every inactive tab, while the active tab sets `borderBottom: none` and its white background covers the line |
| `src/ui/Dialog.tsx`          | overlay, panel, title, action row                                                                                                                                                                                                                                                                                                                                                                    |
| `src/ui/Button.tsx`          | `primary`, `secondary`, `danger` button styles                                                                                                                                                                                                                                                                                                                                                       |
| `src/ui/DocumentDialogs.tsx` | close-guard (window and single tab) and export and error dialogs                                                                                                                                                                                                                                                                                                                                     |
| `src/ui/editorButtons.ts`    | `Editor` `buttons` config: hides Ketcher's native Save As and recognize entries; native Open stays visible (§5.9)                                                                                                                                                                                                                                                                                    |
| `src/ui/FileMenu.tsx`        | File button and popup at the left of the strip: item rendering, recent section, `role="menu"` keyboard and outside-click handling (§5.9)                                                                                                                                                                                                                                                             |
| `src/fileMenu.ts`            | pure File menu item model: ids, labels, order, separators and the command each item runs (§5.9)                                                                                                                                                                                                                                                                                                      |
| `src/recent.ts`              | pure recent-document list helpers: load/add (dedupe, newest first, cap 10)/remove, storage key and localStorage adapter (§5.9)                                                                                                                                                                                                                                                                       |

Ketcher API used:

- `.ket` round-trip: `ketcher.getKet()` / `ketcher.setMolecule(str)`.
- Dirty signal: `ketcher.changeEvent` (`add` / `remove`).
- Export: `getMolfile(format)`, `getSmiles()`, `getInchi()`, and
  `generateImage(ket, { outputFormat: "svg" | "png" })` for image formats.
  `exportImage` is not used: it supports only SVG in Ketcher 3.18, while
  `generateImage` covers SVG and PNG through the same route.
- Import of non-`.ket` files: `ketcher.setMolecule`, used by `importStructure`
  after Open dispatches by extension (§5.4); `.ket` files go through
  `openProject` instead.

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
autosave, no restore on launch and no close guard. Open and Import require the
desktop shell: the picker is Tauri-only and there is no browser file-input path,
so those commands cannot choose a file in the browser. Save and Export fall back
to a download, following `src/fileSaver.ts`; a tab keeps `path === null` because
a browser download has no writable path. The recent list still persists in
`localStorage`.

### 5.9 File menu

Every file command is grouped in a **File menu** at the left of the document tab
strip (§5.1, `docs/conventions.md` §6.5). The File button is the first element
of the strip, before the first tab, shares the strip's height and uses the same
Ketcher tokens, so the strip stays one row. It carries a Ketcher-style 16 px
line icon before its `File` label: a document glyph stroked in `currentColor`
with a 1.5 stroke width, so it inherits the button's text colour in every state
and needs no colour literal (`docs/conventions.md` §6.5). The popup opens below
the button, above the editor, and closes on Escape, an outside click or after an
item runs. The app renders no toolbar or dock of its own and registers no
Ketcher custom buttons.

**Items.** The list is fixed and ordered:

| Item             | Action                                                                              |
| ---------------- | ----------------------------------------------------------------------------------- |
| New              | empty tab (§5.4): reuse it when untouched, else new; never saves the active tab     |
| Open…            | `.ket` only: `openProject(path)`; reuses an untouched empty tab, else new           |
| Import…          | `mol`, `smi`, `inchi`, `sdf`, `rxn`: `importStructure(path)`; saved as `.ket` later |
| Save             | Save the active tab (§5.3); Save As when its `path` is `null`                       |
| Save As…         | write the active tab to a chosen `.ket` path                                        |
| Export…          | open the in-app format dialog for the active tab; never changes path/format         |
| Recent documents | up to 10 `.ket` paths; each opens through `openProject(path)`                       |

A separator divides the commands from **Recent documents**. The section heading
always renders; while the list is empty it shows a muted, non-interactive
`No recent documents` hint.

**Open vs Import.** Open… and Import… are separate entries with separate
filters; they never share a dialog. Open… lists `.ket` files only, is titled
"Open" and routes through `openProject`: the tab adopts the path, is clean and
Save overwrites that file. Import… lists `mol`, `smi`, `inchi`, `sdf` and `rxn`,
is titled "Import" and routes through `importStructure`: the tab is clean, keeps
the source base name and has `path: null`, so its first Save is a Save As
prefilled `<name>.ket`. Both reuse an untouched empty tab or open a new one
(§5.4).

**Save vs Save As.** Save (`Ctrl+S`) writes the active tab's `ketcher.getKet()`
to its path; an untitled tab falls through to Save As. Save As (`Ctrl+Shift+S`)
asks for a `.ket` destination, prefilled `<name>.ket` (fallback
`untitled.ket`), and adopts it for the active tab (§5.3, §5.4). Neither command
changes another tab.

**Recent documents.** The list is stored in `localStorage` under
`chemistry-draw.recent` as a JSON array of absolute `.ket` paths, newest first.

- Entries are recorded on a successful **Open…**, **Save** and **Save As**
  (the tab's final `path`). Imports do not record until they are saved as
  `.ket`.
- The list is deduped by the exact path string: opening an existing entry moves
  it to the front instead of adding a duplicate.
- Choosing an entry whose path already belongs to a tab activates that tab and
  shows the **Already open** notice (§5.10); no tab is created, no file is read
  and the entry stays a single one.
- It is capped at **10**; adding an 11th drops the oldest entry.
- When a recent entry is chosen and its file is missing or unreadable, the entry
  is **pruned** from the list and an in-app error dialog names the file; no tab
  is created or changed. The same removal happens when a recorded save path no
  longer exists.
- `localStorage` unavailable or full degrades to an in-memory list for the
  session (or no list when unavailable); the menu itself never fails.
- Browser fallback (`pnpm dev`): the list persists in `localStorage` as usual;
  Save and Export download the file (§5.8.1), while Open and Import need the
  desktop shell and cannot pick a file in the browser.

**Two open paths.** The app keeps both open flows and they are not
interchangeable:

| Entry                     | Route                            | Result                                                                                       |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Ketcher's native **Open** | Ketcher's own file dialog        | loads the structure into the current canvas; the tab keeps its name and path and turns dirty |
| File → **Open…**          | `openProject(path)`, `.ket` only | a project open: the tab adopts the file's name and path and is clean                         |

Native Open is deliberately visible again: it is the "load this structure into
what I am drawing" shortcut, so it must not create, rename or re-path a tab, and
it must not record a recent document. Anything the user intends as a document
goes through File → Open… (`Ctrl+O`), which owns names, paths and the recent
list. The two entries never merge into one dialog.

**Native Save As is hidden; native Open is visible.** Ketcher's native Save As
defaults to Molfile, which would bypass the `.ket`-only Save policy (§5.3), so
it is removed through the `Editor` `buttons` prop supplied by
`src/ui/editorButtons.ts`:

```ts
buttons: { save: { hidden: true }, recognize: { hidden: true } }
```

Ketcher's `isHidden(options, name)` reads `options.buttons[name]?.hidden`
(`ketcher-react` `dist/index.js`), the top toolbar derives `hiddenButtons` from
that config and `FileControls` drops the matching entries. Ketcher's
`ButtonName` union does not list every key the runtime accepts (`save`, and
`open` in the published version), so the object is cast to `ButtonsConfig`; that
cast is the documented workaround and the runtime lookup still matches the keys.
The hiding is configuration only: no CSS `display: none`, no DOM query and no
Ketcher source edit. `recognize` stays hidden in the same config because image
recognition is not part of the document flow. The app's `Ctrl+S` listener runs
in the capture phase, so the hidden native Save As has no keyboard route; the
visible native Open is reachable only through its toolbar button, because the
app still intercepts `Ctrl+O` for File → Open….

**Custom buttons removed.** Activity 2's `customButtons` registration, its
`chemistry-draw:*` ids and the generated toolbar style in
`src/ui/toolbarIcons.ts` are gone with the File menu: `Editor` receives no
`customButtons` prop, and `App.tsx` has no `CUSTOM_BUTTON_PRESSED` listener and
no injected `<style>`.

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

| Blob                                                              | Route                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| extension `.ket`                                                  | **document save**: write to the active tab's `path`; when `path` is `null`, open the Save As dialog (default `<name>.ket`, fallback `untitled.ket`); clear that tab's `dirty` and snapshot |
| any other extension (`.mol`, `.smi`, `.inchi`, `.svg`, `.png`, …) | **export save**: Tauri Save dialog defaulting to the supplied name; the tab's `path` stays unchanged                                                                                       |
| no Tauri, or no registered handler                                | **browser download**: no dialog and no writable path                                                                                                                                       |

The aliased saver routes image blobs (`.svg`, `.png`) the export way, so they
never touch the active tab.

**Shortcut map.**

| Keys           | Command                                                           |
| -------------- | ----------------------------------------------------------------- |
| `Ctrl+S`       | app Save for the active tab; capture-phase listener stops `Mod+S` |
| `Ctrl+Shift+S` | app Save As for the active tab                                    |
| `Ctrl+O`       | File → Open… (reuse an untouched empty tab, otherwise a new tab)  |
| `Ctrl+N`       | File → New (reuse an untouched tab, otherwise a new tab)          |
| `Ctrl+Tab`     | next tab; `Ctrl+Shift+Tab` previous tab                           |
| `Mod+S`        | intercepted; opens nothing                                        |
| `Mod+O`        | intercepted; opens nothing                                        |

Ketcher still binds `Mod+S` for its (now hidden) Save As entry and `Mod+O` for
its native Open entry (visible, but intercepted by the app). Ketcher binds its
hotkeys on the editor container in the
bubble phase (`initKeydownListener` in `ketcher-react/dist/index.js`), so the app
registers its own listener on `window` with `capture: true`, calls
`preventDefault()` **and** `stopPropagation()` for the document shortcuts, and
Ketcher never sees the event. `preventDefault()` alone is not enough: Ketcher
does not check `defaultPrevented`. A matched combination is swallowed even while
a dialog is open or a save is running, so a repeated shortcut cannot fall through
to Ketcher; only the command is skipped then. The hidden **Open** and
**Save As…** entries therefore leave no mouse or keyboard route to the native
dialogs.

### 5.10 Path uniqueness

A `.ket` path belongs to **at most one tab**, so two tabs never point at the
same document and edits cannot diverge on one file. The decision is pure and
lives in `src/tabs.ts`:

| Helper                            | Contract                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pathKey(path)`                   | comparison key: `\` becomes `/`, one trailing separator is dropped; a Windows drive-letter path (`^[A-Za-z]:`) is lower-cased, a POSIX path keeps its case |
| `findTabByPath(set, path)`        | the tab whose `pathKey` equals `pathKey(path)`, or `undefined`; the active tab is a normal match, the caller decides whether that is allowed               |
| `resolveOpenTarget(set, path)`    | `{ kind: "activate", tabId }` when any tab owns the path, otherwise `{ kind: "open" }`                                                                     |
| `canSaveToPath(set, path, tabId)` | `false` only when a tab other than `tabId` owns the path; the tab's own path and a free path are `true`                                                    |

Normalisation rules:

- Separators are unified: `C:\Docs\a.ket` and `C:/Docs/a.ket` share one key.
- One trailing separator is ignored: `/docs/a.ket/` equals `/docs/a.ket`.
- A **Windows drive-letter path** (`C:\…`, `C:/…`) is compared
  case-insensitively, because its filesystem is: `C:\Docs\A.KET` equals
  `c:/docs/a.ket`.
- A **POSIX path** is compared case-sensitively: `/docs/A.ket` and
  `/docs/a.ket` are different documents.
- Nothing else is normalised: no `.`/`..` collapsing, no symlink resolution and
  no extension change.

Guard points compare **before** touching the filesystem or the editor:

| Entry            | Condition                                    | Result                                                                                                                                                       |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File → Open…     | the chosen path belongs to any tab           | activate that tab (the single editor switches to it), show the **Already open** notice; no tab created, no re-read of the file and no snapshot for a new tab |
| Recent documents | the entry's path belongs to any tab          | the same guard as Open…; the entry is not duplicated and not pruned                                                                                          |
| Save As…         | the chosen path belongs to **another** tab   | refuse with the **Already open** notice; nothing is written, the active tab keeps its `path`, no recent entry is added                                       |
| Save As…         | the chosen path is the active tab's own path | proceed as a normal Save As                                                                                                                                  |

A free path and the active tab's own path proceed unchanged. Because the guard
runs before `readTextFile` / `writeTextFile`, a refused Open never prunes a
recent entry and a refused Save As leaves the filesystem untouched.

Snapshot restore applies the same rule: `readTabSet` keeps the first restored
tab for a path and drops later duplicates, so a set written before the guard
existed cannot reintroduce two tabs on one document. The active id is kept when
its tab survives, otherwise the first surviving tab becomes active.

**Notice dialog.** The **Already open** notice is an in-app `NoticeDialog`
(`src/ui/DocumentDialogs.tsx`); its copy is fixed in `docs/conventions.md` §6.7:
title `Already open`, one sentence `This document is already open.`, a single
primary **OK** action. It is a normal in-app dialog — `role="dialog"`,
`aria-modal`, focus trap and Escape dismissing it — with no question, no second
paragraph and no destructive action. The owning tab is activated **before** the
notice shows, so closing it lands the user on the document that already holds the
path.

### 5.11 Backstage view

The **backstage** is the app's start surface: one full-window in-app overlay above
the tab strip and Ketcher, modelled on the Stitch backstage shell but carrying
**only capabilities the app really has**. It is not a route, a second window or a
second editor; Ketcher stays mounted underneath and keeps its state.

**Layout.** The overlay fills the viewport and is one `role="dialog"` with
`aria-modal="true"` (`docs/conventions.md` §6.8):

| Region         | Content                                                                                                                                                             | Tokens                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Top bar        | app logo and `Chemistry Draw \| Backstage` title only; no exit control (the rail's **Exit Backstage** is the way out)                                               | `surface`, `border` 1 px bottom edge, 12/14 px text |
| Left rail      | 260 px column with 10 px uppercase `FILE OPERATIONS`, the five section buttons (16 px `currentColor` line icon before each label) and the bottom **Exit Backstage** | `surfaceSubtle` (`#eff2f5`)                         |
| Content pane   | white section panel, 24 px padding, `8px` surface corners                                                                                                           | `surface`, `border`, `radius` (3 px controls)       |
| Accent/borders | `#167782` accent, `#cad3dd` borders, Roboto 12/14 px, no colour outside the token palette                                                                           | `tokens.color.accent`, `tokens.color.border`, fonts |

The rail sections are, in order: **Welcome**, **Open**, **Models**, **Settings**,
**About** (ids `welcome`, `open`, `models`, `settings`, `about`; the default is
`welcome`). Each rail button renders a 16 px `currentColor` line icon before its
label: home for Welcome, folder-open for Open, cube for Models, sliders for
Settings and info for About. **Models** is reserved for future OCSR model
management and ships as an empty placeholder (see the sections table below). The
rail is a `nav` of real buttons, not a `tablist`:
the active section carries `aria-current="page"` and roving `tabIndex`, and
ArrowUp/ArrowDown/Home/End move focus between sections. The top bar title is the
dialog's `aria-labelledby` target. The panel scrolls inside the content pane, so
the rail and top bar stay fixed.

**Startup takeover.** The backstage replaces the `Loading chemistry editor...`
splash: `App.tsx` renders it from the first frame instead of the splash, while
the provider resolves, Ketcher initializes and `readTabSet()` restores the tab
set underneath. Readiness does **not** dismiss it — every launch shows the
backstage until the user leaves it through the rail's **Exit Backstage** or
`Escape` (or uses the home button later in the session), or starts a document
from Welcome. Controls that need the editor (Settings and
the About versions that come from Ketcher or the sidecar) show a muted
`Unavailable` state until their source answers; the rest of the
backstage is usable immediately. Dismissing the backstage never waits for the
restore and never triggers a save, a tab activation or `setMolecule`.

**Home button.** A house icon is the first control of the document tab strip,
immediately left of the File button and a sibling of the `role="tablist"`
(`docs/conventions.md` §6.8). It is a real `<button type="button">` with
`aria-label="Backstage"` and a 16 px `currentColor` line icon, and it opens the
backstage. `Escape` and the rail's **Exit Backstage** close it. Opening and
closing only toggle the overlay: the active tab, the canvas and every dirty flag
are left untouched, and focus returns to the home button when it was the
trigger. The top bar carries no exit control.

**Sections and data sources.**

| Section  | Rows/actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Real source                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome  | title `Welcome`, subtitle `Start from a blank canvas or a template.`; with an existing document, a primary **Back to editor — `<active tab>`** first and **Blank canvas** second; with no document, **Blank canvas** is the primary action and Back to editor is absent; then **Import structure…**, **Open project…**, a `TEMPLATES` heading with **More templates**, exactly four random cards from the real Structure Library (or the `No templates available` empty state) and the **Recent structures** table (thumbnail + name, Format, Size, Indigo Validation, Last Modified, Open) | `startNewDocument()`, `importStructure(path)`, `openProject(path)` (§5.3, §5.4); `src/templateLibrary.ts` over the Ketcher library providers; `tabTitle` for the active tab and `isUntouchedTab` for the document predicate; `src/ketcherOptions.ts` for **More templates**; `src/recentDetails.ts` + `src/previewCache.ts` for the Recent structures table (see below) |
| Open     | last 10 `.ket` paths with **Open** and **Remove**, plus the currently open tabs; **no previews or thumbnails** on any row                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/recent.ts` over `localStorage["chemistry-draw.recent"]`; open tabs from `TabSet` (§5.9)                                                                                                                                                                                                                                                                            |
| Models   | reserved for OCSR model management (not implemented): heading plus a muted empty-state note only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | none yet — empty state only                                                                                                                                                                                                                                                                                                                                             |
| Settings | curated Ketcher settings with value + unit, **ACS preset**, **Reset to defaults**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `ketcher.settingsService` after `onInit` (§5.11.1)                                                                                                                                                                                                                                                                                                                      |
| About    | app, Ketcher and React versions, Indigo version and sidecar port, platform, runtime, license links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `package.json.version` passed as `appVersion`; `ketcher-react`/`react` dependencies; `/v2/info` (`indigo_version`, `api_path`); `navigator.userAgentData?.platform` with `navigator.platform`/UA fallback, and `isTauri()`                                                                                                                                              |

**Template source.** Welcome cards are the entries of Ketcher's real **Structure
Library**, never a hand-maintained ring list. After the editor reports `onInit`,
`src/templateLibrary.ts` reads the two `Struct[]` lists ketcher-core populates:

- `FunctionalGroupsProvider.getInstance().getFunctionalGroupsList()`
- `SaltsAndSolventsProvider.getInstance().getSaltsAndSolventsList()`

The lists are read in that order and concatenated, so functional groups come
before salts and solvents. Each `Struct` maps to one `TemplateEntry`:

| Field          | Rule                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | slug of the name: lower-case ASCII letters and digits joined by single `-`; collisions get `-2`, `-3`, …; an empty slug falls back to `template` |
| `name`         | trimmed `struct.name`; the trimmed `abbreviation` when the name is empty; `Untitled template` when both are empty                                |
| `abbreviation` | trimmed `struct.abbreviation`, or `""` when the struct has none                                                                                  |
| `group`        | `functional-group` or `salt-solvent` (UI labels `Functional group` / `Salt or solvent`), from the provider list the struct came from             |
| `ket`          | `new KetSerializer().serializeMicromolecules(struct)` (ketcher-core), the document inserted when the card is clicked                             |

The mapping is pure — same input, same entries, no DOM access — and dedupes by
the case-insensitive pair `name` + `abbreviation`: the first occurrence wins, so
an entry that appears in both providers (or twice in one) renders once. The
entry list keeps the provider order.

**Previews.** Each card preview is rendered by Ketcher from the entry's own KET,
not drawn by the app: `ketcher.generateImage(entry.ket, { outputFormat: "svg" })`
returns an SVG blob through the native Indigo renderer. The preview helper
(`src/ui/backstage/useTemplatePreviews.ts`) renders each entry once after the
editor is ready, converts the blob to an object URL and caches it by entry id for
the session, so resizing, reshuffling and reopening the backstage never
re-render the same structure. While a preview is being produced the card shows a
muted, fixed-size **loading placeholder**; a failed render leaves a neutral
`Preview unavailable` placeholder. Neither placeholder invents chemistry or
falls back to a hand-drawn preview, and object URLs are revoked when the
backstage unmounts.

**Empty state.** Once the editor has initialized, a library that yields no
entries renders a muted, non-interactive `No templates available` line in place
of the grid: no card, no curated substitute and no invented structure. **More
templates** stays available beside the `TEMPLATES` heading. Before the providers
are read, no card is rendered and none is clickable; readiness never fabricates
cards or an empty library.

**Four-card subset.** The pane always shows exactly **four** random cards from the
library, independent of the viewport width: there is no width breakpoint table
and no resize listener. The count is the exported `TEMPLATE_CARD_COUNT` (`4`) in
`src/templateLibrary.ts`.
`sampleTemplates(entries, TEMPLATE_CARD_COUNT, random)` samples **distinct**
entries and returns them in library order (stable left-to-right, top-to-bottom
layout). It never duplicates an entry, never returns more than
`entries.length` (a smaller library shows all of it rather than inventing cards)
and never invents an entry. The RNG is injected so Vitest is deterministic; the
UI passes `Math.random`. The subset is re-drawn every time the Welcome section
mounts — because `App` unmounts the backstage when it closes, that means
**every time the backstage opens**. The grid uses
`repeat(auto-fit, minmax(150px, 1fr))`, so the four cards fill a wide pane and
wrap onto more rows when the pane narrows; the count, not CSS alone, decides how
many cards exist.

**Recent structures table.** Below the four-card template grid the Welcome pane
renders a compact **Recent structures** table copied from the Stitch layout but
backed by the real recent list. It is a real `<table>` with a 10 px uppercase header row
and these columns:

| Column            | Cell                                                                                                                                       | Source                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Structure Name    | 40 × 32 px thumbnail plus the path base name (full path as `title`) under a muted `Ketcher document` line                                  | `src/recent.ts` order; thumbnail from the preview cache (below) |
| Format            | upper-case extension of the path without the dot (`KET`)                                                                                   | the path                                                        |
| Size              | `formatFileSize(stat.size)`                                                                                                                | `stat` from `@tauri-apps/plugin-fs`                             |
| Indigo Validation | badge `Valid` / `Warnings` / `Invalid` / `—`                                                                                               | the struct-service check below                                  |
| Last Modified     | `formatModified(stat.mtime)` as `Today, HH:MM` (24-hour, local) / `Yesterday` / `Mon D, YYYY` (en-US); `—` when missing, invalid or future | `stat`                                                          |
| Actions           | one **Open** button, `aria-label` naming the row's document                                                                                | `openProject(path)` through the path-uniqueness guard (§5.10)   |

Rows come from the recent list only (newest first), capped to the five most
recent entries; an empty list renders a muted, non-interactive
`No recent structures` line instead of a row. Row building is pure
(`buildRecentRow` in `src/recentStructures.ts`, over the helpers in
`src/recentDetails.ts`): name and format always come from the path, while size
and mtime come from a `stat` result; the loader only supplies the file facts. A missing, unreadable or non-`.ket` file
keeps its row, shows `—` for size and Last Modified, the unknown badge (`—`) for
validation and a neutral thumbnail placeholder, and **Open** still calls
`openProject`, which surfaces the in-app error. A row never invents a size, date
or status. The table refreshes when the backstage opens and whenever the recent
list changes while it stays open.

**Validation path.** A `.ket` row is validated from its own content, never from a
hand-built structure:

1. read the file text (`readTextFile`) — the same `.ket` that Open would load;
2. `new KetSerializer().deserializeMicromolecules(text)` → `Struct`;
3. `new MolSerializer().serialize(struct)` → molfile;
4. `ketcher.structService.check({ struct: molfile, types: ["valence", "radicals", "pseudoatoms", "stereo", "query", "overlapping_atoms", "overlapping_bonds", "rgroups", "chiral", "3d"] })`.

The check result is normalised by `validationStatus` in `src/recentDetails.ts`:
an empty array (or the equivalent empty JSON) is **Valid**; a non-empty result is
**Warnings** when every entry is a warning and **Invalid** when any entry is an
error; a thrown error, an absent struct service or any value that cannot be read
is **unknown**, rendered as a muted `—` badge. The mapping never guesses: a KET
that cannot be parsed is unknown, not **Invalid**. The `.ket` file is opened
read-only: the table never writes it, adds no preview or validation field to it
and never rewrites its format.

**Preview cache.** The 40 px thumbnail is an Indigo render of that row's molfile,
not a copy of the document: `POST <api>/indigo/render` with
`{ "struct": molfile, "options": { "render-output-format": "svg" } }` returns the
SVG as a base64 body. `src/previewCache.ts` stores it at
`<appDataDir>/previews/<sha256(molfile)>.svg`, where the key is the lower-case
hex SHA-256 of the UTF-8 molfile that was rendered; `previewFileName(hash)`
appends `.svg` and `previewFilePath(hash)` joins `<appDataDir>/previews/` with
that name (the joined path is covered manually, `docs/verification.md` §2). The
directory is created on the first miss. A cache hit reads that SVG and renders it as a
`data:image/svg+xml;base64,…` URI with no sidecar call, so the second open of the
same structure is instant. A render or cache failure leaves a neutral thumbnail
placeholder and writes nothing, and the table never fabricates a preview.
Because the key is the content hash, editing a document produces a new key and a
fresh render; the same content always reuses one file.

**Tool reset.** Selecting a Structure Library entry arms Ketcher's template tool,
so the structure follows the cursor until the next click. That armed state must
not survive leaving the library context: `openBackstage()` and
`activateTabById()` call `cancelActiveTool(ketcher)` **first**, before
serializing or loading anything. The helper dispatches one bubbling, cancelable
`keydown` Escape event to the Ketcher root
(`document.querySelector(".Ketcher-root")`) — the same path a user Escape takes
— and is a no-op when the root is missing. It never clicks a DOM toolbar button,
dispatches a Redux action or resets the editor, so a switch keeps both canvases'
content and an open backstage changes no structure. Without it, a template armed
in the library would keep following the pointer over the backstage or over the
newly activated tab.

**More templates.** A **More templates** button sits at the right of the
`TEMPLATES` heading. It is disabled until the editor is ready, like the cards.
Clicking it closes the backstage **first**, then calls
`openStructureLibrary(ketcherRef.current)` from `src/ketcherOptions.ts`, which
finds Ketcher's Redux store through the mounted editor and dispatches
`MODAL_OPEN` with `{ name: "templates", prop: { tab: null } }` — the same action
as Ketcher's own `template-lib` toolbar button. Ketcher opens its **Structure
Library** (the full templates / functional-group / salts library); choosing a
template activates the template tool and closes the dialog, and the next canvas
click places it; Escape, cancel or the tool reset above clears it. Escape or
cancel closes the library without touching the canvas. If the store cannot be
found, the app shows the in-app error and adds no fake gallery or fallback list.

**Action row.** The Welcome actions are a **horizontal wrapping row**, not a
vertical column: one `display: flex` row with `flexDirection: "row"`,
`flexWrap: "wrap"`, an 8 px gap and `alignItems: "center"`, capped at the same
720 px width as the template grid and the Recent structures table. Each button
is sized to its own content — a 36 px `minHeight`, no `width: 100%` and no
`alignSelf: stretch` — so a wide pane shows one row and a narrow pane wraps onto
further rows. The row never holds more than **four** actions: **Back to editor
— `<active tab>`** (only when a document exists), **Blank canvas**,
**Import structure…** and **Open project…**. The primary action (Back to editor
with a document, otherwise Blank canvas) keeps its accent. The template grid
below stays a four-card grid, unaffected by the action layout.

**Back to editor and the first-run rule.** The Welcome pane derives its action
hierarchy from whether the tab set holds a **document**. A tab counts as a
document only when `isUntouchedTab` in `src/tabs.ts` is false — the same
predicate Open uses to decide whether an empty tab can be reused: a tab is
untouched while `name === null`, `path === null`, it is not dirty and its KET is
the empty structure. `WelcomeSection` computes
`hasDocument = tabs.tabs.some((tab) => !isUntouchedTab(tab))`, so a freshly
restored or newly created empty tab is **not** a document.

- **With a document:** the first action is a primary
  **Back to editor — `<active tab>`** button (for example
  `Back to editor — Boc*`); **Blank canvas** is secondary. The label uses
  `tabTitle`, so it carries the active tab's name and the `*` dirty marker. It
  closes the overlay only: the active tab, canvas, dirty flags and tab order are
  untouched, because the editor already shows that tab.
- **Without a document:** the Back to editor action is **absent** and
  **Blank canvas** is the primary action, so a first run offers a way to start
  working instead of opening an empty editor. Import structure… and Open
  project… stay available as secondary actions.

**Blank canvas** runs `startNewDocument`, which follows the New rule: it reuses
the active tab while `isUntouchedTab` holds and only creates a tab once the
active one holds a document, so a first run keeps its single empty tab and the
strip does not grow. The decision (`newDocumentTarget`) is made **before**
`getKet`, so the reuse branch neither commits nor flushes the outgoing tab; it
reloads `EMPTY_KET` only when the canvas still holds a structure, behind the
loading flag. `isUntouchedTab` checks emptiness semantically through
`isEmptyCanvasKet`, because Ketcher's `getKet()` on an empty canvas returns
pretty-printed KET with `ket_version` and empty `root.nodes` (plus empty
`connections`/`templates`), which a byte comparison with `EMPTY_KET` rejects.

The rail's **Exit Backstage** remains in both cases and is the only top-level
way back; the top bar has no exit control.

Clicking a card inserts that library entry's KET into a **new** tab and then
closes the backstage: it always allocates a tab (never reuses an untouched empty
tab, unlike Open), cancels any armed tool, flushes the outgoing tab, loads
`entry.ket` through `setMolecule` behind the loading flag (§5.2), and the tab
keeps `path === null`, `name === entry.name` and `dirty === true`, so it is an
unsaved new document whose first Save is a Save As. A failed load shows the
in-app error and leaves the backstage open.

**Default section.** `DEFAULT_BACKSTAGE_SECTION` is `welcome`. `Backstage` holds
it in `useState(DEFAULT_BACKSTAGE_SECTION)` and `App` renders it only while
`backstageOpen` is true, so the component unmounts on close and the next open
starts from Welcome again. There is no persisted section and no reset effect to
forget. This is the fix for the blank-on-reopen bug: the committed
activity-21 build defaulted to `new`, a section id that no longer had a body
after the rail became Welcome/Open/Models/Settings/About, so reopening after an
edit mounted a blank content pane. The default must stay `welcome`; a test pins
it.

**Unknown section fallback.** `renderSection` switches over the five known ids
and its `default` branch renders **Welcome**; `normalizeSection` in
`src/backstage.ts` maps any id that is not in the section list to `welcome`
before it is stored. A stale persisted id, an id whose section was removed, or
an id left over from hot reload therefore renders Welcome and never an empty
content pane. Unknown ids do not get their own pane and never fall through to
nothing.

Command behaviour:

- **Models** is a reserved section: it renders only a heading and a muted,
  non-interactive empty-state note. It has no list, no actions and no data — it
  must not show fake models, versions or download counters, and it is not a
  disabled copy of a future picker.

- **Welcome** reuses an untouched active tab or creates one, then closes the
  backstage. **Blank canvas** is the primary action when no document exists and
  becomes secondary once one does;
  **Back to editor — `<active tab>`** is primary and present only with a
  document, and closes the overlay to the tab the editor already shows.
  **Open project…** and **Import structure…** open the existing picker, and the
  backstage closes as
  the picker opens; cancelling the picker leaves the editor as it was.
  **More templates** closes the overlay and opens
  Ketcher's Structure Library. A template card inserts its library entry's KET
  into a new tab and closes the backstage (see the template source above).
- **Open** rows show the file base name with the full path as `title` and no
  preview or thumbnail. **Open** routes through `openProject(path)`; a path that
  belongs to a tab is handled by the path-uniqueness guard (§5.10) — that tab is
  activated and the `Already open` notice shows, with no re-read and no new tab.
  **Remove** drops that path through `removeRecent` and touches no tab or file.
  Choosing a currently open tab activates it and closes the backstage. An empty
  list shows a muted, non-interactive `No recent documents` hint.
- The backstage never closes a tab, never discards work and never adds a second
  route to a command: every button calls the function the File menu already uses,
  and a template card calls the same `setMolecule` load path a document open
  uses.
- **File commands live in the File menu only.** New, Open, Import, Save, Save
  As and Export are not duplicated in the backstage; Save/Save As/Export remain
  reachable from the File menu (§5.3, §5.4) and from their shortcuts.

**Removed Stitch content.** The backstage reproduces the Stitch templates layout
with **real** structures only (the library entries above) and the Stitch Recent
structures table with **real** file data (the table above). It does not reproduce
the mock's "Open from Indigo sidecar" entry, coordinate-grid note,
molecular-weight chips or a models counter. The validity badge and the thumbnail
are no longer mock-only: they are the real Indigo check and the real render
described above. **More templates** is not the mock's
"Browse all fragments" link: it opens Ketcher's real Structure Library through
`MODAL_OPEN`, with no fabricated gallery. None of the removed items map to a real
app capability, so they are absent rather than disabled or faked
(`docs/conventions.md` §6.8). The reserved **Models** rail entry is not that
counter: it is an empty placeholder for OCSR model management with no number or
status.

**Module map.**

| Module                                       | Responsibility                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/Backstage.tsx`                       | overlay shell, top bar, rail navigation (16 px icons + labels), content routing, focus trap and Escape; defaults to `DEFAULT_BACKSTAGE_SECTION` and is unmounted on close                                                                      |
| `src/ui/backstage/WelcomeSection.tsx`        | title, subtitle, document-derived actions (primary Back to editor with a document, otherwise primary Blank canvas), Import structure…, Open project…, More templates and four random library cards or the `No templates available` empty state |
| `src/ui/backstage/TemplateCard.tsx`          | one card: rendered SVG preview (cached, with loading/error placeholders), name, abbreviation line and group chip; click inserts the entry's KET into a new tab                                                                                 |
| `src/ui/backstage/useTemplatePreviews.ts`    | preview cache: one `generateImage` render per entry id, object URLs, loading and error states                                                                                                                                                  |
| `src/ui/backstage/OpenSection.tsx`           | recent rows (open/remove) and open-tab rows, without previews, plus the empty hint                                                                                                                                                             |
| `src/ui/backstage/RecentStructuresTable.tsx` | Welcome table: header and rows (thumbnail, name, format, size, validation badge, modified, Open), its empty line and its degraded placeholders                                                                                                 |
| `src/recentDetails.ts`                       | pure recent-table helpers: `formatFileSize`, `formatModified`, `validationStatus` mapping, `previewFileName` and `contentHash`                                                                                                                 |
| `src/recentStructures.ts`                    | recent-table loader plus the pure `buildRecentRow` over path, `stat`, text, check result and preview (+ missing-file placeholders)                                                                                                             |
| `src/previewCache.ts`                        | on-disk preview cache under `<appDataDir>/previews`: sha-256 molfile key, read, write and the sidecar SVG render fallback                                                                                                                      |
| `src/ui/backstage/SettingsSection.tsx`       | controls bound to `ketcher.settingsService`, ACS preset and reset                                                                                                                                                                              |
| `src/ui/backstage/AboutSection.tsx`          | version rows, platform and license links                                                                                                                                                                                                       |
| `src/backstage.ts`                           | pure model: ordered section list and default, `normalizeSection` (unknown id → Welcome), declared-version helper; re-exports the settings descriptors                                                                                          |
| `src/templateLibrary.ts`                     | pure real-library model: provider lists → `TemplateEntry[]` with slug ids and name/abbreviation dedupe, KET per entry, the `TEMPLATE_CARD_COUNT` (4) and `sampleTemplates`; `cancelActiveTool` dispatches Escape to the Ketcher root           |
| `src/templates.ts`                           | legacy curated ring descriptors, retained only as a documented fallback; never rendered as cards and never used when the library is empty                                                                                                      |
| `src/ketcherOptions.ts`                      | narrow Ketcher store adapter: `findKetcherRoot` and `openStructureLibrary`, dispatching `MODAL_OPEN` (`templates`, `tab: null`)                                                                                                                |
| `src/settingsModel.ts`                       | pure settings descriptors (key, label, control, unit key, bounds/options) and value formatting                                                                                                                                                 |
| `src/ui/HomeButton.tsx`                      | house button in the tab strip that opens the backstage                                                                                                                                                                                         |

#### 5.11.1 Settings binding

Settings come from the mounted editor, never from a copy: after `onInit`,
`ketcher.settingsService` exposes `getSettings()`,
`updateSettings(partial)`, `subscribe(listener)`, `resetToDefaults()` and
`loadPreset(name)`. The section reads the service when it mounts and on every
subscription event, so an external change is reflected immediately. A control
change sends a **single-key** partial to `updateSettings`; the service validates
it, persists it (Ketcher's own `ketcher-opts` `localStorage` entry) and emits the
update, which is what redraws the canvas. Settings are global editor
preferences, not document data: they are not stored in `.ket`, not per tab and
not snapshotted.

The curated keys are exactly the real Ketcher 3.18 settings below; labels are
sentence case and every key with a companion `…Unit` key renders a unit select
beside the number input. No other setting, and nothing Ketcher does not have
(theme toggle, grid, model thresholds), is exposed. Numeric bounds are the
schema's where Ketcher defines one; where it does not (`imageResolution`), the
UI keeps a documented floor and no maximum.

| Ketcher key                     | Label                         | Control       | Unit key / range or options                                        |
| ------------------------------- | ----------------------------- | ------------- | ------------------------------------------------------------------ |
| `atomColoring`                  | Atom coloring                 | checkbox      | —                                                                  |
| `carbonExplicitly`              | Show carbon explicitly        | checkbox      | —                                                                  |
| `showHydrogenLabels`            | Hydrogen labels               | select        | `off`, `Hetero`, `Terminal`, `Terminal and Hetero`, `On`           |
| `showCharge`                    | Show charges                  | checkbox      | —                                                                  |
| `showValence`                   | Show valence                  | checkbox      | —                                                                  |
| `aromaticCircle`                | Aromatic circle               | checkbox      | —                                                                  |
| `showStereoFlags`               | Stereo flags                  | checkbox      | —                                                                  |
| `stereoLabelStyle`              | Stereo label style            | select        | `IUPAC`, `classic`, `On-Atoms`, `off`                              |
| `bondLength`                    | Bond length                   | number + unit | `bondLengthUnit`: `px`/`pt`/`cm`/`inch`; 0.1–1000                  |
| `bondThickness`                 | Bond thickness                | number + unit | `bondThicknessUnit`: `px`/`pt`/`cm`/`inch`; 0.1–96                 |
| `bondSpacing`                   | Bond spacing                  | number        | integer 1–100; Ketcher has no unit key for it                      |
| `stereoBondWidth`               | Stereo bond width             | number + unit | `stereoBondWidthUnit`: `px`/`pt`/`cm`/`inch`; 0.1–96               |
| `hashSpacing`                   | Hash spacing                  | number + unit | `hashSpacingUnit`: `px`/`pt`/`cm`/`inch`; 0.1–1000                 |
| `reactionComponentMarginSize`   | Reaction component margin     | number + unit | `reactionComponentMarginSizeUnit`: `px`/`pt`/`cm`/`inch`; 0.1–1000 |
| `fontsz`                        | Atom label size               | number + unit | `fontszUnit`: `px`/`pt`/`cm`/`inch`; 0.1–96                        |
| `imageResolution`               | Image resolution              | number        | DPI, no unit key; unbounded in Ketcher (UI floor 1, no maximum)    |
| `rotationStep`                  | Rotation step                 | number        | integer 1–90 degrees                                               |
| `valence-mode`                  | Valence mode                  | select        | `default`, `biovia-2009`, `biovia-2017`                            |
| `smart-layout`                  | Smart layout                  | checkbox      | —                                                                  |
| `ignore-stereochemistry-errors` | Ignore stereochemistry errors | checkbox      | —                                                                  |
| `dearomatize-on-load`           | Dearomatize on load           | checkbox      | —                                                                  |

- **ACS preset** calls `loadPreset("acs")`. Ketcher defines it as
  `atomColoring: false`, `fontsz`/`fontszsub: 10 pt`, `bondLength: 14.4 pt`,
  `bondSpacing: 18`, `bondThickness: 0.6 pt`, `stereoBondWidth: 2 pt`,
  `hashSpacing: 2.5 pt`, `reactionComponentMarginSize: 1.6 pt` and
  `imageResolution: 600`.
- **Reset to defaults** calls `resetToDefaults()`, restoring Ketcher's own
  defaults (`atomColoring: true`, `bondLength: 40 px`, `bondThickness: 2 px`,
  `stereoBondWidth: 6 px`, `hashSpacing: 1.2 px`, `fontsz: 13 px`,
  `imageResolution: 72`, `rotationStep: 15`, …). The section never writes a
  settings object of its own.
- Before the editor reports `onInit`, the section shows a muted
  `Settings become available when the editor is ready` line with disabled
  controls; it never falls back to a hard-coded copy of the settings.

#### 5.11.2 About sources

| Row            | Source                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chemistry Draw | `package.json.version`, passed to the section as the `appVersion` prop                                                                                 |
| Ketcher        | the `ketcher-react` dependency declared in `package.json`, read at build time and shown without its range prefix                                       |
| React          | the `react` dependency declared in `package.json`, read at build time                                                                                  |
| Indigo         | `indigo_version` (mirrored as `Indigo.version`) from `GET /v2/info`; `Unavailable` while the sidecar has not answered                                  |
| Sidecar port   | the port parsed from `api_path` in the same `/v2/info` response — the actually bound port, not the preferred 9321                                      |
| Platform       | the webview-reported platform string (`navigator.userAgentData.platform`, `navigator.platform` then `navigator.userAgent` fallbacks), labelled as such |
| Runtime        | `isTauri()`: `Desktop (Tauri)` in the app shell, `Browser` in a plain web build                                                                        |
| License links  | Ketcher (Apache-2.0), Indigo (Apache-2.0), ONNX Runtime (MIT), opened in the system browser through `@tauri-apps/plugin-opener`                        |

There is no build SHA, commit id, build date, IUPAC version or model count: the
project has no real value for them, so About shows no row rather than a
placeholder.

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
