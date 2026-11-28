# Verification

> How Chemistry Draw decides that work is correct. The harness is the executable
> source of truth; this document explains the policy.

---

## 0. The stage decides what can run

`.harness/state.json` holds the stage. It is one-way.

| Stage         | Exists for                               | Cannot do                          |
| ------------- | ---------------------------------------- | ---------------------------------- |
| `planning`    | foundation, contracts, diagrams, backlog | code, tests, build, implementation |
| `development` | stories -> activities -> tasks           | return to planning                 |

A development command in `planning` exits with `[BLOCKED]`. It is not silently
skipped: the agent must not believe it verified something it did not.

The plugin (`.opencode/plugins/harness-guard.js`) blocks source edits while in
planning, and blocks edits outside a claimed activity's `touches` during a
batch.

---

## 1. Planning gates

| Gate                 | Proves                                            |
| -------------------- | ------------------------------------------------- |
| `planning-structure` | `docs/planning/{adr,c4,sequences}` exist          |
| `backlog`            | `BACKLOG.md` parses; statuses valid; max 1 active |
| `planning-docs`      | foundation docs exist and are not placeholders    |
| `puml`               | every diagram has balanced `@startuml`/`@enduml`  |
| `docsgen-config`     | a documentation generator is configured           |

Running `--start-dev` re-runs them; a red foundation cannot enter development.
The foundation is the product: Tauri v2 host, React/Ketcher frontend, the
`indigo-server` sidecar, the `.ket` document model and the model-delivery path.

---

## 2. Development gates

| Gate        | Proves                                              | Step                                  |
| ----------- | --------------------------------------------------- | ------------------------------------- |
| `format`    | formatting is stable                                | all                                   |
| `lint`      | static rules pass                                   | all                                   |
| `type`      | TypeScript types and Rust crates compile            | iteration, activity, story            |
| `test`      | behavior is covered                                 | iteration (targeted), activity, story |
| `build`     | the frontend artifact builds                        | story                                 |
| `structure` | tree/naming/forbidden patterns hold                 | all                                   |
| `docs`      | harness docs exist and are not placeholders         | iteration, activity, story            |
| `docsgen`   | the documentation generator runs                    | activity, story                       |
| `docblocks` | optional extra docblock check                       | activity, story when enabled          |
| `touches`   | no changed file falls outside the batch's `touches` | activity                              |

There is no separate `contract` gate in the engine. Packaging and public
contract tests run in the `test` gate through `scripts/lib/*.test.mjs`.

Concrete commands behind the gates:

| Gate      | Command                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `format`  | `pnpm run format:check`, `cargo fmt --all --check`                                                                     |
| `lint`    | `pnpm run lint`, `cargo clippy --workspace --all-targets -- -D warnings`, `shellcheck --severity=warning scripts/*.sh` |
| `type`    | `pnpm run typecheck` (`tsc --noEmit`), `cargo check --workspace --all-targets`                                         |
| `test`    | `bash scripts/harness-test.sh full` (Vitest, `node:test`, sidecar cargo tests)                                         |
| `build`   | `pnpm build`                                                                                                           |
| `docsgen` | `bash scripts/docsgen.sh` (TypeDoc + rustdoc; alias `pnpm run docs:gen`)                                               |

Docblocks are enforced by the docblock policy first. Rust modules use `//!` and
public items use `///`; exported TypeScript symbols use JSDoc. Legacy files that
fail a new rule get a visible baseline and a backlog story, never a disabled
rule. The current check is `node scripts/check-docblocks.mjs`; the debt and its
burn-down live in `docs/harness/docstring-debt.md` and
`docs/harness/docblock-baseline.txt`.

---

## 3. Steps and commands

| Command                                      | Step      | Runs                                                                    |
| -------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `node scripts/harness.mjs --planning`        | planning  | planning gates                                                          |
| `node scripts/harness.mjs --fast`            | iteration | changed format/lint + structure                                         |
| `node scripts/harness.mjs`                   | iteration | changed format/lint + affected type + targeted tests + structure + docs |
| `node scripts/harness.mjs --activity ACT-xx` | activity  | iteration + docsgen + touches                                           |
| `node scripts/harness.mjs --story US-xxx`    | story     | all gates + build + full tests + docsgen + approval                     |
| `node scripts/harness.mjs --explain`         | —         | prints the gate set, runs nothing                                       |

Exit codes:

- `0` green.
- `1` failed.
- `3` story gates green but **user approval is missing**. This is the human
  boundary, not an error to bypass.

Packaging changes additionally need `task packages` and the payload checks in
`docs/planning/contracts.md`; Windows packaging is validated by the `windows`
CI job. Model-gated tests need `models/` and the ONNX Runtime dylib; they
self-skip with an explicit `[SKIP]` when those are absent.

---

## 4. The story boundary

1. All activities of the story are `done`.
2. The story is `- status: awaiting-approval` in `BACKLOG.md`.
3. `--story` runs the full gate. If it exits `3`, present the evidence and ask.
4. On approval: `--approve-story US-xxx --by <name>`, then `--story` again.
5. Mark `done`; archive to `progress/history.md`; clear `activities.json`; merge
   the branch to its target line.

An agent can never approve. There is no reviewer role to outsource it to.

---

## 5. Parallelism

`--schedule` turns `dependsOn` + `touches` into batches:

- A batch is a set of pending activities whose dependencies are done and whose
  `touches` do not overlap.
- Activities inside a batch run in parallel, one executor each.
- Batches run sequentially.

Rules:

- A batch of N requires N executors launched in one message.
- Each executor claims before editing (`--claim`). The plugin blocks edits until
  all N claims exist, so serial execution cannot silently pass.
- Activity verification is serial, after the executor returns.
- Missing `touches` means the activity runs alone.
- The branch model still applies: the batch names its base line and never mixes
  `main` and `develop` work.

---

## 6. Documentation as a system

- Planning docs are hand written and **stay editable** in development.
- In-code docblocks are the source of truth for what the code does.
- The generator (`bash scripts/docsgen.sh`) produces the readable docs; output
  under `docs/generated/` and `target/doc/` is build output and is never
  committed.
- A decision change writes an ADR and updates the affected planning doc or
  diagram in the same activity.

---

## 7. Costs and anti-patterns

- `--fast` is the edit loop. Do not run `--story` after every edit.
- At most two story-level runs per story: one for evidence, one to confirm after
  approval. A third needs a reason.
- Do not run gates while an executor is editing.
- Do not run `docsgen` on every save; activity and story close are enough.
- A false green is worse than a false red: when a gate is not configured, the
  harness says so; it does not pretend.

---

## 8. Acceptance for this harness

- [ ] `--planning` is green on the foundation.
- [ ] `--activity` in planning exits non-zero with `[BLOCKED]`.
- [ ] `--start-dev` without `--user-approved` fails.
- [ ] `--schedule` prints parallel batches for independent activities.
- [ ] `--claim` rejects an activity outside the current batch.
- [ ] `--activity` fails when a file outside `touches` changed.
- [ ] `--story` exits `3` without approval.
- [ ] `--story` passes after `--approve-story`.
- [ ] The plugin denies source edits in planning.
- [ ] The plugin denies edits until the batch is fully claimed.
- [ ] `node --test scripts/harness-lib.spec.mjs` is green in under 1 s.

---

## 9. Story close evidence — US-01 (1.x backstage and file workflow)

> Recorded evidence for the orchestrator's close. The harness remains the source
> of truth; this section does not replace `--story` and cannot approve a story.

**Scope.** US-01 ports the `main` 0.1.8 backstage, the real Structure Library
templates, recent structures/documents, project Open versus Import, the File
menu, document tabs, close/discard and per-tab recovery onto the 1.x line while
keeping the local ONNX/OCSR recognition, the Models setup dialog and the `/v2`
contract (ADR 0009, ADR 0010).

### 9.1 Activities

| Activity | Result      | Evidence                                                                          |
| -------- | ----------- | --------------------------------------------------------------------------------- |
| ACT-01   | done        | foundation/docs refresh + ADR 0009; committed with ACT-04 as `557d6d2`            |
| ACT-04   | done        | version, release, screenshot and build-layout baseline reconciled; `557d6d2`      |
| ACT-02   | done (RED)  | nine workflow suites added and failing on missing modules; committed `0166525`    |
| ACT-03   | done        | models + UI; 9 suites / 189 tests green, full Vitest 485 at that point; `5f61fbb` |
| ACT-05   | done        | App/toolbar/Models integration, ADR 0010; build green; `2907610`                  |
| ACT-07   | done        | single-document recovery path removed; typecheck/tests/`--fast` green; `3c47063`  |
| ACT-06   | done (auto) | this evidence and the manual checklist; packaged payload smoke                    |

ACT-02 is the story-scoped TDD order: its tests named modules that did not exist
yet and ACT-03 owned the green gate. `--activity` has no test-first mode, so the
RED state is recorded rather than forced green.

### 9.2 Commands run for this close (2026-11-21)

| Command                                                 | Result                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm test`                                             | **477 passed** (21 files)                                                                             |
| `cargo test -p indigo-server`                           | **234 passed**, 12 ignored (model-gated)                                                              |
| `node --test scripts/lib/*.test.mjs`                    | **112 passed**                                                                                        |
| `pnpm run build`                                        | TypeScript + Vite production build green; 8.06 MB main chunk with the existing >500 kB warning        |
| `pnpm run typecheck`                                    | clean                                                                                                 |
| `pnpm run format:check`                                 | clean                                                                                                 |
| `cargo fmt --all --check`                               | clean                                                                                                 |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean                                                                                                 |
| `node scripts/harness.mjs --fast`                       | green; changed format/lint skipped (no changed files), structure and docblocks green                  |
| `node scripts/harness.mjs`                              | green iteration; changed gates skipped, structure/docs/docblocks and the test fallback green          |
| `pnpm run lint`                                         | **green after ACT-08**: 0 errors; the scope fix and its rationale are in §9.6                         |
| `task packages`                                         | green; produced the 0.1.8 `.deb`, `.rpm` and AppImage with the Docker `chemistry-builder` image       |
| packaged payload checks                                 | green; sidecar/Indigo present, no model/Imago/OpenCV/C++ runtime, one ONNX Runtime file plus symlinks |
| packaged sidecar with an empty model root               | green; `/v2/models` and `/v2/info` answered `200` as below                                            |
| `node scripts/harness.mjs --activity ACT-06`            | green; format (changed), structure, docs, test fallback, docsgen, docblocks and touches passed        |

`node scripts/harness.mjs` (iteration) reports `[SKIP] format/lint: no changed
files` on a committed tree, so the explicit commands above are the substantive
evidence. `--story` remains the orchestrator's gate.

### 9.3 Packaged smoke (automated part)

`task packages` built the 0.1.8 payloads inside Docker:

| Artifact | Bytes      | Note                               |
| -------- | ---------- | ---------------------------------- |
| `.deb`   | 29,696,028 | 19,064 B more than the 0.1.7 build |
| `.rpm`   | 29,826,093 | 24,959 B more than the 0.1.7 build |
| AppImage | 28,023,288 | 12,288 B more than the 0.1.7 build |

Payload inspection on the 0.1.8 artifacts:

```bash
V=0.1.8
DEB=build/packages/chemistry-draw_${V}_amd64.deb
RPM=build/packages/chemistry-draw-${V}-1.x86_64.rpm
APPIMAGE=build/packages/chemistry-draw_${V}_amd64.AppImage
mkdir -p build/appimage-${V} && (cd build/appimage-${V} && "$APPIMAGE" --appimage-extract)
```

- Non-vacuity passed: `usr/bin/indigo-server`, `libindigo*.so` and the ONNX
  Runtime chain are in the `.deb`, the `.rpm` and the extracted AppImage.
- The absence greps printed nothing: no `.onnx`, `models/`, `manifest.json`,
  Imago, OpenCV, `libstdc++` or `libgcc_s`.
- Each payload carries one real `libonnxruntime.so.1.31.0` (29,345,384 B) and the
  `.so.1`/`.so` symlinks.

Packaged sidecar from the extracted AppImage, empty model root, packaged
`LD_LIBRARY_PATH`, no `ORT_DYLIB_PATH`:

```bash
CLEAN=$(mktemp -d)
export LD_LIBRARY_PATH=$PWD/build/appimage-0.1.8/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64
INDIGO_PORT=19321 INDIGO_NO_PARENT_WATCHDOG=1 CHEMISTRY_MODELS_DIR=$CLEAN \
  ./build/appimage-0.1.8/squashfs-root/usr/bin/indigo-server
# GET /v2/models -> 200
# { "ready": false, "manifest_present": false, "installed_bytes": 0,
#   "total_bytes": 323987190, "download": "idle" }
# GET /v2/info -> 200, imago_versions: []
```

The log named the absolute model root and no manifest or Hugging Face request
was made. The packaged GUI itself is **not** verified here: a headless
environment cannot drive the WebView. The user's pass uses §10.

### 9.4 Verified vs pending

| Area                                                                 | Status                                   |
| -------------------------------------------------------------------- | ---------------------------------------- |
| Frontend unit/contract suites (477), sidecar (234), contracts (112)  | verified                                 |
| TypeScript typecheck, Prettier, rustfmt, Clippy                      | verified                                 |
| Production frontend build                                            | verified                                 |
| 0.1.8 package build, payload contents and packaged sidecar           | verified                                 |
| Full lint gate                                                       | verified; config scope fixed in §9.6     |
| Backstage, tabs, file workflow, per-tab recovery in the real WebView | **pending the user's manual pass (§10)** |
| Real recognition inference, model download/verify/repair, Windows    | not part of this headless close; see §2  |

### 9.5 Residual limitations

- **The lint gate needed a config fix to be green.** `pnpm run lint` used to
  report 368 errors in six files: five generated TypeDoc assets under
  `docs/generated/api/assets/` and `.opencode/plugins/harness-guard.js` (`no-undef`
  plus generated-code rules). `src/`, `scripts/` and the sidecar were already
  clean. ACT-08 fixed the scope in `eslint.config.js`; see §9.6.
- **The packaged GUI smoke is pending.** The checklist in §10 is the manual
  evidence; unit tests cannot substitute for it.
- **ACT-02 closed on recorded RED evidence.** The harness has no tests-first
  mode; this is a known harness gap, not a skipped gate.
- **Packaged Indigo reports `1.51.0-dev.1`.** The builder image's Indigo differs
  from the `1.49.0` pinned in `docs/CHECKPOINTS.md` C6 and the Windows fetch
  script. US-01 did not change the native library pin; packaging/tooling drift
  belongs to US-10.

### 9.6 Close-gate hygiene (ACT-08)

Two close-gate defects were outside US-01 source and were fixed here so the
full `--story` lint and recognition evidence can run.

**Generated docs are lint output, not source.** `docs/generated/` is TypeDoc
build output produced by `bash scripts/docsgen.sh`; it is git-ignored and never
authored. Linting it reported `no-undef` for browser globals and
generated-code rules (`no-unused-expressions`) that the generator's minified
assets cannot satisfy. `eslint.config.js` now ignores `docs/generated`, the same
way it already ignores `dist`, `build` and `target`. The `src/**/*.{ts,tsx}`
globals block stays browser-only, so authored source keeps its rules.

**The OpenCode plugin runs in Node.** `.opencode/plugins/harness-guard.js` reads
`process.env`; `process` is a Node global and the plugin is not part of the
browser bundle. A dedicated `files: [".opencode/**/*.{js,mjs}"]` block with
`globals.node` fixes that one `no-undef` without touching the plugin.

**The recognition poll budget must outwait the production bound.** The worker
resolves a job as a timeout at `PROCESSING_TIMEOUT` (120 s in
`src-tauri/sidecar/src/transport/imago.rs`), and the first inference also loads
the ~316 MB OCSR pair from disk. The model-gated
`caffeine_upload_recognizes_to_molfile` test polls with its own budget, which
must be strictly larger than the production bound; it is 150 s. The budget only
bounds how long the test waits for the worker. It never weakens an assertion:
the test still requires `SUCCESS`, a V2000 molfile with `M  END`, the `14 15`
counts line and the caffeine SMILES match. A 90 s budget failed on a cold run
while the inference itself succeeded (confidence 0.9957) at about 92 s; the
failure was the poll budget, not the pipeline.

Observed on 2026-11-21 after the fix: `pnpm run lint` reports **0 errors**
(368 before), and the gated caffeine test passes in 99.82 s, inside the 150 s
budget.

---

## 10. Manual GUI checklist — backstage and file workflow (1.x)

> Run this against the desktop build (`task run`), not the browser, unless a
> step says otherwise. Record each step's observed result; a step is passed only
> when the expected value is seen in the running app. Do not mark a GUI step
> from a unit test. A headless run cannot complete this checklist.

### 10.1 Setup (copy-paste)

Keep one shell open for the whole pass; the exported paths below are used by the
observation commands.

```bash
cd /home/jorge/Projects/chemistry-draw/chemistry-draw
GUI=/tmp/opencode/us01-gui-$(date +%s)
mkdir -p "$GUI/proj" "$GUI/data" "$GUI/models"
export GUI
export PROJ="$GUI/proj"
export XDG_DATA_HOME="$GUI/data"
export CHEMISTRY_MODELS_DIR="$GUI/models"
export APP_DATA="$GUI/data/dev.spalax.ChemistryDraw"
export RECOVERY="$APP_DATA/recovery/tabs"
export LOG="$APP_DATA/logs/chemistry-draw.log"
```

Start the app with the fresh profile and an empty model root:

```bash
task run
```

A new `$GUI` is a fresh install. To repeat from scratch, open a new shell and
rerun the block (the timestamp makes a new directory; nothing is deleted).

Create the two files used by the recent/open steps after the editor is usable:

```bash
# In the running app: draw benzene, File -> Save As -> $PROJ/benzene.ket
# Then draw aspirin (or any structure), File -> Save As -> $PROJ/aspirin.ket
```

The import step uses a plain SMILES file:

```bash
printf 'c1ccccc1 benzene\n' > "$PROJ/benzene.smi"
```

### 10.2 First start and Welcome

1. Launch with the block above. The window opens on the **backstage** overlay,
   not directly on the editor.
2. On the clean model root, the **Models** setup dialog opens once above the
   backstage. Click **Later**. The backstage stays visible behind it; no download
   starts (`curl -s http://127.0.0.1:9321/v2/models | jq .download.state` is
   `"idle"`).
3. The rail shows exactly four entries in this order: **Welcome**, **Open**,
   **Models**, **About**, plus **Back to editor** at the bottom. **Welcome** is
   selected.
4. The Welcome pane shows **Blank canvas**, **Import structure…**, **Open
   project…**, a **Templates** header with **More templates**, four template
   cards, and a **Recent structures** table with the columns **Structure Name**,
   **Format**, **Size**, **Indigo Validation**, **Last Modified**, **Actions**.
   On a fresh profile the table says **No recent structures**.
5. `Escape` closes the backstage. The editor and the tab strip are visible. The
   strip starts with the **Backstage** home button, then **File**, then one
   **Untitled** tab and `+`.
6. Click the home button: the backstage opens again on **Welcome**. The
   document, the active tab and the canvas are unchanged.
7. Open **About**: **Chemistry Draw** shows `0.1.8`; **Ketcher** shows `3.21.0`;
   **Indigo** and **Sidecar port** come from `/v2/info` (not `Unavailable` once
   the sidecar has answered); **Platform** and **Runtime** are real values and
   **Runtime** says `Desktop (Tauri)`.

Pass criteria: the launch surface is the backstage, no fake model list is shown,
and no native GTK/Win32 dialog appears.

### 10.3 Template cards

1. Draw something in the first tab, then open the backstage (home button).
   Because a real document exists, Welcome shows **Back to editor — <title>**
   above **Blank canvas**.
2. The four cards are real Structure Library entries with rendered previews
   (functional groups and salts/solvents), not an empty grid or a curated
   hand-written pool. Hovering a card shows the template name.
3. Click one card. The backstage closes, a **new tab** appears with the
   template's name, the canvas contains that structure, the tab shows the dirty
   dot, and the previous document is still in its own tab.
4. Open the backstage again and click **More templates**. The backstage closes
   and Ketcher's own **Structure Library** dialog opens. Close it with Cancel.
5. The pane samples four cards again (a new backstage open may pick a different
   four); the preview renderer never leaves a skeleton card on screen.

### 10.4 Recent structures and recent documents

1. After saving `benzene.ket` and `aspirin.ket` in 10.1, open the backstage.
2. **Welcome → Recent structures** lists the saved documents newest first, with
   name, `KET` format, a non-`—` size, a modified date, an Indigo validation
   badge (e.g. `Valid`) and a real thumbnail. A row whose file was moved still
   appears with `—`/`Unknown` rather than disappearing.
3. Click **Open** on a row: the backstage closes and that document becomes the
   active tab (or its existing tab is activated; no duplicate).
4. **Open → Remove** deletes only the remembered entry; the file stays on disk
   and the row disappears from both Welcome and Open after reload.
5. The **File** menu lists the same remembered paths under **Recent documents**
   (newest first) with the base name. With no entries it says **No recent
   documents**.

### 10.5 Open versus Import

1. **File → Open…** opens the native dialog titled **Open** with a **Ketcher
   files** filter (`.ket`). Choose `$PROJ/benzene.ket`. A new tab opens with the
   `benzene` title, the `.ket` path is attached (Open pane shows the path, not
   `Not saved yet`), the tab is clean (no dirty dot), and the path moves to the
   front of **Recent documents**.
2. Open the same path again: the existing tab is activated and an in-app
   **Already open** notice says **This document is already open.** No second tab
   is created and no file is read twice.
3. **File → Import…** opens the native dialog titled **Import** with a
   **Structures** filter (`.mol`, `.smi`, `.inchi`, `.sdf`, `.rxn`). Choose
   `$PROJ/benzene.smi`. A new tab opens named `benzene`, the canvas has the
   structure, the tab is clean, but the Open pane says **Not saved yet** (no
   `.ket` path). It is not added to Recent documents until its first Save.
4. Press `Ctrl+S` on the imported tab: the Save As dialog opens with
   `benzene.ket` (not `untitled.ket`); saving attaches the path and adds it to
   Recent documents. The document is now a `.ket` project.
5. From the backstage, **Open project…** behaves like File → Open (`.ket` only)
   and **Import structure…** behaves like File → Import (structure formats).
6. Importing a `.ket` through Import is not offered by the filter; opening a
   `.mol` through Open is not offered either.

### 10.6 File menu

1. The **File** button sits immediately after the home button, before the
   tabs. It opens a popup with the command rows in this exact order: **New**,
   **Open…**, **Import…**, **Save**, **Save As…**, **Export…**, then a separator,
   the **Recent documents** heading and the recent entries.
2. Keyboard: `ArrowDown` on the trigger opens the menu on the first item;
   `ArrowUp` opens on the last; `ArrowDown`/`ArrowUp` cycle; `Home`/`End` jump
   to the edges; `Escape` closes and returns focus to **File**; `Tab` closes it.
3. Clicking outside the popup closes it. While it is open, `Ctrl+S` closes the
   menu and does **not** save (the shortcut is consumed); a second `Ctrl+S`
   saves normally.
4. Every row dispatches the same command as the corresponding toolbar button
   and shortcut; the popup itself never reimplements a save/open/export rule.

### 10.7 Tabs: create, switch, close

1. `+`, `Ctrl+T` and **File → New** each create a new document; New reuses an
   untouched empty tab instead of stacking a second blank one.
2. With two documents, click a tab to switch: the title, canvas, dirty marker and
   path follow the tab. Switching flushes the outgoing tab's snapshot first; no
   change event dirties the incoming tab.
3. `Ctrl+Tab` cycles forward and `Ctrl+Shift+Tab` backward; `ArrowRight`/
   `ArrowLeft` move the roving tab focus; `Ctrl+W` closes the active tab;
   middle-clicking a tab closes it; the `×` on the active or hovered tab closes
   it.
4. Closing a clean tab removes it without a prompt. Closing the last tab leaves
   one fresh empty **Untitled** tab (the window never has zero tabs).
5. Closing a dirty tab prompts for **Save**, **Discard**, **Cancel**. Cancel
   keeps the tab; Save writes the `.ket` (Save As when untitled) and then closes;
   Discard closes without writing and removes that tab's snapshot.
6. `Ctrl+W` and `Ctrl+Tab` never reach Ketcher while a dialog (backstage, Models,
   Export, close prompt, error, notice) is open; the combination is consumed.

### 10.8 Save, Save As, Export

1. **Save** on an untitled document opens the native dialog titled **Save
   structure** with `untitled.ket`; saving writes `.ket` JSON, clears the dirty
   dot, updates the tab title and the snapshot.
2. **Save** again after an edit writes the same file with no dialog and the
   title/dirty marker updates.
3. **Save As…** (`Ctrl+Shift+S`) writes a second `.ket`, changes the tab's path
   and title, and leaves the first file unchanged.
4. **Save As…** to a path already owned by another tab is refused with the
   in-app **Already open** notice; no file is written and the active tab keeps its
   path.
5. **Export…** opens the in-app **Export** dialog listing **Molfile V2000**,
   **Molfile V3000**, **SMILES**, **InChI**, **SVG image** and **PNG image**.
   Export each one: the file is non-empty, opens in an independent viewer, and
   the tab title, `.ket` path and dirty state do not change. A following Save
   still writes the `.ket` file, not the export.
6. `Ctrl+S` never opens Ketcher's native Save As or its image-save dialog. The
   toolbar **Save**, **New**, **Export** and **Models** controls dispatch the
   same commands as the File menu.

### 10.9 Per-tab recovery after restart

1. With two tabs, make both dirty (edit each, switch tabs so the flush runs).
   Wait at least 2 s for the debounce. Inspect the recovery directory:

   ```bash
   ls -l "$RECOVERY"
   jq . "$RECOVERY/index.json"
   for f in "$RECOVERY"/tab-*.json; do echo "--- $f"; jq . "$f"; done
   ```

   Expected: one `<id>.ket` plus `<id>.json` per tab and `index.json` with the
   strip order and the active id. The metadata is
   `{ name, path, savedAt, dirty }`. No `autosave.ket`/`autosave.json` exists at
   the recovery root.

2. Kill the app while dirty (`kill -9 <pid>`; do not close the window). Relaunch
   with the **same** `XDG_DATA_HOME`/`CHEMISTRY_MODELS_DIR`. The backstage opens
   on Welcome; no Restore/Discard prompt appears. Closing the backstage shows
   the same tabs, order, active tab and dirty content. The dirty dot is still
   present on the restored dirty tabs.
3. Save the dirty tab, close the window cleanly (no prompt) and relaunch: the
   saved tab is clean and still present, the other tab is unchanged, and no
   prompt appears.
4. Close one tab and inspect `index.json` again: only that tab's `.ket`/`.json`
   are gone and the index lists the survivors. Relaunch: only the survivors
   restore; the closed tab does not come back.
5. Window close → **Discard** (see 10.12) removes every dirty snapshot and keeps
   the clean survivors; relaunch restores only the clean tabs.
6. With the app closed, corrupt one snapshot: append an invalid fragment to a
   `<id>.ket` (e.g. `printf '{' >>`). Relaunch: that tab is dropped, the remaining tabs restore, or
   one empty tab appears when none survives; the app stays usable and the log
   has the restore warning, not a crash.
7. An imported (path-less) tab restores too because its content was serialized
   to `.ket` before the snapshot; after restore the Open pane still says
   **Not saved yet** and the first Save As attaches the path.

### 10.10 Models rail and the real dialog

1. Open the backstage and choose **Models**. The pane shows **Open model
   setup** and the sentence about downloading, verifying and repairing the local
   OCSR models. It never renders a fake model list, counters or download
   controls of its own.
2. Click **Open model setup**: the real **ModelSetupDialog** opens **above** the
   backstage overlay. With the empty root it lists **Image classifier** and
   **Structure recognition**, the total `323987190` B (about 309 MiB), the state
   **Not installed**, and no download has started. Close with **Later**: the
   backstage is still behind it and the dialog does not reopen by itself.
3. The same dialog opens from the editor toolbar **Models** control while that
   control is visible. Close the backstage first if needed; the toolbar and the
   rail are two entry points to one dialog, not two surfaces.
4. With a healthy ready install the toolbar **Models** control is hidden, but
   the rail **Models → Open model setup** still opens the dialog (Installed /
   Verify). Closing returns to the backstage.
5. No model setup state shows a native `message()`/`confirm()` or a browser
   `alert()`; errors stay in the dialog's `role="alert"` region.

### 10.11 Recognition still works

Run this with the repo's installed models (`models/` and `.ort/linux-x86_64/`
present) and the repo `models/` root, not the empty one from 10.1. The explicit
`CHEMISTRY_MODELS_DIR` also overrides the value exported in 10.1:

```bash
GUI2=/tmp/opencode/us01-gui-models-$(date +%s)
mkdir -p "$GUI2/data"
CHEMISTRY_MODELS_DIR=$PWD/models XDG_DATA_HOME="$GUI2/data" task run
```

1. `/v2/info` advertises `imago_versions: ["local-ocsr"]`, the toolbar shows
   **Recognize Molecule**, and the Models dialog does not auto-open on a healthy
   ready install.
2. **Recognize Molecule** opens Ketcher's **Import Structure from Image** dialog
   with no Imago version selector. Choose
   `src-tauri/sidecar/fixtures/caffeine.png`, confirm the preview and click
   **Add to Canvas**: the caffeine structure appears with 2D coordinates and the
   job's molfile is V2000.
3. Repeat with `chinese_character.jpg` (or `random_scatter_plot_64933.png`): the
   job fails with **No molecule was detected in this image.** and the in-app
   **Structure problem** dialog appears (title **Structure problem**, a single
   **Close**). No native OS alert or second window appears; no raw JSON is shown.
4. Draw, Save, Open and Export still work after recognition; the `.ket` path and
   document format do not change. `Ctrl+Z` still undoes the inserted structure.
5. With the empty root from 10.1, Recognize is disabled (`[]`); the Models
   dialog is the supported way to enable it. After a successful download the
   control enables without remounting the editor or losing the canvas/undo
   history (see §2 "Model setup UI (B3)").

### 10.12 Window close guard

> `<appDataDir>` is `$APP_DATA` in this pass. The matrix is the 1.x contract:
> Save is offered only for a single dirty **active** tab.

1. All tabs clean → close the window: it closes immediately, no dialog, no
   snapshot is written for a clean tab.
2. One dirty active tab → close: in-app **Save changes?** with **Save**,
   **Discard**, **Cancel**.
   - **Cancel**: window stays open, structure and tab intact.
   - **Save**: the `.ket` is written and the window closes; cancel the Save As
     dialog (untitled document) and the window stays open.
   - **Discard**: window closes without writing; that tab's dirty snapshot is
     removed.
3. One dirty **inactive** tab (active tab clean) → close: **Unsaved changes**
   with **Discard** and **Cancel** only (no Save). Cancel keeps the window;
   Discard closes and removes only dirty snapshots.
4. Two or more dirty tabs → close: **Unsaved changes** naming the count, with
   **Discard** and **Cancel** only. Discard removes all dirty snapshots and
   rewrites `index.json` with the clean survivors; relaunch restores the clean
   tabs and no prompt appears.
5. A second close request while the prompt or a save is running is ignored. A
   close with a dialog open still uses the same in-app guard; no native dialog
   appears.
6. Relaunch after each variant and confirm the recovery directory and the tab set
   match the choice above.

### 10.13 Result record

Copy this table into the story-close evidence and fill it in the running app:

| Step                         | Result | Observed value / note |
| ---------------------------- | ------ | --------------------- |
| 10.2 First start / Welcome   |        |                       |
| 10.3 Template cards          |        |                       |
| 10.4 Recents                 |        |                       |
| 10.5 Open vs Import          |        |                       |
| 10.6 File menu               |        |                       |
| 10.7 Tabs                    |        |                       |
| 10.8 Save / Save As / Export |        |                       |
| 10.9 Per-tab recovery        |        |                       |
| 10.10 Models rail/dialog     |        |                       |
| 10.11 Recognition            |        |                       |
| 10.12 Close guard            |        |                       |

A failed step is a story finding, not a checklist typo: file it or fix it, then
rerun the step. The packaged GUI pass is complete only when every row has an
observed result from the desktop build.
