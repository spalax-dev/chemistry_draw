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
the Rust commands above; `node scripts/harness.mjs` runs everything. Once Vitest
is configured (`docs/testing.md` §5), `pnpm test` and the harness block that
runs it must also be green.

Packaging or dependency changes additionally require:

10. `task packages` — builds `.deb`, `.rpm` and the AppImage.
11. `dpkg-deb -I dist-packages/*.deb` and `rpm -qpR dist-packages/*.rpm` —
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
10. **New and Open.** New opens a new empty tab and leaves the previous tab
    untouched. Open a `.ket`: the file lands in an untouched empty tab (or a new
    one), the path and title follow it and the tab is clean. Open a
    `.mol`/`.smi`: it imports through Ketcher, the title is `Untitled` and the
    tab is dirty. Open never prompts for a dirty tab.
11. **Browser fallback.** `pnpm dev` in a normal browser: tabs work in memory,
    Save and Export download files (no dialog, no path), nothing is saved or
    restored across reloads, there is no close guard, and the console stays
    free of errors.
12. **Autosave scope.** Draw or edit a structure and let the debounce fire
    (about 2 s). `<appDataDir>/recovery/tabs/` contains that tab's `.ket` and
    `.json` plus `index.json`, and the log has no `forbidden path` WARN naming
    `recovery` or `allow-mkdir`.
13. **Restored document scope.** Repeat step 5 with a document that has a saved
    `path`, relaunch and press `Ctrl+S` without opening a dialog: the restored
    tab is written to its original path, the dirty dot disappears, and the log
    has no `forbidden path` WARN for that path. With the original file deleted,
    restore keeps the path and the first Save recreates the file.

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
    changes only that tab's path; Export changes no tab; New always adds a tab
    and never replaces or discards the active one.
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

### Toolbar integration

Run against the desktop build (`task run`) unless a step says browser.

1. **Toolbar only.** The editor shows no control group in the bottom-left
   corner and no app-drawn toolbar anywhere. Ketcher's top toolbar carries Open
   plus exactly three extra buttons: Save, New and Export. There is no
   **Save As…** entry.
2. **Icon styling.** Save, New and Export match the neighbours' metrics and
   inherit their colour; the app never paints a fixed icon colour.
   - **Default:** each glyph is the same grey as Ketcher's own icons
     (`#333333`), with no lighter, darker or thicker icon among the buttons.
   - **Hover:** hovering a button turns its glyph Ketcher's teal (`#167782`)
     together with the button; moving away restores the grey.
   - **Active:** pressing a button shows the same active-state colour as a
     native icon pressed at the same time.
   - **Size:** at 100 % the buttons and glyphs match the native 28/32/40 px
     controls and fill their box without clipping; at 125 % zoom they scale with
     the toolbar and stay sharp.
   - **Optical size:** each glyph's ink spans the same ~15x15 live area as the
     neighbouring native icons and carries the same 1.5-unit outline weight, so
     the optical size matches the neighbouring native icons (no heavier, no
     filled glyph, none edge to edge).
   - **Titles:** the tooltips are still `Save`, `New` and `Export`, and the Save
     glyph is visually distinct from a floppy disk glyph.
3. **Save.** Draw a structure, click Save with an untitled tab: the Tauri Save
   As dialog appears with `untitled.ket`; choose a path and confirm the file is
   `.ket` JSON and the tab's dirty dot is gone. Edit and click Save again: no
   dialog, the same file is overwritten.
4. **New.** With unsaved changes, click New: a new empty tab opens, the previous
   tab keeps its content and dirty dot, and no dialog appears. The previous
   tab's snapshot under `<appDataDir>/recovery/tabs/` still exists.
5. **Export.** Click Export: the existing in-app format dialog opens and lists
   Molfile V2000, Molfile V3000, SMILES, InChI, SVG and PNG. Export any of
   them; the active tab's title and its `.ket` path are unchanged and a
   following Save still writes the `.ket` file.
6. **Shortcuts.** `Ctrl+S` saves the active tab, `Ctrl+Shift+S` opens Save As,
   `Ctrl+O` opens a file (reusing an untouched empty tab) and `Ctrl+N` opens a
   new tab. `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs. `Ctrl+S` does **not** open
   Ketcher's native Save As dialog.
7. **No native Save As.** Ketcher's top toolbar has no **Save As…** entry, and
   no shortcut opens its Molfile save dialog. The entry is hidden through
   `buttons.save.hidden`; there is no CSS `display: none` and no DOM query in
   the app.
8. **No native save dialog.** Neither the toolbar nor any shortcut opens
   Ketcher's Save As dialog, so its built-in image-save entry is unreachable.
   Use the app **Export** once for SVG and once for PNG: each opens the Tauri
   save dialog, writes the file to disk and triggers no browser download.
9. **Browser fallback.** `pnpm dev` in a normal browser: Save and Export
   download files, no dialog opens, `path` stays `null`, and the console stays
   free of errors.

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
- [ ] Document commands are Ketcher `customButtons` (no app-owned toolbar or
      dock), the native Save As entry is hidden through `buttons.save.hidden`,
      remaining library saves write through Tauri, and the `file-saver` alias is
      the only third-party override
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
