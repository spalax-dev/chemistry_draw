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
- [x] Save, Save As and Export act on the active tab; New reuses an untouched
      empty active tab and otherwise opens a new one (it never stacks an empty
      canvas); Open reuses an untouched empty tab or opens a new one and never
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

## C14 — Backstage (activity 21, historical)

> **Superseded by C15.** This section records what activity 21 shipped. The
> Welcome pane it describes (four fixed cards: Benzene Ring, Cyclohexane Chair,
> Peptide Fragment, Reaction Scheme) is no longer current — C15 replaced it with
> the responsive random subset of the eight ring templates plus **More
> templates** and **Back to editor**. Do not treat the Welcome bullet below as
> the current UI.

- [x] The backstage replaces the `Loading chemistry editor...` splash from the
      first frame, stays until **Back to Editor**/Escape, and shows on every
      launch; Ketcher mounts and the tab set restores underneath without being
      blocked or dismissed by readiness.
- [x] A house button at the left of the tab strip, before File and outside the
      `role="tablist"`, opens the backstage; **Back to Editor** and Escape
      return to the same active tab, canvas, dirty flags and tab order. (The
      home button is covered while the overlay is open, so it is the way in,
      not the way back.)
- [x] The rail is a `nav` of real buttons (not a tablist) with five sections in
      order — Welcome, Open, Models, Settings and About (ids `welcome`, `open`,
      `models`, `settings`, `about`, default `welcome`) — roving focus and
      `aria-current="page"`, each button showing a 16 px `currentColor` line icon
      (home, folder-open, cube, sliders, info) before its label; Models is empty
      (heading and a muted note only, no list, no actions and no fake models,
      versions or download counters); the overlay is `role="dialog"`,
      `aria-modal`, with initial focus, a focus trap, Escape and focus return.
- [x] **Historical (activity 21):** Welcome shows the `Welcome` title, the
      `Start from a blank canvas or a template.` subtitle, Blank canvas
      (creates a tab), Import structure… and Open project…, then a four-column
      `TEMPLATES` grid of Benzene Ring, Cyclohexane Chair, Peptide Fragment and
      Reaction Scheme; each card shows an inline SVG `currentColor` line preview,
      the name, a one-line description and a tag chip (`Aromatic`, `Aliphatic`,
      `Dipeptide`, `Esterification`), and clicking it loads the structure into a
      new dirty tab titled after the template (e.g. `Benzene Ring*`) with
      `path: null`, then closes the backstage. Open lists the last 10
      `chemistry-draw.recent` paths with Open and Remove plus the open tabs,
      reusing the path-uniqueness guard, and renders no thumbnail or preview.
      Save, Save As and Export live in the File menu only; the backstage has no
      status strip and its content pane reaches the bottom edge. (This grid is
      superseded by C15; the rest of the section still holds.)
- [x] **Activity 23 — unknown section fallback:** any id outside `welcome`,
      `open`, `models`, `settings` and `about` — a removed id, the retired
      `new`, an HMR-orphaned value — renders **Welcome**. `normalizeSection`
      maps non-section ids to `welcome`, `renderSection`'s `default` branch
      renders the Welcome pane, and opening the backstage after an edit always
      lands on Welcome; no id renders a blank content pane.

> **Activity 24 update.** The Welcome cards now come from Ketcher's real
> Structure Library (functional groups + salts and solvents), with previews
> rendered through Ketcher/Indigo; the curated ring pool is no longer the card
> source. The activity-23 pool statements elsewhere in this file are retained as
> history — the activity-24 checkboxes record the current requirement.

- [x] **Activity 24 — real library source:** the Welcome grid is built from
      `FunctionalGroupsProvider` + `SaltsAndSolventsProvider` after `onInit`,
      mapped to entries with slug ids, name/abbreviation dedupe and a KET per
      entry (`KetSerializer.serializeMicromolecules`); no curated ring list is
      used for cards. A library that yields no entries shows the muted
      `No templates available` line and no invented or fallback card.
- [x] **Activity 24 — rendered previews:** each card preview comes from
      `ketcher.generateImage(entry.ket, { outputFormat: "svg" })`, cached per
      entry for the session, with a muted loading placeholder and a neutral
      `Preview unavailable` state; no hand-drawn, raster or curated preview is
      used.
- [x] **Activity 24 — width subset and insertion:** the visible count stays
      2/4/6/8, `pickTemplates` returns a random distinct subset of library
      entries in library order from an injected RNG (a smaller library shows all
      of it), every open reshuffles, and a card click inserts the entry's KET
      into a new dirty `path: null` tab named after the entry.
- [x] **Activity 24 — tool reset:** opening the backstage or switching tabs
      calls `cancelActiveTool`, which dispatches a bubbling Escape `keydown` to
      `.Ketcher-root` before serializing/loading; no DOM toolbar click, no Redux
      action. No structure follows the cursor after either action.
- [x] **Activity 24 — tests and verification:** the pure entry mapping
      (dedupe/ids/KET/empty input), the random subset and the source contracts
      (Welcome imports no curated pool; `openBackstage`/`activateTabById` call
      the cancel helper) are covered by Vitest and were RED before
      implementation; the updated "Backstage" manual checklist in
      `docs/verification.md` §2 passes and `node scripts/harness.mjs` is green.

> **Activity 26 update.** The Welcome grid is now exactly **four** cards at every
> width, the action hierarchy depends on whether a **document** exists, and the
> top-bar Back to Editor is gone — the rail's **Exit Backstage** is the way back.
> The activity-24 width-subset and top-bar statements above are historical; the
> activity-26 checkboxes record the current requirement.

- [x] **Activity 26 — four cards:** the Welcome grid renders exactly four
      distinct random library entries at every viewport width
      (`TEMPLATE_CARD_COUNT` is `4`), with no 2/4/6/8 width rule, no resize
      listener and no `templateCountForWidth`; a smaller library shows all of
      it and every backstage open re-randomizes.
- [x] **Activity 26 — first run vs document:** `WelcomeSection` derives
      `hasDocument` from the tab set with `isUntouchedTab` (the open-reuse
      predicate), so an untouched empty tab is not a document. With no document
      Welcome hides Back to editor and renders **Blank canvas** as the primary
      action; with a document Back to editor is primary and labelled with
      `tabTitle(active)` (name plus `*`), and Blank canvas is secondary.
- [x] **Activity 26 — top bar:** the backstage top bar shows only the logo and
      the `Chemistry Draw | Backstage` title; it has no Back to Editor control.
      The rail's **Exit Backstage** and `Escape` remain the ways back.
- [x] **Activity 26 — tests and verification:** Vitest pins the four-card count,
      the `isUntouchedTab` action branch and the source contract that the top bar
      has no exit button, RED before implementation; the updated "Backstage"
      checklist in `docs/verification.md` §2 passes (first launch has no Back to
      editor and highlights Blank canvas; after a document exists it is primary;
      no top-right control) and `node scripts/harness.mjs` is green.
- [x] Settings binds only to `ketcher.settingsService` with the curated keys and
      real unit keys/ranges/options from `docs/architecture.md` §5.11.1, applies
      live, persists through Ketcher, and offers the ACS preset and Reset to
      defaults; no invented option exists.
- [x] About shows the app, Ketcher and React versions, the Indigo version and
      sidecar port from `/v2/info`, the platform, the runtime row (`Desktop
(Tauri)` or `Browser`) and the license links (Ketcher Apache-2.0, Indigo
      Apache-2.0, ONNX Runtime MIT), with `Unavailable` for a missing source and
      no fake build SHA, IUPAC version or models counter.
- [x] The templates grid is the only Stitch mock surface present and it is backed
      by real structures; other Stitch-invented content is absent: "Open from
      Indigo sidecar", coordinate-grid note, validity badges, molecular-weight
      chips, "Browse all fragments" and the models counter. The reserved Models
      section is not such a counter: it is an empty placeholder with no data.
- [x] All backstage surfaces use `src/ui/tokens.ts` only (surface/rail/content,
      `#cad3dd` borders, teal accent, 3/8 px radii, Roboto 12/14 px) and never
      a colour literal.
- [x] The pure section list, settings descriptors, value formatting and the
      version helper are covered by Vitest and were RED before implementation;
      the manual "Backstage" checklist in `docs/verification.md` §2 passes and
      `node scripts/harness.mjs` is green.

## C15 — Welcome Refinement

> **Activity 23 update.** The Welcome pool is now sixteen ring templates and an
> unknown section id falls back to Welcome. The eight-template and pool-size
> statements below describe the activity-22 state; the activity-23 checkboxes in
> C14 record the current requirement.
>
> **Activity 24 update.** The curated pool is gone as a card source: Welcome
> cards now come from Ketcher's real Structure Library with rendered previews and
> the tool reset. The pool statements below are historical; the activity-24
> checkboxes in C14 are the current requirement.
>
> **Activity 26 update.** The visible count is now exactly four at every width
> (no 2/4/6/8 rule) and the top-bar Back to Editor is gone; the activity-26
> checkboxes in C14 record the current requirement.
>
> **Activity 27 update.** New/Blank canvas now reuses the untouched active tab,
> and emptiness is a semantic check because Ketcher serializes a pretty-printed
> empty KET with `ket_version`.

- [x] The Welcome pool is exactly the eight Ketcher ring templates — Benzene
      Ring, Cyclopentadiene, Cyclohexane, Cyclopentane, Cyclopropane,
      Cyclobutane, Cycloheptane and Cyclooctane — with the names, SMILES, tags
      and one-line descriptions in `docs/architecture.md` §5.11; the old Peptide
      Fragment and Reaction Scheme cards are gone from the pool.
- [x] The visible count is pure and responsive: 2 below 640 px, 4 at 640–899,
      6 at 900–1239 and 8 at 1240 px or wider; `pickTemplates` returns distinct
      pool-ordered descriptors from an injected RNG, never duplicates one,
      never exceeds the pool and re-randomizes on every backstage open and on
      breakpoint changes.
- [x] **More templates** sits beside the `TEMPLATES` heading, is disabled until
      the editor is ready, closes the backstage first and opens Ketcher's real
      Structure Library through `MODAL_OPEN` (`templates`, `prop.tab: null`) in
      `src/ketcherOptions.ts`; selecting a template activates the template tool
      and closes the dialog; there is no fake gallery.
- [x] **Back to editor — `<active tab>`** is the first, primary Welcome action
      when tabs exist, carries the active tab name plus `*` while dirty, and
      only closes the overlay (no save, no activation, no canvas change); it is
      absent for an empty tab list, and the top-bar Back to Editor remains.
- [x] `DEFAULT_BACKSTAGE_SECTION` is `welcome`, `Backstage` uses
      `useState(DEFAULT_BACKSTAGE_SECTION)` and is unmounted on close, so
      reopening after an edit always shows Welcome; a test pins the default and
      documents the committed activity-21 `new` default as the blank-pane cause.
- [x] The pure helpers, the eight-descriptor pool, the source/wiring contracts
      for More templates, Back to editor and the responsive `WelcomeSection`
      grid, and the default reset are covered by Vitest and were RED before
      implementation; the updated "Backstage" manual checklist in
      `docs/verification.md` §2 and the live Playwright pass (More templates →
      Structure Library placement, Back to editor → active tab, reopen →
      Welcome) are done and `node scripts/harness.mjs` is green.
- [x] **Activity 27 — reuse rule:** `startNewDocument` computes
      `newDocumentTarget(tabsRef.current)` **before** `getKet`/commit. When it
      returns `reuse`, the outgoing tab is neither committed nor flushed: the
      canvas is reloaded with `EMPTY_KET` only when it still holds a structure
      (behind `loadingRef`), the tab is reset to
      `{ path: null, name: null, dirty: false, ket: EMPTY_KET }`, its snapshot
      and the index are written, the scheduler restarts and no tab is added.
      The `create` branch keeps the existing commit, flush, snapshot and index
      behaviour.
- [x] **Activity 27 — semantic empty check:** `isEmptyCanvasKet` accepts `""`,
      whitespace, `EMPTY_KET`, and any JSON object whose `root.nodes` is an
      empty array (tolerating `connections`/`templates`, so Ketcher's real
      serialized empty KET with `ket_version` counts); malformed JSON, a missing
      `root.nodes` or a non-empty node list is a document. `isUntouchedTab` uses
      it instead of the `EMPTY_KET` byte comparison while keeping
      `path === null && !dirty && name === null`.
- [x] **Activity 27 — tests and verification:** Vitest covers
      `isEmptyCanvasKet` with the real serialized empty KET,
      `isUntouchedTab`/`newDocumentTarget` reuse after a commit and the
      `hasDocument` predicate (`tabs.tabs.some((tab) => !isUntouchedTab(tab))`
      false for empty tabs), RED before implementation; `pnpm test`,
      typecheck, lint, Prettier, `pnpm build` and `node scripts/harness.mjs` are
      green.

---

## C16 — Recent Structures Table

- [x] Welcome renders a compact **Recent structures** table below the four-card
      template grid, under a 10 px uppercase `RECENT STRUCTURES` heading, with the Stitch
      columns in order — Structure Name (40 × 32 px thumbnail + base name under a
      muted `Ketcher document` line, full path in `title`), Format, Size, Indigo
      Validation, Last Modified, Actions (Open) — fed only by the real recent
      list, newest first and capped to the five rows `App` loads; an empty list
      shows the muted `No recent structures` row and no invented row.
- [x] Size and Last Modified come from `stat` (`formatFileSize`,
      `formatModified`), Format and name from the path, and a missing or
      unreadable file keeps its row with `—` size/date, the muted `—` unknown
      badge and a neutral thumbnail; no row shows a placeholder size, date or
      status.
- [x] Indigo Validation comes from `ketcher.structService.check` on the molfile
      derived through `KetSerializer.deserializeMicromolecules` →
      `MolSerializer.serialize`, with the ten documented `types`; empty result is
      **Valid**, non-empty is **Warnings**/**Invalid**, and a parse/check failure
      shows the muted `—` badge. Badges use green/amber/red/gray tokens and the
      exact texts, never an invented status.
- [x] Thumbnails are sidecar SVG renders (`POST /v2/indigo/render` with
      `render-output-format: "svg"`) cached at
      `<appDataDir>/previews/<sha256(molfile)>.svg` (SHA-256 of the UTF-8
      molfile, via `previewFileName`/`contentHash`) and served as data URIs; a
      cache hit skips the render, a failed render shows the neutral placeholder
      and writes nothing, and `.ket` files are never modified or given a preview
      field. The `previewFilePath` composition is covered manually
      (`docs/verification.md` §2).
- [x] `formatFileSize`, `formatModified`, `validationStatus`,
      `previewFileName`/`contentHash` and the pure `buildRecentRow` row model
      (including the missing-stat, unreadable-text and null-check cases) are
      covered by Vitest; the "Recent structures" manual checklist in
      `docs/verification.md` §2 passes and `node scripts/harness.mjs` is green.

- [ ] **Activity 29 — shared Open table:** Open renders the same
      **Recent structures** table as Welcome — the same six columns, thumbnails,
      loading and empty states — fed by the single `App` loader
      (`src/recentStructures.ts`), so no second loader or duplicate
      stat/check/render request exists. The table takes an optional `onRemove`
      that only Open passes, adding a **Remove** text button that prunes the row
      and the stored recent entry while touching no tab or file; Welcome keeps
      **Open** alone. The open-tabs list (Switch) stays below the table in Open.
      Tests pin the shared table reuse, the optional Remove and the retained
      tabs list; `docs/architecture.md` §5.11 and `docs/conventions.md` §6.8
      describe it and the "Open" step in `docs/verification.md` §2 passes.

- [x] **Activity 30 — expanded template previews:** previews render a copy of the
      entry KET with `expanded: true` on every SGroup (nested molecules
      included), produced by the pure `expandSgroupsForPreview`, so Indigo draws
      atoms instead of the `CN`/`OMe` abbreviation; insertion still loads the
      original unexpanded entry KET and no `.ket` file changes. Welcome paints
      four non-clickable skeleton cards immediately, builds the library in an
      effect after paint and caches it module-level for the session, and a
      preview shows a small inline SVG spinner while it renders. Tests pin the
      SGroup expansion (including invalid JSON), the preview-vs-insertion split
      and the loading markers; the "Templates come from the real library" step
      in `docs/verification.md` §2 passes and `node scripts/harness.mjs` is
      green.

---

**How to use this file:** a reviewer agent
(`.opencode/agent/implementation-reviewer.md`) goes through each checkbox, marks
`[x]` or `[ ]`, and rejects session close if any boxes in C1–C16 remain empty.
