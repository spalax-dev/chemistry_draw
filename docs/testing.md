# Testing Policy

> How to write tests that actually catch bugs.
> A test's value = its ability to **fail when the code is wrong**.

---

## 0. Delivery order: docs → test → implement → review

Every change follows this order; a test is never written before the docs that
define the contract, and implementation never starts before a failing test
exists.

1. **Docs** — real work, not an afterthought: update `README.md`,
   `docs/architecture.md`, `docs/conventions.md`, `docs/verification.md` or
   `docs/CHECKPOINTS.md` as the change requires, and describe the expected
   behaviour and how it will be verified.
2. **Test** — add the failing test and confirm RED (section 2).
3. **Implement** — write the minimal code to make it pass, confirm GREEN, then
   refactor.
4. **Review** — the reviewer checks the docs, the RED→GREEN evidence, the phase
   order and the harness (`docs/verification.md`).

Enforcement:

- Every task in `activities.json` declares `phase`:
  `docs | test | implement | review`.
- `scripts/lib/activity-policy.mjs` validates the phase order
  (non-decreasing) and the agent mapping. `node scripts/harness.mjs` runs it
  and `scripts/lib/activity-policy.test.mjs` before allowing work to proceed.
- **Docs-only exception**: an activity with `type: "docs"` runs `docs` →
  `review` and must not contain `test` or `implement` tasks.

The reviewer rejects work with no docs task, no failing test before the
implementation, or phases out of order.

---

## 1. Core principle: the mutation mindset

Before writing a test, ask: _"If this function were broken — deleted, returned
the wrong value, or crashed on input X — would this test fail?"_

If the test would still pass, it has no value. Rewrite it or delete it.

---

## 2. Test-first (Red-Green-Refactor)

Backend behaviour is written **test-first**, after the docs task. The test is
the contract; the code is what makes it pass.

1. **Write the test** in `src-tauri/sidecar/src/tests/` — it must fail on the
   current code (or fail to compile because the symbol does not exist yet).
2. **Run it → confirm RED**
   `cargo test -p indigo-server <name>`.
3. **Implement** the minimal code to make it pass.
4. **Run → confirm GREEN**.
5. **Refactor** (tests stay green).

Enforcement:

- A task may be `in_progress` or `done` only when every earlier task in the
  activity is `done` (docs → test → implement → review).
- The reviewer asks: _"would this test have failed before the implementation?"_
  If not, the test was not written first (or is too weak) — reject.

---

## 3. Structure

- **AAA**: Arrange (build the request/state) → Act (call once) → Assert (verify
  the observable outcome).
- **One scenario per test.**
- **Naming**: `test_<unit>_<behavior>_<condition>` — the name states the
  contract (e.g. `corrupted_molfile_returns_400`).

---

## 4. Sidecar test patterns

Tests live in `src-tauri/sidecar/src/tests/`, one module per domain, registered
in `tests/mod.rs`.

```rust
use crate::tests::*;
use axum::http::StatusCode;

#[tokio::test]
async fn health_reports_status_and_port() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["port"], 9321);
}
```

Rules:

- Use `test_app()` (full router) for endpoint tests; no sockets, no ports.
- Assert both the **status code** and the meaningful body fields.
- Include the negative path: malformed JSON (422/400), invalid molecule (400),
  unknown upload id (404).
- No real network. Native Indigo/Imago are linked, so chemistry tests are real —
  that is the point.
- Imago integration tests may need fixtures; keep them deterministic and skip
  cleanly when no fixture is available.
- Platform-specific behaviour is tested with `#[cfg(windows)]` modules
  (`tests/windows_no_imago.rs` asserts the empty `imago_versions` list and the
  absent Imago routes). They compile locally via cross-target `cargo check` but
  only run in Windows CI.
- Never test private state (`obj.field`); test behaviour.

### 4.1 Capability contract

`src-tauri/capabilities/default.json` is configuration the whole app depends on,
so it gets a contract test alongside the sidecar tests. The test reads the real
file (relative to the repository root) and asserts:

| Assertion              | Expected                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs:scope` entries     | include `$APPDATA/**` and `$HOME/**`, and contain no bare `**` entry                                                                                                                                           |
| fs command permissions | `fs:allow-read-text-file`, `fs:allow-write-text-file`, `fs:allow-read-file`, `fs:allow-write-file`, `fs:allow-mkdir`, `fs:allow-rename`, `fs:allow-remove`, `fs:allow-stat`, `fs:allow-exists` are all granted |

Rules:

- Assert the real files; do not mirror the scope in a fixture. Removing either
  scope entry, reintroducing a bare `**`, or dropping one of the fs commands
  must each make the test fail.
- The test does not launch Tauri; it guards the contract. The end-to-end
  behaviour (no `forbidden path` WARN, saving a restored document) is the manual
  step in `docs/verification.md`, section 2.

### 4.2 Native library skip lists

The scripts that decide which shared libraries are bundled are configuration the
runtime depends on, so a contract test (Vitest, alongside the capability test)
reads the real files and asserts the platform libraries stay host-provided:

| File                     | Assertion                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `scripts/build-libs.sh`  | the dependency skip list names `libfontconfig*`, `libfreetype*`, `libexpat*`, `libpng*` and `libbrotli*` |
| `Taskfile.yml`           | the `libs` copy excludes or removes the same five families                                               |
| `scripts/bundle-libs.sh` | `SKIP_PATTERNS` contains a pattern for each of the five families                                         |

Rules:

- Assert the real files, not a fixture. Deleting one family from any of the
  three must make the test fail, so the three lists cannot drift apart.
- Keep the guards narrow: assert those five families, not a blanket `lib*`.
  A pattern that would also skip `libindigo*`, `libimago*` or `libopencv*` must
  fail the test, because those stay bundled.
- When `src-tauri/lib/linux-x86_64/` exists, assert it contains no matching
  `.so*`; skip that assertion cleanly when the directory is absent (CI does not
  always run `task libs`).
- The test guards the lists, not the renderer. The observable outcome — a PNG
  render with no `Fontconfig warning` and an `ldd` that resolves fontconfig from
  the host — is the manual step in `docs/verification.md`, section 2.

### 4.3 Ketcher patch contract

`patches/ketcher-core@3.18.0.patch` is configuration the editor depends on, so a
contract test (Vitest, alongside the capability test) reads the real patch file
and the installed `dist/` and asserts the guards survive a reinstall:

| Target                                      | Assertion                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patches/ketcher-core@3.18.0.patch`         | contains the `ReBond.getSelectionPoints` half-bond guards for both `dist/application/render/restruct/rebond.js` and `rebond.modern.js`                                          |
| installed `ketcher-core` `rebond.modern.js` | the patched `getSelectionPoints` returns early on a missing half-bond, `getSelectionContour` returns `null` on an empty list, and the plate/`drawHover` helpers no-op on `null` |

Rules:

- Assert the real files, not a fixture. Removing either the `.js` or the
  `.modern.js` hunk, or removing a guard from the installed bundle, must make
  the test fail.
- The test reads the patch text and the installed `node_modules/ketcher-core`
  file; it does not run Ketcher. The end-to-end behaviour — hovering/selecting a
  bond with a stale half-bond without an error flood — is the manual step in
  `docs/verification.md` §2, "Ketcher render robustness".
- Keep the assertions narrow: the `parametrizeUrl` hunk is covered by its own
  upstream regression, so this test names only the ReBond guard symbols and the
  two dist paths.

---

## 5. Frontend

Frontend correctness is verified by `pnpm exec tsc --noEmit`, `pnpm build`, the
Vitest suite for pure helpers below, and the manual checklist in
`docs/verification.md`.

### 5.1 Vitest scope: pure helpers

Vitest is the frontend test runner. The test task adds it (with the `test`
script and a harness block) before the first helper test is written. Tests live
next to the module as `src/<module>.test.ts` and cover **only** pure functions
and constants from `src/tabs.ts`, `src/document.ts`, `src/autosave.ts`,
`src/saveRoute.ts`, `src/recent.ts`, `src/fileMenu.ts`, `src/backstage.ts`,
`src/settingsModel.ts` and `src/ui/tokens.ts` — no DOM, no React rendering.
`src/tabStore.test.ts` is the single documented exception: it mocks the Tauri
fs/path/core modules with an in-memory filesystem (§5.1 rules).

| Helper / module                         | Behaviour under test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tab model                               | creating the first tab requires it to be clean, path-less and active; a second create keeps both tabs and activates the new one; activate changes only the active id; close removes the tab and selects the one to its right, otherwise the one to its left, otherwise a fresh empty tab — never zero tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| tab dirty state (manual: Save/Open/New) | the pure tests cover the model: committing serialized content stores the `.ket` text and keeps the tab dirty, and the dirty count ignores clean tabs. Marking a tab dirty on an editor change and clearing only that tab's `dirty` after Save, Open or New happens in `App.tsx` and is covered by `docs/verification.md` §2, not Vitest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| tab titles                              | `tabTitle` uses the `path` base name first, then `name`, then `Untitled` when both are `null`; the base name drops `.ket`; it **appends `*`** while dirty. The strip removes that asterisk and paints the dirty dot instead, so the visible strip label never contains `*` while the window title and dialog copy do; `tabDisplayName` returns the same title without the `*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| tab snapshots (manual: restore/index)   | unit-tested: `isKetDocument` (empty/blank allowed, JSON object with `root` required, malformed/array/`null` rejected), `createSerialQueue` (FIFO order, rejection does not block, `idle`), `createClearedTabs`, and `tabStore.test.ts` (write produces structure + metadata, clear removes both, a write submitted after a clear or between a clear call and its queued cleanup cannot resurrect the snapshot). Snapshot restore, the corrupt-tab skip end-to-end and concurrent `index.json` ordering stay manual (`docs/verification.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| open target                             | an untouched empty tab (`name === null`, `path === null`, not dirty, empty structure) is reused; a saved, dirty or non-empty tab forces a new tab; opening `.ket` yields a clean tab with that path and its base name; importing another format yields a **clean** tab with `path: null` and the source base name; `importedTab` keeps that name and never produces `Untitled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| path uniqueness                         | `pathKey` / `findTabByPath` in `src/tabs.ts`: separators are normalised (`\` → `/`), one trailing separator is ignored, a Windows drive-letter path compares case-insensitively (`C:\Docs\A.KET` equals `c:/docs/a.ket`) and a POSIX path case-sensitively (`/docs/A.ket` differs from `/docs/a.ket`); the open guard activates the owning tab and reports a notice when Open… or a recent entry targets an open path, proceeds for a free path, and proceeds for the active tab's own path; Save As to a path owned by another tab is refused while the active tab's own path is allowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| tabs close guard                        | no dirty tab allows the close; exactly one dirty tab **and it is active** offers Save / Discard / Cancel; more than one dirty tab, or the only dirty tab is inactive, offers **Discard / Cancel only**; Save writes the active tab before closing and a cancelled Save As aborts the close; Cancel keeps the window open; Discard clears every dirty tab's snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| single-tab close (manual)               | a clean tab closes without prompting; a dirty tab is activated first when needed and prompts Save / Discard / Cancel for that tab; Cancel keeps it, Discard clears only its snapshot, Save writes it before closing; the next active tab is the right neighbour, then the left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `documentTitle`                         | path base name first, then `name`, then `Untitled`; base name without `.ket`; `*` only while dirty — the pure naming helper, while the tab strip renders a dot instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| names                                   | `documentName` and `exportFileName`: base name, path-over-name precedence, untitled fallback when both are `null`, Windows paths, export extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| save/export naming fallback             | an imported tab's Save As defaults to `<name>.ket` (`benzene.mol` → `benzene.ket`); `untitled.ket` only when the tab has neither a path nor a name; Export names the file `<name>.<ext>` and leaves `path` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| dirty transitions (manual)              | an editor change sets dirty; Save, `.ket` Open, import and New clear it; an imported format lands clean with `path: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| save target                             | Save with no path defaults to `<name>.ket`, or `untitled.ket` when the tab has no name either; with a path it reuses it; Save As appends `.ket`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| save vs export mapping                  | `.ket`/`getKet` for Save; V2000, V3000, SMILES, InChI, SVG, PNG sources and file extensions for Export; Export leaves `path` and `format` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| saved-blob routing                      | `.ket` (any case) routes to document save: existing path, Save As when `path` is `null`; `.mol`/`.smi`/`.inchi`/`.svg`/`.png` route to export save with `path` and `format` unchanged; no Tauri or no registered handler falls back to a download; an unknown or missing extension takes the export route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| saver default filename                  | a `.ket` blob routed by the file saver with no path suggests `untitled.ket` (that route carries no tab name); the app's own Save path uses `<name>.ket` or `untitled.ket` through `saveTarget` (the `save target` row); the export route keeps the filename Ketcher supplied (the app's own Export naming is `exportFileName`, covered by the `names` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| autosave scheduling                     | debounce coalesces rapid edits; the slow interval writes only while the **active** tab is dirty; a clean tab never writes; timers reset after a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| per-tab autosave (manual)               | only the active tab is scheduled; a switch flushes the outgoing tab immediately and schedules the incoming one; a write that lands after its tab closed or after a newer switch is discarded, so rapid switching never writes one tab's content into another                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| snapshot restore (manual)               | `index.json` with valid tab files restores content, names, paths, order, active id and dirty flags; a metadata entry without `name` falls back to its path base name, and a legacy import without either restores as `Untitled` with its content intact; a missing, unreadable or empty index, or a tab with corrupt/missing metadata or `.ket`, yields one empty tab / drops that tab without throwing; restore is silent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| write generation                        | a write started before `clearSnapshot(tabId)` cannot recreate that tab's snapshot; `createSerialQueue` runs tasks one at a time in submission order, keeps going after a rejection and reports `idle` only after everything submitted settled. The queue/generation interplay in `tabStore.ts` is manual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| close-guard copy (manual)               | the dialog copy matches the buttons: several dirty tabs and one inactive dirty tab show **no** Save action, no "Save changes?" title and explain Cancel/Discard only; the single active dirty tab keeps Save / Discard / Cancel. Rendered copy is checked by `docs/verification.md` §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| recent documents                        | `chemistry-draw.recent` key and the pure list helpers: a first path creates a one-entry list; adding an existing path moves it to the front without duplicating it (dedupe by exact string); the list is newest-first and capped at 10, dropping the oldest; removing a missing or unreadable path prunes only that entry; parsing a missing, malformed or non-array value yields an empty list; a duplicate path is never stored twice in the recent list; `loadRecent`/`saveRecent` round-trip through a stubbed `localStorage`, and a throwing `getItem`/`setItem` (or unavailable storage) degrades silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| file menu model                         | the exported item list has the exact ids, sentence-case labels and order New, Open…, Import…, Save, Save As…, Export…, separator, Recent documents; ellipsis only on Open…, Import…, Save As… and Export…; the recent section follows the separator; each item names the command it runs (New, openProject, importStructure, Save, Save As, Export, recent open); Open and Import are distinct entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| backstage sections                      | the exported section list has the exact ids `new`, `recent`, `save-export`, `settings`, `about`, labels New, Recent, Save & Export, Settings, About, in that order; the default section is `new`; no Stitch-mock section (templates, sidecar open, models) is present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| backstage status and version helpers    | the status strip reads `Connecting…` until both `/v2/info` values exist (missing version, empty version or missing port) and then exactly `Indigo <version> · sidecar :<port>`; `declaredVersion` strips a `^`/`~` prefix, keeps the first numeric version of a range, passes `Unavailable` through and trims a value with no digits. The Recent/About row view models, the About column values and the status strip's rendered state stay manual (`docs/verification.md` §2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| backstage settings descriptors          | every curated descriptor has a unique real Ketcher key, a sentence-case label that differs from the key and one of the `toggle`/`select`/`number` controls; unit-bearing keys pair with `<key>Unit` and `bondSpacing`/`imageResolution` carry none; select options equal Ketcher's enums (`showHydrogenLabels`, `stereoLabelStyle`, `valence-mode`); every number control declares a `min`, a `max` only where Ketcher bounds it (the bond-metric bounds are asserted and `imageResolution` must stay unbounded), and no invented key or label exists; `formatSettingValue` renders `14.4 pt`, `On`/`Off`, a select value unchanged and a bare number without a unit. Binding the controls, the ACS preset, Reset to defaults and the App save-patch callback stay manual (`docs/verification.md` §2)                                                                                                                                                                                                                                                                                     |
| dialog tokens                           | the overlay token is exactly `rgba(94,94,94,0.2)` and the pre-fade token is `rgba(94,94,94,0.01)`; the hatch overlay token's data URI decodes to a 10×10 SVG whose path is `M0 10 10 0zm12-2-4 4zM-2 2l4-4z` with `stroke` `#555`, `stroke-width` 2 and `stroke-opacity` 0.02; its repeat and size tokens are `repeat` and `10px 10px`; the old `rgba(94,94,94,0.8)` overlay is gone; the dialog panel tokens resolve to radius `8px`, border `none` and shadow `none`; `tokens.dialog.transition` is `background-color 0.3s` (the transition lives on that token, not on the overlay colour); the generic 3 px `radius` and soft shadow remain for non-dialog surfaces and are asserted non-empty; every in-app dialog gets its overlay and panel styling from these tokens, with no per-dialog colour, radius, border or shadow; `tokens.dialog.backdropPattern` stays a bare `data:image/svg+xml` URI that does not itself start with `url(`, while the `background-image` the overlay applies wraps that token as `url("…")` — the token raw, the CSS function owned by the component |

Rules:

- Assert exact values, not "does not throw"; the tables in `docs/architecture.md`
  §5.3–5.7 are the expected outputs.
- Use `vi.useFakeTimers()` and fixed timestamps. No real timers, no wall clock.
- Mutation check before committing: removing the debounce, writing while clean,
  or returning the Save format for Export must each make a test fail. For tabs,
  marking a tab clean on switch, allowing an inactive tab to become active
  without switching, closing the last tab to zero tabs, or offering Save when
  several tabs are dirty must each fail a test. For the
  saver, routing a `.mol` blob to document save (or a `.ket` blob to export)
  must fail a test. For the dialog tokens, restoring the `rgba(94,94,94,0.8)`
  overlay, dropping the diagonal hatch from the overlay, changing its stroke
  colour/width/opacity or its `repeat`/`10px 10px` size, the `3px` panel radius,
  the `1px` panel border or any panel shadow must each make the token test fail.
  For the hatch, dropping the `url("…")` wrapper from the applied
  `background-image` or pre-wrapping the token itself must each fail a test.
  For the recent list, skipping dedupe, exceeding the 10-entry cap, or keeping a
  missing path instead of pruning it must each fail a test. For the menu model,
  reordering items or merging Open… and Import… into one entry must fail. For
  path uniqueness, disabling normalisation, comparing a POSIX path
  case-insensitively, letting Open create a second tab for an owned path, or
  letting Save As overwrite another tab's path must each fail a test. For the
  backstage, reordering or dropping a section, changing the default away from
  New, inventing a settings key or label, dropping a unit pair, changing an
  option away from Ketcher's enum, bounding `imageResolution` or dropping a
  bond-metric bound, and breaking the `Connecting…`/`Indigo …` status or the
  `declaredVersion` prefix stripping must each fail a test.
- The dialog-token test asserts the exported `tokens` constants directly; the
  rendered overlay tint, hatch visibility, fade smoothness and panel shape are
  covered by the manual checklist (`docs/verification.md` §2, "In-app dialog
  styling").
- Do not mock Tauri in the pure-helper tests. `src/tabStore.test.ts` is the one
  exception: it mocks `@tauri-apps/api/core`, `api/path` and `plugin-fs` with an
  in-memory filesystem to prove the snapshot lifecycle (write, clear, cleared
  tombstone refuses a write submitted after a clear, and a write submitted
  between a clear call and its queued cleanup). Everything else (`appDataDir`
  paths, `onCloseRequested`, the real dialog) stays manual.
- Clearing `dirty` and the recovery snapshot is **not** part of the pure
  `routeSavedBlob`: `saveRoutedBlob` in `src/App.tsx` writes the blob first and
  then applies the state change. That adapter is not unit-tested.

### 5.2 Manual checklist

The real flows cannot be unit-tested without a WebView and a filesystem, so
`docs/verification.md` §2 is mandatory: "Document tabs" (create, switch, close,
per-tab autosave, rapid switching, silent restore on relaunch, the multi-tab
close guard and the single-tab prompt, Open reusing an empty tab), "Documents,
autosave and recovery" (Save, Save As, each Export format, crash simulation, all
close-guard paths), "File menu" (the File button and its items, Open only
listing `.ket`, Import accepting structures, the recent list, pruning a missing
file, path uniqueness for Open/recent/Save As, the hidden native Save As with
native Open kept as the canvas-load path, the shortcuts and the browser
fallback) and "Backstage" (startup takeover, Back/Home/Escape round-trip,
rail and focus trap, every section's real data source, live settings, ACS/reset,
About matching `/v2/info`, and the removed Stitch content).

---

## 6. Assertion quality

### Strong assertions

- Deterministic results → assert the **exact** value/structure.
- Endpoints → status **and** body.
- Errors → assert the message contains the actionable cause.
- Files/render output → assert the format and non-empty payload, not just "no
  crash".

### Forbidden anti-patterns

| Pattern                                       | Why it is weak                      |
| --------------------------------------------- | ----------------------------------- |
| `assert!(true)` / no assertion                | Verifies nothing                    |
| Asserting only "did not crash"                | Says nothing about the outcome      |
| `assert!(result.is_ok())` alone               | Ignores the value under test        |
| Asserting `is_some()`/`is_not_none()` alone   | Almost always true                  |
| Reading private state                         | Tests implementation, not behaviour |
| Tests that depend on order or wall-clock time | Flaky by construction               |

---

## 7. Commands

```bash
# Full harness (typecheck, lint, format, build, clippy, tests)
node scripts/harness.mjs

# Frontend gates
pnpm run check          # typecheck + ESLint + Prettier
pnpm run lint           # ESLint only
pnpm run format:check   # Prettier only
pnpm run format         # apply Prettier

# Rust gates
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings

# Sidecar tests (harness sets LD_LIBRARY_PATH; manually:)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 cargo test -p indigo-server

# One test
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server info_endpoint_returns_version
```
