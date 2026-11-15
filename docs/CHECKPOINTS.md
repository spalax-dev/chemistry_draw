# CHECKPOINTS — Final State Evaluation

> In multi-agent systems, the path is not evaluated, the destination is.
> These are objective checkpoints a judge (human or AI) can use
> to decide if the project is healthy.

## C1 — Harness is Complete

- [ ] Base files exist: `AGENTS.md`, `scripts/harness.mjs`,
      `scripts/build-harness.mjs`, `scripts/lib/activity-policy.mjs`,
      `scripts/lib/activity-policy.test.mjs`, `activities.json`,
      `progress/current.md`.
- [ ] Docs exist: `docs/architecture.md`, `docs/conventions.md`,
      `docs/verification.md`, `docs/testing.md`.
- [ ] `node scripts/harness.mjs` exits with code 0.

## C2 — State is Coherent

- [ ] At most one activity in `in_progress` in `activities.json`.
- [ ] Every task declares a valid `phase` (`docs`, `test`, `implement`,
      `review`) and phases are non-decreasing in task order.
- [ ] Non-`docs` activities contain docs, test, implement and review phases;
      `docs` activities contain docs + review and no test/implement tasks.
- [ ] `review` tasks use the `reviewer` agent; docs/test/implement use
      `implementer`.
- [ ] Every `done` activity has all tasks done; every `in_progress` activity
      has exactly one `in_progress` task.
- [ ] Every `done` activity has associated passing tests (or, for docs/chore,
      the relevant harness blocks).
- [ ] `progress/current.md` is empty or describes the active session (no
      leftovers from previous sessions).

## C3 — Code Respects Architecture

- [ ] Layer rules from `docs/architecture.md` hold: `transport/` does not call
      `ffi/`, the host contains no chemistry, `unsafe` stays in `ffi/`.
- [ ] No new native libraries or `.so` files committed to git.
- [ ] No debug `println!`/`dbg!` left behind; no TODOs without context.

## C4 — Verification is Real

- [ ] `src-tauri/sidecar/src/tests/` covers the modules touched by the activity.
- [ ] Tests assert observable contracts (status + body), including negative paths.
- [ ] `cargo test -p indigo-server` shows > 0 tests and all green.
- [ ] `pnpm exec tsc --noEmit` passes.
- [ ] `pnpm run lint` and `pnpm run format:check` pass.
- [ ] `cargo fmt --all --check` and
      `cargo clippy --workspace --all-targets -- -D warnings` pass.
- [ ] Shell scripts pass `shellcheck --severity=warning`.

## C5 — Session Closed Properly

- [ ] No suspicious untracked files (`*.tmp`, build artifacts outside
      `.gitignore`, generated `src-tauri/lib/`).
- [ ] `progress/history.md` has an entry for the last session.
- [ ] The last worked activity reflects its correct state.

## C6 — Windows Build Without Imago

- [ ] `scripts/fetch-windows-libs.ps1` pins Indigo 1.46.0, verifies SHA-256 and
      never vendors DLLs/`.lib` files.
- [ ] Windows CI (`windows` job) builds and smoke-tests the sidecar: empty
      `imago_versions`, `imago_worker.found = false`, `/v2/imago/uploads` 404.
- [ ] NSIS installer is uploaded as an artifact.
- [ ] Windows docs state the no-Imago limitation and the build commands.
- [ ] Linux harness and packaging metadata remain green.

## C7 — Docs → Test → Implement → Review

- [ ] Every activity task carries a `phase` in
      `docs | test | implement | review`.
- [ ] Non-`docs` activities declare docs → test → implement → review in that
      order; `docs` activities declare docs → review only.
- [ ] New behaviour has a failing-test (RED) evidence path before its
      implementation, per `docs/testing.md`.
- [ ] No task is `in_progress` or `done` while an earlier task is not `done`
      (sequential status enforcement).
- [ ] `node --test scripts/lib/activity-policy.test.mjs` passes, including
      missing-phase, wrong-order, docs-only, sequential-status and status
      cases.
- [ ] The harness block 3 runs the policy tests and rejects an invalid
      `activities.json`.

## C8 — Document and Autosave Contract

- [x] `.ket` is the only save format: Save and Save As write `.ket`, while
      Export is the only route to Molfile V2000/V3000, SMILES, InChI, SVG and
      PNG, and never changes the document path or format.
- [x] The window title shows the document name (or `Untitled`) plus a dirty
      marker; a successful Save, Open or New clears the dirty state.
- [x] Opening a `.ket` file gives a clean document with that path; opening
      `.mol`/`.smi`/`.sdf`/`.rxn` imports through Ketcher, leaves `path` `null`
      and keeps the document dirty.
- [x] Autosave writes `.ket` plus metadata into the app data dir only while
      dirty, debounced and on a slow interval, never to the user's file; Save,
      New and Open rewrite the snapshot as clean so the tab set restores, and
      only closing a tab or Discard clears it. An in-flight write cannot
      recreate a snapshot after that cleanup.
- [x] The tab set is restored silently on launch from `index.json` and each
      tab's snapshot; there is no recovery prompt. A missing or unreadable
      original still restores (Save recreates the file).
- [x] Closing with unsaved changes is guarded by an in-app Save/Discard/Cancel
      dialog; Cancel keeps the window open and Save writes before closing. New
      and Open reuse the same prompt before replacing a dirty document.
- [x] Recovery, close guard and feature errors are in-app dialogs styled with
      Ketcher tokens, with `role="dialog"`, `aria-modal`, focus trap, initial
      focus and Escape handling; no new Tauri native `message`/`confirm`.
- [x] Pure helpers (title/dirty/names, save vs export, autosave scheduling,
      write generation, recovery decision, close guard) are covered by Vitest,
      and the manual checklist in `docs/verification.md` §2 passes.
- [x] Browser fallback: Save and Export download files; no autosave, recovery
      prompt or close guard.
- [x] `src-tauri/capabilities/default.json` scopes `$APPDATA/**` for
      `<appDataDir>/recovery` and `$HOME/**` for restored documents, with no
      bare `**` entry, so autosave and re-saves raise no `forbidden path` WARN;
      the capability contract test guards the scopes and the fs command list.

## C9 — Ketcher Toolbar Integration

> Superseded by C12: the File menu replaces the toolbar custom buttons, and
> Ketcher's native Save As is hidden while its native Open stays visible.

- [x] No app-owned toolbar, dock or floating control group exists; Save, New
      and Export render as Ketcher toolbar `customButtons` with sentence-case
      titles and icons that inherit the toolbar button colour (transparent
      `imageLink` painted by a CSS mask, Ketcher's native 28/32/40 px metrics,
      no hard-coded icon colour).
- [x] `CUSTOM_BUTTON_PRESSED` actions dispatch by id: Save writes `.ket` to the
      current path (Save As when untitled), New reuses the dirty guard and
      clears the snapshot, Export opens the in-app format dialog without
      touching path or format.
- [x] `Ctrl+S` is the app Save and Ketcher's `Mod+S` dialog stays shut;
      `Ctrl+Shift+S` opens Save As; `Ctrl+O` and `Ctrl+N` still work.
- [x] Ketcher's native **Save As…** entry is hidden through the `Editor`
      `buttons` config (`buttons.save.hidden`, `src/ui/editorButtons.ts`; no CSS
      or DOM hiding), so Export is the only format route; any remaining library
      save goes through the Vite `file-saver` alias (`src/fileSaver.ts`) to the
      Tauri filesystem or the export dialog (§5.7.1), while the native save
      dialog and its image-save entry are hidden; `node_modules/` is untouched.
- [x] The pure routing helper (`.ket` → document save, other extensions →
      export save, no Tauri/no handler → download) has Vitest coverage and was
      RED before implementation.
- [x] The manual checklist in `docs/verification.md` §2 "Toolbar integration"
      passes, including the browser fallback.

## C10 — Bundled vs Host Native Libraries

- [x] The Linux bundled set is Indigo, Indigo Renderer, Imago, minimal OpenCV
      and non-platform deps only; `libfontconfig*`, `libfreetype*`, `libexpat*`,
      `libpng*` and `libbrotli*` are excluded by the `scripts/build-libs.sh`
      dependency skip list, the Taskfile `libs` copy and
      `scripts/bundle-libs.sh` `SKIP_PATTERNS`, guarded by the test in
      `docs/testing.md` §4.2.
- [x] `src-tauri/lib/linux-x86_64` contains none of those files, `ldd` resolves
      them from the host, and a PNG render logs no `Fontconfig warning` (manual
      step in `docs/verification.md` §2).
- [x] `.deb`/`.rpm`/AppImage ship no platform font/PNG libraries and rely on the
      distribution's copies, which GTK already pulls in, as documented in
      `docs/architecture.md` §7.

## C11 — Document Tabs

> Superseded in part by C12: Open… and Import… are separate File menu entries
> instead of one Open entry dispatching by extension.

> Supersedes the single-document autosave and close-guard points in C8.

- [x] Tabs hold file state (`{ id, name, path, ket, dirty }` plus the active
      id) and a single Ketcher instance renders them; no second editor, canvas
      or per-tab toolbar is mounted.
- [x] Switching serializes the outgoing tab with `getKet`, sets a `loading`
      flag, loads the target with `setMolecule` and clears the flag; a
      programmatic load never marks the tab dirty.
- [x] Each tab owns `recovery/tabs/<id>.ket`, `<id>.json` and the shared
      `index.json` (`{ order, activeId }`); a switch flushes the outgoing tab,
      `index.json` is written last, and a stale or late write is discarded so
      rapid switching cannot write one tab's content into another.
- [x] Launch restores content, paths, order, dirty flags and the active tab
      silently; a missing or corrupt snapshot yields an empty tab and never an
      error dialog.
- [x] Save, Save As and Export act on the active tab; New always opens a new
      tab; Open reuses an untouched empty tab or opens a new one and never
      prompts for a dirty tab.
- [x] Open is **one entry** that dispatches by extension: `openProject` for
      `.ket` (`path`, `name = base(path)`, clean) and `importStructure` for
      `mol`/`smi`/`inchi`/`sdf`/`rxn` (`path: null`, `name = base(file)`,
      clean); both reuse an untouched empty tab, otherwise add one.
- [x] A tab is named by its opened or imported file: the title is the `path`
      base name, then `name`, then `Untitled`; an imported tab is never
      `Untitled`, never dirty on open, and its first Save is a Save As prefilled
      `<name>.ket`; Export names files `<name>.<ext>`.
- [x] `<id>.json` persists `name`; an entry without it falls back to its path
      base name, and a legacy import still restores as `Untitled` with its
      content intact.
- [x] The close guard follows the matrix: no dirty tab closes; exactly one dirty
      **active** tab offers Save / Discard / Cancel; more than one dirty tab, or
      the only dirty tab being inactive, offers Discard / Cancel only with copy
      explaining several documents have unsaved changes.
- [x] Closing a single dirty tab (`×` or middle click) activates it first when
      needed and prompts Save / Discard / Cancel for that tab; Discard clears
      only that tab's snapshot.
- [x] The strip sits above Ketcher's toolbar and uses the Ketcher tab tokens
      (`#fff` active and regular, `#00838f` hover, `#eff2f5` content) with a
      dirty dot, a close control and a `+` button. The 1 px `#cad3dd` separator
      is drawn in two layers: the strip's `inset 0 -1px 0` box shadow covers the
      padding, gaps and the area after the last tab, and every inactive tab
      draws its own `borderBottom`, while the active tab sets
      `borderBottom: none` and its white background covers the line. The line is
      continuous, exactly 1 px and absent only under the active tab.
- [x] The pure tab model and the close-guard matrix are covered by Vitest and
      were RED before implementation.
- [x] The manual checklist in `docs/verification.md` §2 "Document tabs" passes.

## C12 — File Menu

- [x] A File button is the first element of the tab strip, left of the first tab,
      shares the strip height and uses Ketcher tokens; there is no app-owned
      toolbar, dock or `customButtons` registration.
- [x] The menu offers New, Open…, Import…, Save, Save As…, Export…, a separator
      and Recent documents; items are keyboard reachable, and Escape or an
      outside click closes the menu.
- [x] Open… filters `.ket` only and routes through `openProject`; Import… lists
      `mol`/`smi`/`inchi`/`sdf`/`rxn` and routes through `importStructure`,
      leaving `path: null` until the tab is saved as `.ket`.
- [x] Save writes the active tab's `.ket` path (Save As when untitled) and Save
      As adopts the chosen path; Export never changes path or format.
- [x] Recent documents persist in `localStorage` under `chemistry-draw.recent`,
      dedupe by exact path, cap at 10, record on Open and on a successful Save,
      and prune a missing file with an in-app error.
- [x] The File trigger shows a Ketcher-style 16 px line icon in `currentColor`
      before its `File` label (1.5 stroke, 6 px gap, no colour literal).
- [x] Ketcher's native **Open** stays visible and loads a structure into the
      current canvas without creating or renaming a tab, adopting a path or
      recording a recent document; File → Open… remains the `.ket` project open
      that adopts name and path; only the native **Save As** entry is hidden
      through `buttons.save.hidden`; the custom buttons, `src/ui/toolbarIcons.ts`
      and the injected toolbar style stay removed.
- [x] The pure recent-list helpers and the File menu item model are covered by
      Vitest and were RED before implementation.
- [x] The manual checklist in `docs/verification.md` §2 "File menu" passes and
      `node scripts/harness.mjs` is green.

## C13 — Path Uniqueness

- [x] A `.ket` path belongs to at most one tab: Open… and a recent entry that
      target an open path activate the existing tab (the single editor switches
      to it) and show the `Already open` notice, with no new tab, no re-read of
      the file, no snapshot for a new tab and no duplicate recent entry.
- [x] Save As to a path owned by another tab is refused with the same notice and
      writes nothing; saving the active tab to its own path still works.
- [x] `pathKey` / `findTabByPath` in `src/tabs.ts` normalise separators, ignore a
      trailing separator, compare Windows drive-letter paths case-insensitively
      and POSIX paths case-sensitively.
- [x] The helper and the guard decisions are covered by Vitest and were RED
      before implementation; the manual step in `docs/verification.md` §2
      "File menu" passes.

---

**How to use this file:** a reviewer agent
(`.opencode/agent/implementation-reviewer.md`) goes through each checkbox, marks
`[x]` or `[ ]`, and rejects session close if any boxes in C1–C13 remain empty.
