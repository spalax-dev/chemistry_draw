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

### 4.3 Ketcher patch contract (E1)

`patches/ketcher-core@3.21.0.patch` is configuration the editor depends on, so a
contract test (Vitest, alongside the capability test) reads the real patch file,
`pnpm-workspace.yaml` and the installed `dist/` and asserts the guard survives a
reinstall:

| Target                                         | Assertion                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                          | `patchedDependencies` names exactly `ketcher-core@3.21.0` and the 3.21.0 patch path; no `3.18.0` entry                                                                                |
| `patches/ketcher-core@3.21.0.patch`            | contains **only** the `parametrizeUrl` hunks for `remoteStructService.js` and `remoteStructService.modern.js`; no ReBond hunk (3.21.0 ships it upstream)                              |
| installed `ketcher-core` `remoteStructService` | both dist builds use `:([A-Za-z_]\w*)` plus `hasOwnProperty.call(params, key)`, and the function keeps the explicit port when applied to `http://127.0.0.1:9321/v2/imago/uploads/:id` |

Rules:

- Assert the real files, not a fixture. Deleting either `parametrizeUrl` hunk,
  restoring `:(\w+)`, or re-adding a ReBond hunk must each make the test fail.
- Execute the installed `parametrizeUrl` with `{ id: "abc" }` and assert the
  result is `http://127.0.0.1:9321/v2/imago/uploads/abc`: the port survives and
  only the declared placeholder is substituted. Mutation check: the 3.18/3.21
  `:(\w+)` body yields `http://127.0.0.1undefined/...` and fails the assertion.
- The test reads the patch and the installed bundle; it does not run Ketcher.
  The end-to-end behaviour — an explicit-port Imago Recognize poll — is the
  manual step in `docs/verification.md` §2, "Ketcher 3.21.0 upgrade and
  language selector".

### 4.4 E1 upgrade contracts (Ketcher 3.21.0, Indigo 1.49.0, language selector)

The E1 contract is configuration, so `scripts/lib/*.test.mjs` and Vitest read
the real files:

| Target                                 | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                         | `ketcher-core` and `ketcher-react` are exactly `3.21.0` (no caret); `ketcher-react` resolves to the committed multi-language tarball (`file:vendor/ketcher-react/ketcher-react-3.21.0-multi.tgz`)                                                                                                                                                                                                                                                                                               |
| `scripts/build-ketcher-react.sh`       | checks out tag `v3.21.0` into `build/ketcher-src`, writes `pnpm-workspace.yaml` (`packages: ["packages/*"]`), installs with `pnpm install --ignore-scripts --no-frozen-lockfile`, exports `KETCHER_MULTI_LANGUAGE_BUILD=true`, runs `pnpm --filter ketcher-react run i18n:generate` and the Rollup build via `pnpm --filter ketcher-react exec …`, guards `zh-CN`, packs into `vendor/ketcher-react/`; requires Node ≥ 24.20.0, uses no npm/npx, and fails loudly when the tag or flag is wrong |
| `scripts/build-libs.sh`                | clones `--branch indigo-1.49.0` (never `master`), guards that the checkout is the tag, and still builds `indigo` / `indigo-renderer` plus Imago/OpenCV                                                                                                                                                                                                                                                                                                                                          |
| `scripts/fetch-windows-libs.ps1`       | pins Indigo `1.49.0`, the SHA-256 `5bd405cc…` and the 10,955,395 B archive, and never vendors DLLs/`.lib` files                                                                                                                                                                                                                                                                                                                                                                                 |
| installed `ketcher-react` locale build | `SUPPORTED_LANGUAGES` contains `en` and `zh-CN`, the Settings selector is reachable, and `LANGUAGE_STORAGE_KEY === "ketcher-language"`                                                                                                                                                                                                                                                                                                                                                          |
| sidecar `/v2/info`                     | `indigo_version` starts with `1.49.0` on the built/packaged backend (a `1.51.0-dev` master string fails)                                                                                                                                                                                                                                                                                                                                                                                        |
| main app 3.21 init                     | `src/App.tsx` calls `applyKetcherAppOptions(ketcher, { server: true })` and never `editor.options({ app: ... })`; `applyAppOptionsToStore` dispatches `APP_OPTIONS`, `UPDATE`, then a no-op `ACTION` and returns `false` on a throwing store                                                                                                                                                                                                                                                    |

Rules:

- Assert the real files, not a fixture. Restoring `master`, removing the build
  flag, using the published English-only `ketcher-react`, pinning 3.18/1.46, or
  restoring the old `editor.options({ app })` init must each make a contract
  test fail.
- The English-only npm package is the negative fixture: assert that the
  installed build is **not** it (locale list has two entries). Do not assert a
  translation string that could change between patch releases; assert the
  locale list and the storage key.
- The language selector is UI-only: the contract must not couple it to
  `apiPath`. The explicit-port `parametrizeUrl` behaviour (§4.3) is a separate
  test.
- `/v2/info` is checked against the real linked Indigo; no unit test mocks the
  version string. The manual packaged check is in `docs/verification.md` §2.
- The app-init test is `src/ketcherOptions.test.ts`: it calls the pure
  `applyAppOptionsToStore` with a fake store and asserts the dispatch order,
  the `{ server: true }` payload, and `false` when a dispatch throws; a source
  contract asserts `src/App.tsx` calls `applyKetcherAppOptions` and contains no
  `editor.options({ app: ... })`. It does not mount the real editor; the
  observable outcome is the manual `task run` step.

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
`src/templateLibrary.ts` and `src/ui/tokens.ts` — no DOM,
no React rendering.
`src/tabStore.test.ts` is the single documented exception: it mocks the Tauri
fs/path/core modules with an in-memory filesystem (§5.1 rules).

| Helper / module                         | Behaviour under test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tab model                               | creating the first tab requires it to be clean, path-less and active; a second create keeps both tabs and activates the new one; activate changes only the active id; close removes the tab and selects the one to its right, otherwise the one to its left, otherwise a fresh empty tab — never zero tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| tab dirty state (manual: Save/Open/New) | the pure tests cover the model: committing serialized content stores the `.ket` text and keeps the tab dirty, and the dirty count ignores clean tabs. Marking a tab dirty on an editor change and clearing only that tab's `dirty` after Save, Open or New happens in `App.tsx` and is covered by `docs/verification.md` §2, not Vitest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| tab titles                              | `tabTitle` uses the `path` base name first, then `name`, then `Untitled` when both are `null`; the base name drops `.ket`; it **appends `*`** while dirty. The strip removes that asterisk and paints the dirty dot instead, so the visible strip label never contains `*` while the window title and dialog copy do; `tabDisplayName` returns the same title without the `*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| tab snapshots (manual: restore/index)   | unit-tested: `isKetDocument` (empty/blank allowed, JSON object with `root` required, malformed/array/`null` rejected), `createSerialQueue` (FIFO order, rejection does not block, `idle`), `createClearedTabs`, and `tabStore.test.ts` (write produces structure + metadata, clear removes both, a write submitted after a clear or between a clear call and its queued cleanup cannot resurrect the snapshot). Snapshot restore, the corrupt-tab skip end-to-end and concurrent `index.json` ordering stay manual (`docs/verification.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| open target                             | an untouched empty tab (`name === null`, `path === null`, not dirty, empty structure) is reused; a saved, dirty or non-empty tab forces a new tab; opening `.ket` yields a clean tab with that path and its base name; importing another format yields a **clean** tab with `path: null` and the source base name; `importedTab` keeps that name and never produces `Untitled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| path uniqueness                         | `pathKey` / `findTabByPath` in `src/tabs.ts`: separators are normalised (`\` → `/`), one trailing separator is ignored, a Windows drive-letter path compares case-insensitively (`C:\Docs\A.KET` equals `c:/docs/a.ket`) and a POSIX path case-sensitively (`/docs/A.ket` differs from `/docs/a.ket`); the open guard activates the owning tab and reports a notice when Open… or a recent entry targets an open path, proceeds for a free path, and proceeds for the active tab's own path; Save As to a path owned by another tab is refused while the active tab's own path is allowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| tabs close guard                        | no dirty tab allows the close; exactly one dirty tab **and it is active** offers Save / Discard / Cancel; more than one dirty tab, or the only dirty tab is inactive, offers **Discard / Cancel only**; Save writes the active tab before closing and a cancelled Save As aborts the close; Cancel keeps the window open; Discard clears every dirty tab's snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| single-tab close (manual)               | a clean tab closes without prompting; a dirty tab is activated first when needed and prompts Save / Discard / Cancel for that tab; Cancel keeps it, Discard clears only its snapshot, Save writes it before closing; the next active tab is the right neighbour, then the left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `documentTitle`                         | path base name first, then `name`, then `Untitled`; base name without `.ket`; `*` only while dirty — the pure naming helper, while the tab strip renders a dot instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| names                                   | `documentName` and `exportFileName`: base name, path-over-name precedence, untitled fallback when both are `null`, Windows paths, export extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| save/export naming fallback             | an imported tab's Save As defaults to `<name>.ket` (`benzene.mol` → `benzene.ket`); `untitled.ket` only when the tab has neither a path nor a name; Export names the file `<name>.<ext>` and leaves `path` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| dirty transitions (manual)              | an editor change sets dirty; Save, `.ket` Open, import and New clear it; an imported format lands clean with `path: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| save target                             | Save with no path defaults to `<name>.ket`, or `untitled.ket` when the tab has no name either; with a path it reuses it; Save As appends `.ket`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| save vs export mapping                  | `.ket`/`getKet` for Save; V2000, V3000, SMILES, InChI, SVG, PNG sources and file extensions for Export; Export leaves `path` and `format` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| saved-blob routing                      | `.ket` (any case) routes to document save: existing path, Save As when `path` is `null`; `.mol`/`.smi`/`.inchi`/`.svg`/`.png` route to export save with `path` and `format` unchanged; no Tauri or no registered handler falls back to a download; an unknown or missing extension takes the export route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| saver default filename                  | a `.ket` blob routed by the file saver with no path suggests `untitled.ket` (that route carries no tab name); the app's own Save path uses `<name>.ket` or `untitled.ket` through `saveTarget` (the `save target` row); the export route keeps the filename Ketcher supplied (the app's own Export naming is `exportFileName`, covered by the `names` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| autosave scheduling                     | debounce coalesces rapid edits; the slow interval writes only while the **active** tab is dirty; a clean tab never writes; timers reset after a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| per-tab autosave (manual)               | only the active tab is scheduled; a switch flushes the outgoing tab immediately and schedules the incoming one; a write that lands after its tab closed or after a newer switch is discarded, so rapid switching never writes one tab's content into another                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| snapshot restore (manual)               | `index.json` with valid tab files restores content, names, paths, order, active id and dirty flags; a metadata entry without `name` falls back to its path base name, and a legacy import without either restores as `Untitled` with its content intact; a missing, unreadable or empty index, or a tab with corrupt/missing metadata or `.ket`, yields one empty tab / drops that tab without throwing; restore is silent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| write generation                        | a write started before `clearSnapshot(tabId)` cannot recreate that tab's snapshot; `createSerialQueue` runs tasks one at a time in submission order, keeps going after a rejection and reports `idle` only after everything submitted settled. The queue/generation interplay in `tabStore.ts` is manual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| close-guard copy (manual)               | the dialog copy matches the buttons: several dirty tabs and one inactive dirty tab show **no** Save action, no "Save changes?" title and explain Cancel/Discard only; the single active dirty tab keeps Save / Discard / Cancel. Rendered copy is checked by `docs/verification.md` §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| recent documents                        | `chemistry-draw.recent` key and the pure list helpers: a first path creates a one-entry list; adding an existing path moves it to the front without duplicating it (dedupe by exact string); the list is newest-first and capped at 10, dropping the oldest; removing a missing or unreadable path prunes only that entry; parsing a missing, malformed or non-array value yields an empty list; a duplicate path is never stored twice in the recent list; `loadRecent`/`saveRecent` round-trip through a stubbed `localStorage`, and a throwing `getItem`/`setItem` (or unavailable storage) degrades silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| file menu model                         | the exported item list has the exact ids, sentence-case labels and order New, Open…, Import…, Save, Save As…, Export…, separator, Recent documents; ellipsis only on Open…, Import…, Save As… and Export…; the recent section follows the separator; each item names the command it runs (New, openProject, importStructure, Save, Save As, Export, recent open); Open and Import are distinct entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| backstage sections                      | the exported section list has the exact ids `welcome`, `open`, `models`, `about`, labels Welcome, Open, Models, About, in that order; the default section is `welcome`; the rail has exactly these four sections and no Settings entry; the Models pane renders only its heading and a muted empty-state note and carries no action — no button, link, input, download or model row — and no invented model, version or download value; no Stitch-mock section (Indigo-sidecar open) is present; the Open pane renders the same shared `RecentStructuresTable` as Welcome (thumbnails included) with an added Remove action and then the open-tab rows; the source of `Backstage.tsx`/`backstage.ts` carries no `SaveExportSection` import, `save-export` branch or `Save & Export` label and no status strip (`formatBackstageStatus`, `<footer>`, `aria-live`, `starting`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| template library entries                | `src/templateLibrary.ts` maps `Struct`-like entries — `FunctionalGroupsProvider.getFunctionalGroupsList()` then `SaltsAndSolventsProvider.getSaltsAndSolventsList()` — into `TemplateEntry` values. Each entry's `id` is the lower-case slug of its name (non-alphanumerics collapse to one `-`, no leading/trailing `-`), collisions take `-2`, `-3`, … so ids are unique, `name` trims the struct name and falls back to the trimmed `abbreviation` then `Untitled template`, `group` is `functional-group` or `salt-solvent` by source list (UI labels `Functional group` / `Salt or solvent`), and `ket` is the serialized struct (`KetSerializer.serializeMicromolecules`). Dedupe is by the case-insensitive `name` + `abbreviation` pair and keeps the first occurrence (functional groups before salts), so a struct present in both lists yields one entry. Two empty provider lists yield `[]`; an empty list plus a populated one yields only the populated entries; provider order is preserved. A mapper that invents entries, keeps a duplicate, repeats an id, takes the name from the wrong field or drops the KET fails                                                                                                                                                                                                                                                                                                                             |
| welcome four-card subset                | `TEMPLATE_CARD_COUNT` in `src/templateLibrary.ts` is exactly `4`; `sampleTemplates(entries, TEMPLATE_CARD_COUNT, random)` returns exactly `min(4, entries.length)` **distinct** entries, in library order, never more than the library, and `[]` for a non-positive count. With a library larger than four it returns four, and the injected RNG makes it deterministic: the same sequence returns the same subset, and a `random` that always returns 0 does not duplicate an item. The `WelcomeSection` wiring is checked against the source: it samples `useMemo(() => sampleTemplates(templates, TEMPLATE_CARD_COUNT, random), [templates, random])`, renders the visible entries, and renders the muted `No templates available` line when the initialized library is empty. A count other than four, a duplicated card, a curated fallback, `templateCountForWidth`, a width-breakpoint rule or a resize listener in the grid path fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| template source and tool contracts      | Source contracts in `src/templateLibrary.test.ts` (or the module's test): `src/ui/backstage/WelcomeSection.tsx` and `src/templateLibrary.ts` do not import `src/templates.ts` or its curated `TEMPLATES` pool, and no card path reads it; the library lists are the only card source. (`src/templates.ts` is the legacy curated module, still covered by `src/templates.test.ts`, not the live cards.) The Welcome/source path for a card inserts the entry's `ket` (no SMILES or hand-built structure). `openBackstage()` and `activateTabById()` in `App.tsx` call `cancelActiveTool(...)` **before** serializing/loading, and `cancelActiveTool` dispatches a bubbling, cancelable `keydown` with `key === "Escape"` to the `.Ketcher-root` element (no toolbar `click()`, no Redux dispatch). Removing a call, moving it after the switch or replacing it with a DOM toolbar click fails. `previewKetWithoutSgroups(ket)` is unit-tested: every `sgroups` array is emptied (nested molecules included), atoms/bonds/header and every other field are preserved, malformed JSON comes back unchanged and repeated calls are deterministic, while `insertTemplate` still loads the original `template.ket`. Rendering previews with `generateImage(..., { outputFormat: "svg" })`, caching and the loading/error placeholders stay manual; the empty-library **branch** is source-checked above, while the rendered empty UI is manual (`docs/verification.md` §2) |
| backstage More templates                | The `WelcomeSection` source renders a **More templates** button (disabled until the editor is ready) and calls `onMoreTemplates`; `Backstage` passes the handler; `App` closes the backstage before calling it; `src/ketcherOptions.ts` dispatches an object with `type: "MODAL_OPEN"`, `data.name === "templates"` and `data.prop.tab === null`. A missing handler, a modal name other than `templates`, a non-null tab or a hand-made gallery fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| welcome actions (first run vs document) | The `WelcomeSection.tsx` source derives the branch from the tab set with `isUntouchedTab` imported from `src/tabs.ts` — the same predicate as open-reuse: `hasDocument = tabs.tabs.some((tab) => !isUntouchedTab(tab))`, so a tab with `name === null`, `path === null`, not dirty and empty content is not a document. With a document it renders the primary **Back to editor — tabTitle(active)** action (name plus `*` while dirty) and pins `onBackToEditor`; with none it renders no Back to editor and gives **Blank canvas** the primary style. `Backstage` passes the active tab set/`onClose`, and `App` does not activate a tab or save when the action closes the overlay. A `tabs.length > 0` guard, a path-or-name-only predicate, rendering Back to editor on a first run, dropping the dirty marker or leaving Blank canvas as the secondary action when no document exists fails a test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| backstage top bar (no Back to Editor)   | The `Backstage.tsx` source renders only the logo and the `Chemistry Draw` title in the top bar, with no `\| Backstage` suffix: no Back to Editor label and no exit/close button in the top-bar row. The rail keeps the **Back to editor** button (the only top-level way back) and Escape still closes the overlay. Reintroducing a top-right Back to Editor control, a top-bar close action or the `\| Backstage` suffix fails a source-contract test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| backstage default Welcome reset         | `DEFAULT_BACKSTAGE_SECTION` is `welcome` (already asserted); the `Backstage` source uses `useState(DEFAULT_BACKSTAGE_SECTION)`, and `App` mounts the backstage conditionally so closing unmounts it. A default of `new`, a persisted section or a reset effect that can land on another section fails. This pins the blank-on-reopen fix: the committed activity-21 build's `new` default mounted an empty pane after editing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| backstage unknown section fallback      | `normalizeSection(id)` in `src/backstage.ts` returns `id` unchanged for the four known ids (`welcome`, `open`, `models`, `about`) and returns `welcome` for every other value — `new`, an empty string, the removed `settings` id and an arbitrary string. The `Backstage.tsx` source has a `renderSection` switch over the known ids with a `default` branch that renders `WelcomeSection`, not `null`, an empty fragment or an empty pane; an unknown section id therefore mounts the Welcome title and its actions. Deleting the `default` branch, returning nothing for an unknown id or normalising a known id away fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| backstage version helper                | `declaredVersion` strips a `^`/`~` prefix, keeps the first numeric version of a range, passes `Unavailable` through and trims a value with no digits. The Recent/About row view models, the About column values and the rendered About section stay manual (`docs/verification.md` §2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| recent structures formatting            | `formatFileSize(bytes)` renders `0 B` for 0, whole bytes below 1024 (`512 B`) and one-decimal binary units above (`1 KB`, `12.4 KB`, `1.5 MB`); it never renders a negative, `NaN` or scientific value. `formatModified(mtime)` renders `Today, HH:MM` (24-hour, local) on the current calendar day, `Yesterday` for the previous day and `Mon D, YYYY` in `en-US` for older timestamps, plus `—` for an invalid, missing or future timestamp, so a broken `stat` cannot produce `Invalid Date` in the table. Asserting the exact strings for a fixed timestamp catches a formatter that passes through `toISOString` or a locale format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| validation status mapping               | `validationStatus(result)` maps an empty array and the empty JSON string to `Valid`; a non-empty result made only of warnings to `Warnings`; any result containing an error entry to `Invalid`; and a thrown error, `null`, `undefined` or an unreadable value to `Unknown`. The check request is the whole KET-derived molfile with the ten documented `types` (`valence`, `radicals`, `pseudoatoms`, `stereo`, `query`, `overlapping_atoms`, `overlapping_bonds`, `rgroups`, `chiral`, `3d`). Treating a missing source as `Valid`, a parse failure as `Invalid`, or dropping a type fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| preview cache key                       | `contentHash(molfile)` returns the lower-case hex SHA-256 of the UTF-8 molfile, and `previewFileName(hash)` appends `.svg`, so equal content yields the same name and an edited document yields a different one; the cache file is `<hash>.svg` under `<appDataDir>/previews/`. A truncated hash, upper-case hex, a name without `.svg` or a key taken from the `.ket` text instead of the molfile fails. Disk read/write, the cache hit, the sidecar render and the `previewFilePath` path composition (`appDataDir` + `previews` + `<hash>.svg`) stay manual (`docs/verification.md` §2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| recent row model                        | `buildRecentRow({ path, stat, text, checkResult, preview })` is pure: it derives `name` and `format` from the path (base name without its last extension, upper-case extension without the dot, Windows separators included), takes size/mtime labels from the helpers, and marks a missing `stat` or unreadable `text` with `—` size/date, `unknown` status and no preview; `checkResult === null` is `unknown`, otherwise `validationStatus(checkResult)` maps it. A row model that drops a missing file, invents a size or date, reads the name from the directory, treats a null check as a pass or keeps a stale validation after a failed read fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| dialog tokens                           | the overlay token is exactly `rgba(94,94,94,0.2)` and the pre-fade token is `rgba(94,94,94,0.01)`; the hatch overlay token's data URI decodes to a 10×10 SVG whose path is `M0 10 10 0zm12-2-4 4zM-2 2l4-4z` with `stroke` `#555`, `stroke-width` 2 and `stroke-opacity` 0.02; its repeat and size tokens are `repeat` and `10px 10px`; the old `rgba(94,94,94,0.8)` overlay is gone; the dialog panel tokens resolve to radius `8px`, border `none` and shadow `none`; `tokens.dialog.transition` is `background-color 0.3s` (the transition lives on that token, not on the overlay colour); the generic 3 px `radius` and soft shadow remain for non-dialog surfaces and are asserted non-empty; every in-app dialog gets its overlay and panel styling from these tokens, with no per-dialog colour, radius, border or shadow; `tokens.dialog.backdropPattern` stays a bare `data:image/svg+xml` URI that does not itself start with `url(`, while the `background-image` the overlay applies wraps that token as `url("…")` — the token raw, the CSS function owned by the component                                                                                                                                                                                                                                                                                                                                                                            |

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
  Welcome (or back to the retired `new`, which is the blank-pane bug), deleting
  the `renderSection` default so an unknown id renders nothing, letting
  `normalizeSection` pass an unknown id through, adding a control or data row to
  the Models pane, reintroducing a Settings section or binding the backstage to
  `settingsService`, breaking the
  `declaredVersion` prefix stripping, inventing or dropping a library entry
  instead of reading both providers, keeping a duplicate name/abbreviation,
  repeating an id, dropping the serialized KET, a preview rendered from anything
  other than the entry's KET, and a thumbnail appearing in the Open pane must
  each fail a test. For the library mapper, an empty provider pair that yields
  entries, a populated provider whose entries are dropped, a name taken from the
  wrong field or an id that is not a unique slug must each fail. For
  the Welcome subset, a count other than four, a duplicated card, a count above
  the library, an empty slice for a positive count, ignoring the injected RNG,
  or a width breakpoint or resize listener driving the count must each fail. For
  the tool reset, a missing `cancelActiveTool` call in `openBackstage` or
  `activateTabById`, a call placed after serialization/loading, or a reset that
  clicks a DOM toolbar button instead of dispatching Escape to `.Ketcher-root`
  must each fail a source-contract test. For More templates, a
  missing handler, a modal name other than `templates`, `prop.tab` not `null`, a
  gallery fallback and not closing the backstage first must each fail. For the
  Welcome action branch, rendering Back to editor for an untouched first-run tab,
  keying the predicate on `tabs.length` or path alone, dropping the active
  name/dirty marker, giving Blank canvas the secondary style when no document
  exists, or activating/saving on close must each fail. For the top bar, a Back
  to Editor control or a top-bar close button must fail a test. For the Recent structures table,
  inventing a size or date for a missing file, mapping an empty check result to
  Warnings/Invalid, mapping a check failure to Valid, hashing something other
  than the file content for the preview key, adding a preview field to a `.ket`
  or rendering the Open pane with a thumbnail must each fail a test.
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
the Welcome/Open rail labels and icons, the real Structure Library cards with
Ketcher-rendered previews, the four-card subset and its
re-randomization, the `No templates available` empty state, the unknown-section
Welcome fallback, More templates opening the Structure Library, the Escape tool
reset on backstage open and tab switch, the first-run vs document action branch
with the active name/dirty marker, the card new-tab insertion, the Recent structures table
(real size/date, Valid/Invalid against a broken structure, the cached thumbnail
on a second open, a missing-file row, no `.ket` change), the Open list without
previews, focus trap, every section's real data source, Ketcher's toolbar
settings dialog, About matching `/v2/info`, and the removed Stitch content).

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
