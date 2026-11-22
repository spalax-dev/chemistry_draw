# Verification

> How to verify that work is correct.

---

## 1. Before declaring a task `done`

1. Run `node scripts/harness.mjs` — all blocks must pass (exit code 0). For a
   faster iteration loop (skips frontend build, uses `cargo check` instead of
   Clippy, and skips sidecar tests), use `node scripts/harness.mjs --fast`; the
   full run is still required before closing a task.
2. `pnpm exec tsc --noEmit` — no type errors.
3. `pnpm run lint` — ESLint clean.
4. `pnpm run format:check` — Prettier clean.
5. `cargo fmt --all --check` — Rust formatting clean.
6. `cargo clippy --workspace --all-targets -- -D warnings` — no Rust warnings.
7. `cargo test -p indigo-server` — all sidecar tests green
   (`LD_LIBRARY_PATH` must point at `src-tauri/lib/linux-x86_64`; the harness
   sets it for you).
8. Review `docs/CHECKPOINTS.md` — mark the applicable boxes.
9. `node --test scripts/lib/activity-policy.test.mjs` — policy tests green.
   The harness runs the same command in block 3 and then validates
   `activities.json` with `scripts/lib/activity-policy.mjs`, including
   sequential status (no `in_progress`/`done` task while an earlier task is not
   `done`).

The one-shot equivalent is `pnpm run check` (typecheck + ESLint + Prettier) plus
the Rust commands above; `node scripts/harness.mjs` runs everything. Vitest is
configured (`docs/testing.md` §5), so `pnpm test` and the harness block that runs
it must be green too.

Packaging or dependency changes additionally require:

10. `task packages` — builds `.deb`, `.rpm` and the AppImage.
11. `dpkg-deb -I build/packages/*.deb` and `rpm -qpR build/packages/*.rpm` —
    dependency metadata sane.
12. `ldd` on the sidecar inside the package — no `not found`, no `libstdc++`.

Windows changes are validated by the `windows` job in
`.github/workflows/ci.yml` (there is no Windows host in local development):

13. `pwsh scripts/fetch-windows-libs.ps1` succeeds and creates the five DLLs
    plus `indigo.lib` / `indigo-renderer.lib`.
14. `node scripts/harness.mjs` passes on Windows (ShellCheck is skipped: the
    scripts are POSIX-only).
15. Sidecar smoke test: `/v2/info` reports `"imago_versions": []`,
    `/v2/health` reports `imago_worker.found = false`, and
    `POST /v2/imago/uploads` returns 404.
16. `pnpm tauri build --bundles nsis` produces
    `target/release/bundle/nsis/*.exe`, uploaded by CI.
17. `cargo check -p indigo-server --all-targets --target x86_64-pc-windows-msvc`
    catches `cfg(windows)` mistakes without linking the DLLs.

### 1.1 Toolchain and security gates (0.x)

Environment used for acceptance:

| Tool | Version                                                       |
| ---- | ------------------------------------------------------------- |
| Node | **24.20.0** used (floor **24.14.1**, from `.nvmrc`/`engines`) |
| pnpm | **12.21.0** via Corepack (`packageManager`)                   |
| Rust | **1.99.1** stable                                             |

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run audit
pnpm run audit:prod
cargo audit
node scripts/harness.mjs
```

Expected result:

- `pnpm run audit` and `pnpm run audit:prod`: **0 high/critical** npm findings in
  both graphs.
- `cargo audit`: **0 vulnerabilities**. Remaining warnings are the tracked
  no-fix set (`docs/TOOLCHAIN.md` §3.1.2).
- Allowlist unchanged: `elliptic` low and `glob`/`minimatch` moderate
  build-only, expiring **2027-06-30**.
- Harness **14/14** blocks green.

Evidence for this change:

| Check            | Result                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Policy tests     | 56 passing                                                                                                                    |
| Vitest           | 442 passing                                                                                                                   |
| Sidecar tests    | 87 passing                                                                                                                    |
| Full harness     | green                                                                                                                         |
| Builder image    | Node 24.22.3, pnpm 12.21.0                                                                                                    |
| CI action majors | checkout v7, setup-node v7, upload-artifact v7, pnpm v6, buildx v4, build-push v7, cache v6, release-please v5, gh-release v3 |

CI itself was not executed locally; the action tags were verified upstream.

---

## 2. Manual verification steps

### Application startup

- `task run` opens the editor and the sidecar logs `indigo-server listening`.
- `curl -s http://127.0.0.1:9321/v2/info` answers 200.
- `curl -s http://127.0.0.1:9321/v2/health` reports `"status": "ok"`.
- Closing the window kills `indigo-server` (no orphan on the port).

### Logs

- `~/.local/share/dev.spalax.ChemistryDraw/logs/chemistry-draw.log` exists.
- It contains `[frontend] session start` and `[indigo-server]` lines.
- Panics include a file:line location.

### Chemistry behaviour

- Draw a molecule, run Layout and Clean: the structure stays valid.
- Save as PNG/SVG: the file is produced and non-empty.
- Export a structure to PNG with the desktop build: the render succeeds, the
  image matches the previous output, and the log contains **no**
  `Fontconfig warning` lines.
- `ldd src-tauri/lib/linux-x86_64/libindigo-renderer.so` resolves
  `libfontconfig.so.1` from the host (e.g. `/lib64/` on Fedora,
  `/usr/lib/x86_64-linux-gnu/` on Debian), not from the bundled directory.
- Recognize (Imago, Linux): upload → poll reaches `SUCCESS` or a clear error.
- Windows: Recognize Molecule is disabled and `/v2/imago/uploads` is absent.

### Ketcher render robustness

Run against the desktop build (`task run`) with the developer console open.

1. **Reproduce the desync.** Draw a small structure, then create an
   invalid-valence edit and/or edit a bond and undo the deletion so a bond keeps
   a stale half-bond reference. A structure whose bond references a half-bond
   missing from the struct is the condition under test; `Ctrl+Z` after deleting
   a bond is the shortest reproduction.
2. **Hover and select bonds.** Hover over the affected bond and select it (click
   or rubber-band selection). The console must not flood with
   `halfBonds.get(...)` / `undefined is not an object (restruct.molecule.halfBonds.get(bond.hb1).p)`
   errors, and the render loop must keep running. The bond may simply show no
   hover or selection highlight; that graceful degradation is the expected
   result, not a failure.
3. **No regression.** Hover and select a normal, valid bond: the hover plate and
   selection plate draw as before.

### Documents, autosave and recovery

Run against the desktop build (`task run`), not the browser, except where the
fallback is stated. `<appDataDir>` is `~/.local/share/dev.spalax.ChemistryDraw`
on Linux and `%APPDATA%\dev.spalax.ChemistryDraw` on Windows.

1. **Save an unsaved document.** Draw a structure, press `Ctrl+S`. A Save As
   dialog appears with `untitled.ket`. Choose a directory: the file exists,
   contains `.ket` JSON, the tab shows the file name with no dirty dot, and that
   tab's snapshot under `<appDataDir>/recovery/tabs/` exists and now records
   `dirty: false` with the chosen path (Save writes a clean snapshot so the tab
   set restores).
2. **Save again.** Edit the structure and press `Ctrl+S`: no dialog appears,
   the same file is overwritten (mtime changes) and the tab's dirty dot is gone.
3. **Save As.** Edit, run Save As to a second path: the title changes, the new
   file has the edits and the first file is unchanged.
4. **Export.** Export each of Molfile V2000/V3000, SMILES, InChI, SVG and PNG.
   Every file is non-empty and opens in an independent viewer; the tab title and
   its `path` do not change, and a following `Ctrl+S` still writes the `.ket`
   file, not the export.
5. **Crash simulation (forced kill).** Draw or edit, wait at least 2 s, then
   force-kill the process while it is dirty (`kill -9 <pid>`). Do **not** close
   the window: a close runs the guard and cleanup. `<appDataDir>/recovery/tabs/`
   contains `<id>.ket` plus `<id>.json` with the original `path`, a timestamp
   and `dirty: true`, and `index.json` lists the tab and the active id.
6. **Restore on launch.** Relaunch after the forced kill: the tab set returns
   **silently** (no dialog), the dirty tab keeps its content, path and dirty
   dot, and Save then writes the recovered edits to the original path.
7. **Corrupt or invalid snapshot.** Delete `index.json`, or truncate one tab's
   `.ket` (or replace it with `{}`): the bad tab is dropped. When it was the only
   tab the app opens one empty tab; a still-valid active tab that cannot load is
   dropped the same way. No error dialog and no crash in the log.
8. **Clean close.** With saved/clean tabs, close the window: it closes with no
   dialog and **keeps** every tab snapshot. Relaunch restores the same tab set
   (content, paths, order and active tab).
9. **Close guard.** With unsaved changes in a single active tab, close the
   window: the in-app Save/Discard/Cancel dialog appears.
   - Cancel: the window stays open and the structure is intact.
   - Save: the document is written before the window closes.
   - Discard: the window closes without writing and without leaving a snapshot.
   - Cancel the Save As dialog during Save: the window stays open.
10. **New and Open.** New reuses an untouched empty active tab and otherwise
    opens a new empty tab; it never saves or discards the previous tab. Open a
    `.ket`: the file lands in an untouched empty tab (or a new
    one), the path and title follow it and the tab is clean. Open or import a
    `.mol`/`.smi`/`.inchi`/`.sdf`/`.rxn`: it goes through Ketcher, the title is
    the file's base name, the tab is **clean** (no dot) and `path` is `null`.
    Open never prompts for a dirty tab.
11. **Browser fallback.** `pnpm dev` in a normal browser: tabs work in memory,
    Save and Export download files (no dialog, no path), Open and Import are
    unavailable because they need the Tauri file picker (there is no browser
    file input), nothing is saved or restored across reloads, there is no close
    guard, and the console stays free of errors.
12. **Autosave scope.** Draw or edit a structure and let the debounce fire
    (about 2 s). `<appDataDir>/recovery/tabs/` contains that tab's `.ket` and
    `.json` plus `index.json`, and the log has no `forbidden path` WARN naming
    `recovery` or `allow-mkdir`.
13. **Restored document scope.** Repeat step 5 with a document that has a saved
    `path`, relaunch and press `Ctrl+S` without opening a dialog: the restored
    tab is written to its original path, the dirty dot disappears, and the log
    has no `forbidden path` WARN for that path. With the original file deleted,
    restore keeps the path and the first Save recreates the file.
14. **Open vs import naming.** Open a `.ket` file named `benzene.ket`: the tab
    title is `benzene`, its `path` is that file and no dirty dot shows. Import
    `benzene.mol` with the same structure: the tab title is `benzene`, no dot
    shows and `path` is `null`. Both land in an untouched empty tab, otherwise a
    new one.
15. **Import save and export names.** With the imported tab active, Export
    Molfile, SMILES and PNG: each saved file is named `benzene.<ext>` and the tab
    keeps its name and `path: null`. `Ctrl+S` opens Save As prefilled with
    `benzene.ket`; after saving, the file exists, the title is unchanged and the
    tab is now a `.ket` document with that path.
16. **Relaunch keeps names.** With one saved `.ket` tab and one imported tab,
    force-kill and relaunch: both titles return (the `.ket` tab from its path,
    the import from its snapshot `name`), the import is still clean with
    `path: null`, and its `<id>.json` records `name: "benzene"`.
17. **Legacy snapshot.** Use an `<id>.json` written before `name` existed: with
    a `path`, the tab restores under that path's base name; a legacy import
    (`path: null`, `dirty: true`) restores as `Untitled` with its content intact
    and no error dialog.

### Document tabs

Run against the desktop build (`task run`). `<appDataDir>` is
`~/.local/share/dev.spalax.ChemistryDraw` on Linux and
`%APPDATA%\dev.spalax.ChemistryDraw` on Windows.

1. **Create.** The strip sits at the top of the window, above Ketcher's toolbar.
   The `+` button opens a new tab and activates it; every new tab shows
   `Untitled` with no dirty dot.
2. **Switch.** Draw different structures in two tabs, then click between them:
   each tab shows its own structure. A clean tab that received a programmatic
   load (switching to it) gains no dirty dot.
3. **Autosave per tab.** Edit two tabs, switch between them, wait at least 2 s
   per tab: `<appDataDir>/recovery/tabs/` has one `<id>.ket` and `<id>.json` per
   tab, `index.json` lists the order and the active id, and no tab's `.ket`
   contains another tab's structure.
4. **Rapid switching.** Alternate quickly between tabs several times, then leave
   each tab and return: every structure is intact, and no snapshot contains a
   molecule belonging to another tab.
5. **Restore on relaunch.** Open three tabs with different content, save one and
   leave the others dirty, then **force-kill** the process (`kill -9 <pid>`; do
   not close the window — a normal quit with dirty tabs prompts) and relaunch:
   the same tabs return in the same order with the same active tab, content,
   paths and dirty dots, and **no** prompt appears.
6. **Multi-tab close guard.** With at least two dirty tabs, close the window:
   only **Discard / Cancel** is offered, the title is `Unsaved changes`, and the
   copy reads `<n> documents have unsaved changes.` followed by
   `Are you sure you want to discard them?`. Cancel keeps every tab; Discard
   closes the window, removes only the dirty tabs' snapshots and leaves the clean
   tabs' snapshots in place (a relaunch restores the clean tabs).
7. **Inactive dirty tab.** With one clean active tab and one dirty inactive tab,
   close the window: again only **Discard / Cancel** is offered, the title is
   `Unsaved changes`, and the copy reads `<name> has unsaved changes.` followed by
   `Are you sure you want to discard them?`. Cancel keeps everything; Discard
   keeps the clean tab's snapshot and drops the dirty one.
8. **Single-tab close.** Close a dirty tab with its `×`: it activates first when
   needed and the dialog has the title `Save changes?`, the line
   `<name> has unsaved changes.` and the question
   `Do you want to save them before closing?`, with **Save / Discard / Cancel**
   actions. Cancel keeps it, Discard closes it and removes only its snapshot,
   Save writes it before closing. A middle click on the tab does the same. A
   clean tab closes with no prompt, and the next active tab is the right
   neighbour, otherwise the left.
9. **Open reuse.** In an untouched empty tab, Open a `.ket` file: the file fills
   that tab and the strip does not grow. Repeat from a non-empty or saved tab:
   Open creates a new tab and the existing tabs are untouched.
10. **Active-tab commands.** Save writes the active tab's path only; Save As
    changes only that tab's path; Export changes no tab; New reuses an untouched
    empty active tab and otherwise adds a tab, never replacing or discarding the
    active one.
11. **Styling.** The separator is one 1 px `#cad3dd` line drawn in two layers.
    The strip draws the free-area line as an inset box shadow
    (`boxShadow: "inset 0 -1px 0"` with `tokens.tab.border`), spanning the left
    padding, the gaps and the area after the last tab. Every inactive tab draws
    its own `borderBottom` (`tokens.borderWidth solid tokens.tab.border`), flush
    (`gap: 0`) and at the same y, so the line is continuous under the tabs with
    no 2 px seam. The active tab sets `borderBottom: none` and is the white
    workspace surface with no grey `#e1e5ea` fill, so it is the only tab with no
    line under it. Hovering colours the label/close control with `#00838f`, and
    the surface around the tabs is `#eff2f5`. Tab titles never show `*`; unsaved
    tabs show a dot.
12. **One editor.** With the developer console open, switching tabs never mounts
    a second Ketcher canvas, and no per-tab toolbar or dock appears.

### In-app dialog styling

Run against the desktop build (`task run`).

1. **Export dialog.** Draw a structure and click Export: the format dialog opens
   and the editor behind it is only lightly dimmed (~20 % grey, still clearly
   readable), not heavily darkened. Faint diagonal lines are visible across the
   dimmed editor — the overlay is a 10×10 repeating hatch, not a flat wash. A
   flat, hatch-free wash is the bug, not a styling choice. The overlay fades in
   smoothly over about 0.3 s instead of snapping, and the hatch pattern neither
   shimmers nor scales while the backdrop fades.
2. **Close guard.** With unsaved changes, close the window: the close-guard
   dialog opens with the same light dimming, the same faint diagonal hatch
   behind it and the same smooth fade.
3. **Panel shape.** Both dialogs show white panels with `8px` rounded corners,
   no border and no drop shadow. Comparing Export and the close guard side by
   side, they look identical; only their text and buttons differ.
4. **Native parity.** Compare against Ketcher's own modal styling (overlay
   `rgba(94,94,94,.2)` with its `10px 10px` diagonal hatch and a borderless,
   shadowless white panel with `8px` corners): the overlay tint, the hatch, its
   `0.3s` fade and the panel frame match.
5. **Every dialog, both zooms.** Repeat step 1 for every in-app dialog (Export,
   close guard, single-tab close prompt, error dialog): the faint diagonals are
   visible
   behind each of them at 100 % **and** 125 % zoom. Diagonals missing behind any
   one dialog, or only at one zoom, fail this check — the effective
   `background-image` must be the token wrapped in `url("…")`, and good parity
   stops there: the panel has no transform/opacity entrance animation and ours
   is fixed above the whole app rather than scoped to the editor.

### File menu

Run against the desktop build (`task run`) unless a step says browser.
`<appDataDir>` is `~/.local/share/dev.spalax.ChemistryDraw` on Linux and
`%APPDATA%\dev.spalax.ChemistryDraw` on Windows.

1. **Placement, icon and items.** The File button is the first element of the
   tab strip, left of the first tab and sharing its height; it is not a second
   row. It shows a 16 px line icon before the `File` label, drawn in the same
   colour as the label (`currentColor`); hovering and opening the menu recolour
   both together and never the icon alone. Clicking it opens one menu listing
   New, Open…, Import…, Save, Save As…, Export…, a separator and Recent
   documents (when the list is empty the heading shows a muted
   `No recent documents` hint). Ketcher's toolbar shows no Save, New or Export
   custom buttons and the app injects no toolbar icon style.
2. **Keyboard and dismissal.** Enter, Space and ArrowDown open the menu and
   focus the first item; ArrowUp opens it on the last. ArrowUp/ArrowDown move,
   Home/End jump, Enter or Space run the focused item, Escape closes the menu and
   returns focus to the File button, and Tab or an outside click closes it
   without running an item. Running an item closes the menu before its dialog
   opens.
3. **New.** With unsaved changes, File → New: a new empty tab opens, the previous
   tab keeps its content and dirty dot, and no dialog appears.
4. **Open is `.ket` only.** File → Open…: the dialog is titled `Open` and its
   filter lists `.ket` files only. Open `benzene.ket`: it fills an untouched
   empty tab (or opens a new one), the title is `benzene`, the tab is clean and
   Save writes that path. A `.mol` file cannot be selected in this dialog.
5. **Import accepts structures.** File → Import…: the dialog is titled `Import`
   and lists Molfile, SMILES, InChI, SDF and RXN. Import `benzene.mol`: the tab
   title is `benzene`, it is clean with `path: null`, and `Ctrl+S` opens Save As
   prefilled with `benzene.ket`. After saving it becomes a `.ket` document.
6. **Save and Save As.** Save writes the active tab's `.ket` path; an untitled or
   imported tab falls through to Save As with `<name>.ket` (or `untitled.ket`).
   Save As writes the chosen file and adopts the new path; the previous file is
   untouched.
7. **Export.** File → Export… opens the existing format dialog (Molfile
   V2000/V3000, SMILES, InChI, SVG, PNG). Export leaves the tab title and its
   `.ket` path unchanged, and a following Save still writes the `.ket` file.
8. **Recent documents.** Open more than ten different `.ket` files. The menu lists
   at most ten entries, newest first, with no duplicates. Choosing an entry opens
   that file; re-opening a path already in the list moves it to the front instead
   of adding a duplicate. Saving and Save As add the written path. Relaunch the
   app: the list is still there.
9. **Missing recent file.** Delete one file that the menu lists, then choose it
   from Recent documents: an in-app error dialog names the file, the entry is
   removed from the list, and the tabs do not change. Re-open the menu: the
   pruned entry is gone.
10. **Native Open loads into the canvas.** Ketcher's top toolbar still has its
    native **Open** button. In a tab named `benzene` with a `benzene.ket` path,
    use it to load a `toluene.mol`: the structure appears in the current canvas,
    the tab title stays `benzene`, the tab keeps its `.ket` path (a following
    `Ctrl+S` still writes `benzene.ket`), no new tab is created, and the Recent
    documents list gains no entry. The canvas change is a normal edit, so the
    tab shows its dirty dot; saving through File → Save writes the canvas into
    the tab's own path. The app still owns `Ctrl+O`, so the keyboard route to a
    document is File → Open…, not the native button.
11. **Native Save As is absent.** Ketcher's toolbar has no **Save As…** entry.
    `Ctrl+S` runs the app Save and `Ctrl+Shift+S` opens the app Save As; no
    Ketcher native Molfile save dialog ever appears. The hiding comes from the
    `buttons` config, with no CSS `display: none` and no DOM query in the app.
12. **Browser fallback.** `pnpm dev` in a normal browser: the File menu opens,
    Save and Export download files, Open and Import are unavailable because they
    need the Tauri picker (no browser file input), and the console stays free of
    errors. The recent list still persists in `localStorage`.
13. **Open the same document twice.** Open `benzene.ket` through File → Open…,
    then open the same file again: the first tab is activated, an in-app
    `Already open` notice reads `This document is already open.`, the strip does
    not grow, the editor keeps its content, and Recent documents still holds one
    `benzene.ket` entry.
14. **Recent entry for an open file.** With `benzene.ket` open, choose it under
    Recent documents: the same activation and notice appear, no tab is created,
    no file is reread, and the list keeps one entry.
15. **Save As onto an open path.** With two tabs, open `benzene.ket` in the
    first, activate the second and Save As to `benzene.ket`: the `Already open`
    notice appears, the file's contents and mtime stay unchanged, the second tab
    keeps its previous path and no recent entry is added. Save As the first tab
    to its own `benzene.ket` path: it writes normally and shows no notice.
16. **Path normalisation.** On Windows open `C:\Docs\benzene.ket`, then open
    `c:/docs/BENZENE.KET`: the first tab is activated with the notice (drive
    paths compare case-insensitively and separators are unified). On POSIX open
    `/docs/a.ket` and `/docs/A.ket`: both open as separate tabs because POSIX
    paths compare case-sensitively; opening `/docs/a.ket` again still activates
    the existing tab instead of adding one.

### Backstage

Run against the desktop build (`task run`) unless a step says browser.

1. **Startup takeover.** Launch with a restored tab set: the backstage is visible
   from the first frame instead of `Loading chemistry editor...`, and it stays
   visible after Ketcher finishes initializing. With the backstage still open,
   no loading splash flashes and the tabs finish restoring underneath. Choose
   the rail's **Back to editor**: the same active tab, canvas and dirty dots are
   shown. Quit and relaunch: the backstage appears again. The top bar shows only
   the logo and the `Chemistry Draw` brand line, with no `| Backstage` suffix and
   no top-right Back to Editor control.
2. **Home button.** A 16 px house icon sits at the left of the tab strip,
   immediately before the File button and outside the tab bar. It has no visible
   label: its accessible name is `Backstage` and the hover title shows the same,
   while hovering recolours the icon to the accent and back (`currentColor`).
   Click it: the backstage opens. While the overlay covers the strip the home
   button is not reachable, so return with the rail's **Back to editor** or
   `Escape`: the active tab, canvas, dirty dots and tab order are unchanged.
   Press `Escape`, then repeat and press **Back to editor**: the same state
   returns. The rail's exit button reads **Back to editor**, never
   "Exit Backstage": it does not quit the application.
3. **Rail and focus.** The rail is a `nav`, not a tab list, and has exactly four
   sections: Welcome, Open, Models and About. They are real buttons, each with a
   16 px line icon before its label (home, folder-open, cube, info) drawn in the
   text colour, and the active one carries `aria-current="page"`. The rail has
   no **Settings** entry. The default on
   first open is Welcome. ArrowUp/ArrowDown/Home/End move focus. `Tab` cycles
   inside the overlay and never reaches the editor behind it; the overlay has
   `role="dialog"` and `aria-modal="true"`.
4. **Welcome and default section.** The pane is titled `Welcome` with the
   subtitle `Start from a blank canvas or a template.` under a `TEMPLATES`
   heading. Edit a document, close the backstage, then reopen it: it shows
   **Welcome**, never a blank content pane (the section defaults to `welcome`
   and the overlay unmounts on close; the committed activity-21 `new` default is
   what produced the blank pane). A stale or unknown section id — the value a
   hot reload can leave behind — also renders **Welcome**, because
   `renderSection` falls back to Welcome; no id reaches an empty pane.
   The actions sit in a **horizontal row**, not a vertical column: on a wide
   pane Back to editor (when present), Blank canvas, Import structure… and Open
   project… share one wrapping row at most four actions wide, and each button is
   only as wide as its label, never stretched to the pane; narrow the window and
   the row wraps instead of stacking into a full-width list.
   On a **first run** with no document — the only tab is untouched (no path, no
   name, not dirty, empty structure) — Welcome has **no Back to editor action**
   and **Blank canvas** is the primary, accented action, with Import
   structure… and Open project… secondary; the top bar shows no Back to Editor
   button. **Blank canvas** reuses that untouched tab, so the strip still holds
   one tab, and closes the
   backstage; once the tab holds a document (drawn or opened), **Blank canvas**
   adds a second tab and leaves the edited tab untouched.
   **Import structure…** lists Molfile, SMILES, InChI, SDF and RXN and lands a
   clean `path: null` tab named after the file; **Open project…** lists `.ket`
   only and adopts the path and name. Cancelling either picker leaves the editor
   unchanged.
5. **Templates come from the real library.** Open the backstage on an initialized
   editor: the `TEMPLATES` area paints four skeleton cards at once — in the grid
   shape, not clickable, with no name or structure — while the library is built
   after paint, then the cards match entries of Ketcher's **Structure Library**
   (functional groups plus salts and solvents), not a fixed ring list. Compare
   with the library opened through **More templates**: a card's structure and
   name exist there too, and no card is a hand-written or invented entry.
   Resize the window from wide to narrow and back: the grid still shows exactly
   four cards and wraps onto more rows instead of dropping to two, six or eight;
   there is no width-based count. The grid never shows a card twice and never
   more than four, and a library smaller than four shows all of it. Close and
   reopen the backstage several times: the visible subset changes
   (re-randomized on open) while the cached library is reused, with no second
   library serialization. Each card shows a rendered SVG preview produced by
   Ketcher/Indigo, the entry name, a one-line abbreviation (or its group) and a
   `Functional group` or `Salt or solvent` chip, with no molecular-weight chip.
   The preview draws the **structure with bonds** — atoms and bonds, never the
   library abbreviation `CN` or `OMe` and never brackets — because the preview
   copy removes its SGroups. While a preview renders, its area shows a
   small inline SVG spinner; a failed render shows `Preview unavailable`, never
   a hand-drawn structure. Click a card: a **new** tab opens with that library
   structure drawn from its KET (the original entry, so the abbreviation group
   is preserved), the tab is **dirty** and titled after the entry with
   `path: null`, so the first Save opens Save As, and the backstage closes;
   clicking a card twice produces two tabs rather than reusing one. With a
   **document** open — a tab with a path,
   a name or content, i.e. not an untouched empty tab — the Welcome pane's
   first action is a primary **Back to editor — `<active tab>`** (name plus `*`
   while dirty, e.g. `Back to editor — Boc*`) and Blank canvas is secondary.
   Click it: the overlay closes
   on the active tab with the canvas, dirty flags and tab order unchanged, and
   no save. Draw on a blank tab or open a `.ket`, reopen the backstage with the
   home button and confirm the action appears and is primary. On a first run
   with only the untouched empty tab it is absent and Blank canvas is primary;
   the branch keys on `isUntouchedTab`, not on the number of tabs, and the
   source test pins it.
   Click **More templates** beside the `TEMPLATES` heading: the backstage closes
   and Ketcher's **Structure Library** opens with its template, functional-group
   and salts tabs. Pick a structure: the dialog closes, the template tool is
   active, and the next canvas click places it; Escape or cancel closes the
   library without changing the canvas. There is no in-app fake gallery. With
   the editor not ready, More templates stays disabled and no card renders.
6. **Empty library.** Load the backstage with a library that yields no entries
   (for example, stub both provider lists empty before `onInit`): the
   `TEMPLATES` area shows the muted `No templates available` line, no cards, no
   curated ring fallback and no invented structure; **More templates** stays
   available. Restore the lists and reopen: the real cards return.
7. **Tool reset.** Open **More templates**, pick a structure so the template
   tool is armed and the ghost structure follows the cursor, then immediately
   open the backstage with the home button: no structure follows the cursor over
   the backstage, and closing it leaves the canvas unchanged. Repeat, arming the
   tool again and switching to another tab (click a tab or `Ctrl+Tab`): the
   newly activated tab shows its own structure and nothing follows the cursor.
   The reset dispatches Escape to the Ketcher root; no Ketcher toolbar button is
   clicked and neither tab's content changes.
8. **Open.** Add more than five real `.ket` files to the recent list, then open
   the backstage and select Open: it shows the same **Recent structures** table
   as Welcome — newest first, capped at five, with thumbnail, Format, Size,
   Indigo Validation, Last Modified and an Actions cell — plus **Remove** beside
   **Open** on each row, and the currently open tabs (Switch) below the table.
   The rows and loading match Welcome exactly and the loader runs once (no
   duplicate stat, validation or render requests between the two panes). Click
   **Remove**: that row disappears together with its stored recent entry, and no
   tab or file changes; reopen the backstage and the entry stays gone. Click
   **Open** on a listed path: it opens through `openProject`; if it is already
   open, the existing tab is activated, the `Already open` notice appears and no
   tab or entry is duplicated. Choosing a row in the open-tabs list (Switch)
   activates that tab and closes the backstage. With no recent entries, the
   table's muted `No recent structures` row shows and the open-tabs list remains.
9. **Models.** The rail shows **Models** between Open and About. Selecting
   it opens a pane with only a heading and a muted, non-interactive note about
   the section being reserved: no list, no buttons, no model names, versions or
   download counters, and nothing that can be clicked.
10. **No file section.** The backstage has no Save & Export section and no
    status strip: the content pane reaches the bottom edge. Save, Save As and
    Export are reachable from the File menu only, exactly as before.
11. **No Settings pane.** The backstage has no Settings section and no settings
    controls: no value, unit, preset, reset or sliders icon anywhere in the
    rail or content pane. Settings are not duplicated from Ketcher.
12. **Ketcher's toolbar settings.** The editor toolbar still shows the native
    **Settings** button (`src/ui/editorButtons.ts`). Click it: Ketcher's own
    settings dialog opens. Change atom coloring, bond length and image
    resolution there and confirm the canvas follows; quit and relaunch and the
    values persist through Ketcher's own `ketcher-opts` storage. Ketcher's ACS
    preset and reset-to-defaults inside that dialog still work. The app keeps no
    settings state of its own.
13. **About.** Compare with `curl -s http://127.0.0.1:<port>/v2/info`: the Indigo
    version and the sidecar port match `indigo_version` and `api_path`. The app
    version matches `package.json`/the installed release, and the Ketcher and
    React versions match the `ketcher-react` and `react` dependencies. The
    platform row is present and the runtime row reads `Desktop (Tauri)` in the
    app shell (`Browser` under `pnpm dev`). Ketcher (Apache-2.0), Indigo
    (Apache-2.0) and ONNX Runtime (MIT) links open in the system browser. No
    build SHA, commit, build date, IUPAC version or models counter is shown;
    while `/v2/info` is unavailable the Indigo and port rows read `Unavailable`.
14. **Removed content.** The templates grid is the only Stitch mock surface that
    exists, and it carries real structures only. The backstage contains no "Open
    from Indigo sidecar", coordinate-grid note, validity badges,
    molecular-weight chips, "Browse all fragments" or models counter, and no
    disabled placeholder for any of them.
15. **Browser fallback.** `pnpm dev` in a normal browser: the backstage opens,
    New and the template cards work in memory, Save/Export download, Open/Import
    need the desktop picker, Ketcher's own toolbar Settings dialog still works,
    and the About app version comes from the compiled constant with Indigo/port
    `Unavailable`. The console stays free of errors.

### Recent structures

Run against the desktop build (`task run`) with at least three real `.ket` files
on disk.

1. **Real rows.** Open the backstage and scroll Welcome below the template grid:
   under the `RECENT STRUCTURES` heading the compact table lists the most recent
   documents, newest first, capped at five, with the columns Structure Name,
   Format, Size, Indigo Validation, Last Modified and Actions. Compare one row
   with `ls -l`/`stat`: the size matches the byte count and Last Modified matches
   the file's mtime, as `Today, HH:MM` (24-hour, local), `Yesterday` or
   `Mon D, YYYY` (en-US), Format is `KET` and the name is the file base name
   (full path in the hover title). With no recent entries the pane shows the
   muted `No recent structures` row instead of data rows.
2. **Validation badge.** Duplicate a valid `.ket`, add a valence error (for
   example a carbon drawn with five bonds) and open the backstage: the valid row
   reads **Valid** in green and the broken row reads **Warnings** or **Invalid**
   in amber/red, matching the error Indigo reports. A file that cannot be parsed,
   a deleted file and an unavailable editor show the muted `—` badge, never
   Valid or Invalid; no badge appears without the matching check result.
3. **Cached thumbnail.** Open a document for the first time and note the sidecar
   log line for `POST /v2/indigo/render`. The row shows a 40 × 32 px SVG
   thumbnail and
   `<appDataDir>/previews/` now holds one `<64-hex>.svg` whose name matches the
   SHA-256 of the UTF-8 molfile derived from that `.ket`. The exact
   `previewFilePath` composition (`appDataDir` + `previews` + `<hash>.svg`) is
   covered manually here. Close and reopen the backstage: the thumbnail
   is instant, a second identical `.svg` is not written and no new render request
   appears in the sidecar log. A failed render leaves the neutral placeholder and
   writes no file.
4. **Missing file.** Rename or delete one recent `.ket` and reopen the backstage:
   its row stays, shows `—` for Size and Last Modified, the muted `—` badge for
   validation and the neutral thumbnail, and clicking **Open** surfaces the
   in-app error without removing the row or inventing values. Restore the file
   and reopen: the real size, date, validation and thumbnail return.
5. **`.ket` untouched.** Record the file's hash and mtime, open the backstage,
   let the table stat, validate, render and reopen the row, then compare: the
   `.ket` content, mtime and format are unchanged and the file contains no
   preview, validation or thumbnail field. Thumbnails exist only under
   `<appDataDir>/previews/`.

### Packaging

- AppImage extracts to a minimal AppDir: only our libraries, no GTK/WebKit/
  Wayland.
- `.deb`/`.rpm` install into `/usr/bin` and `/usr/lib/chemistry-draw`.
- No `libstdc++`/`libgcc_s` inside any artifact.
- No bundled `libfontconfig*`, `libfreetype*`, `libexpat*`, `libpng*` or
  `libbrotli*` inside any artifact: the distribution provides them.

---

## 3. Reviewer checklist

The reviewer agent must verify:

- [ ] Harness passes (`node scripts/harness.mjs` exits 0)
- [ ] TypeScript clean (`pnpm exec tsc --noEmit`)
- [ ] ESLint clean (`pnpm run lint`)
- [ ] Prettier clean (`pnpm run format:check`)
- [ ] Rust formatting clean (`cargo fmt --all --check`)
- [ ] Clippy clean (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Sidecar tests green (`cargo test -p indigo-server`)
- [ ] Activity tasks are phased docs → test → implement → review, in order, and
      `node --test scripts/lib/activity-policy.test.mjs` passes
- [ ] Sequential status: no task is `in_progress` or `done` while an earlier
      task is not `done`
- [ ] New behaviour has a test that would fail without the change
- [ ] Save/Save As write `.ket` only; Export never changes path or format
- [ ] File commands live in the File menu at the left of the tab strip (no
      app-owned toolbar, dock or `customButtons`), its trigger shows the 16 px
      `currentColor` icon, Open… accepts `.ket` only and Import… routes
      structures through `importStructure`, Ketcher's native Open stays visible
      while the native Save As entry is hidden through the `buttons` config,
      remaining library saves write through Tauri, and the `file-saver` alias is
      the only third-party override
- [ ] Recent documents are stored in `localStorage` under
      `chemistry-draw.recent`, deduped, capped at 10 and pruned with an in-app
      error when a file is missing
- [ ] The backstage replaces the loading splash on every launch, keeps the
      editor mounted while tabs restore, and Back to editor/Escape return to the
      same tab and canvas; the top bar shows only the `Chemistry Draw` brand line
      (no `| Backstage` suffix) and no Back to Editor control; the
      rail is a `nav` with `aria-current` and four
      labelled buttons (Welcome, Open, Models, About) each with a
      16 px `currentColor` line icon, the overlay is `role="dialog"`/`aria-modal`
      with a focus trap, and the home button sits before File outside the tablist
- [ ] The backstage exposes only real capabilities: Welcome's actions and the
      four-card subset of Ketcher's real Structure Library
      entries (`FunctionalGroupsProvider` + `SaltsAndSolventsProvider`, KET per
      entry) map to existing New/Open/Import and `setMolecule` loads; the
      actions form a horizontal wrapping row of at most four content-sized
      buttons (never a full-width vertical column); the grid
      shows exactly four cards at any width and re-randomizes on each open; with
      no document (only an untouched empty tab) Back to editor is absent and
      Blank canvas is primary, and with a document Back to editor is primary and
      labelled with the active tab; each card
      shows a Ketcher-rendered SVG preview (SGroup-free, so the structure with
      its bonds and no abbreviation or brackets; cached, loading
      spinner and error placeholder), name, abbreviation and group chip and
      opens a new tab with the original entry KET; an empty library
      shows `No templates available` with no curated fallback; opening the
      backstage or switching tabs cancels an armed template tool via Escape to
      the Ketcher root; an unknown section id falls back to Welcome instead of a
      blank pane; Open renders the same Recent structures table as Welcome
      (six columns, shared loader and loading/empty states) with its optional
      Remove action and the open-tabs list below; Models
      sits between Open and About as an empty reserved pane with a note and no
      list or actions; the backstage has no Settings section and keeps no
      settings state (settings live only in Ketcher's toolbar dialog); About has
      no fake build, IUPAC or model data and matches `/v2/info`
- [ ] Documents live in tabs over a single Ketcher instance: tabs hold file
      state, switching uses `getKet` → loading flag → `setMolecule`, per-tab
      snapshots plus `index.json` are written/flushed safely, launch restores the
      set silently, and the close guard follows the matrix (Save only for the
      single active dirty tab, otherwise Discard/Cancel)
- [ ] New dialogs are in-app components with Ketcher tokens, `role="dialog"`,
      `aria-modal`, focus trap and Escape handling — no new Tauri native dialog
- [ ] `docs/architecture.md` / `docs/conventions.md` respected
- [ ] No debug prints, no vendored binaries, no context-less TODOs
- [ ] Docs updated when behaviour, routes, or commands changed
