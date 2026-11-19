# Session History

> Append-only log of completed sessions/activities.

---

## 2026-11-03 — Activity 2: docs → test → implement enforcement

- Added `scripts/lib/activity-policy.mjs` and 32 policy tests; harness block 3
  runs them and validates `activities.json`.
- Documented the mandatory docs → test → implement → review order, the
  `phase` field, the docs-only exception and strict sequential status in
  `AGENTS.md`, `README.md`, `docs/` and all agent prompts.
- `node scripts/harness.mjs` green; Linux sidecar 87 tests pass.
- Activity 1 (Windows build) remains blocked on its Windows CI run.

---

## 2026-11-03 — Activity 1: Windows build without Imago

- Windows x86_64 now builds from native Indigo 1.46.0 DLLs; Imago/OpenCV are
  compiled out, `/v2/info` reports `imago_versions: []`, the Imago routes are not
  registered and `imago-worker` is a stub that is not bundled.
- Pinned the Indigo archive by SHA-256 and generate the MSVC import libraries at
  fetch time (`scripts/fetch-windows-libs.ps1`).
- Fixed two bundle-time version mismatches: `tauri-plugin-log` 2.9.2 → 2.10.1,
  and `@tauri-apps/api`/`cli` 2.11 → 2.12.4 after `tauri` moved to 2.12.5. The
  harness now checks every plugin pair and the core `tauri`/api pair.
- CI run 41719701028 green: sidecar, harness (88 tests), smoke test and NSIS.
  Artifact `chemistry-draw_0.1.3_x64-setup.exe` (11 MB) verified to contain the
  app, `indigo-server.exe`, Indigo DLLs, VC runtime and WebView2 bootstrapper,
  with no `imago-worker.exe`.
- Follow-up: `release.yml` still publishes Linux packages only; Windows
  publishing is not wired to releases yet.

## 2026-11-03 — Activity 1: Windows NSIS build without Imago

- Windows CI run `41719701028` passed on `windows-latest`: 88 sidecar tests,
  sidecar smoke test, NSIS build and artifact upload.
- Artifact `chemistry-draw-windows-nsis` (11,074,058 bytes) uploaded.
- Pinned EPAM Indigo 1.46.0 Windows DLLs, generated MSVC import libraries,
  compiled Imago out on Windows and disabled Recognize Molecule.
- Linux CI passed in the same run; Tauri JS/core versions are aligned at 2.12.
- Activity 2 (docs → test → implement → review enforcement) also done.

## 2026-11-03 — Activity 3: publish the Windows installer

- Extracted the Windows job into `.github/actions/windows-build` (toolchain,
  pinned Indigo DLLs, sidecar build/stage, harness, smoke test, NSIS bundle).
- `ci.yml` now calls the action and uploads the artifact; `release.yml` adds a
  `windows-packages` job with the same gating as the Linux publish job and
  attaches `target/release/bundle/nsis/*.exe` to the release. Manual runs keep
  the workflow artifact.
- Added `scripts/lib/release-workflow.test.mjs` (YAML structure tests) and made
  the harness run every `scripts/lib/*.test.mjs`; 37 tests pass.
- README and `docs/architecture.md` document the Windows release artifact.

## 2026-11-03 — Activity 4: per-machine Windows install

- Installing the NSIS bundle as the default current user left WebView2 scoped to
  that account (or failed without elevation), so the app showed "Could not find
  the WebView2 Runtime".
- `src-tauri/tauri.windows.conf.json` now sets `bundle.windows.nsis.installMode`
  to `perMachine`; the installer asks for admin and installs WebView2 for every
  user. The embedded bootstrapper still needs network; offline targets can use
  `offlineInstaller` (+127 MB).
- Added `scripts/lib/windows-bundle.test.mjs` (install mode, WebView2 mode,
  Imago-free bundle). Harness green with 40 tests.

## 2026-11-03 — Activity 5: WebView2 offline installer

- Per-machine install alone did not fix "Could not find the WebView2 Runtime":
  bootstrapper-based modes download WebView2 during installation and can fail
  silently (offline, proxy, policy).
- `tauri.windows.conf.json` now uses `webviewInstallMode: offlineInstaller`,
  embedding the full Evergreen installer (~127 MB). No network is needed at
  install time; the installer grows to roughly 140 MB.
- `scripts/lib/windows-bundle.test.mjs` pins `offlineInstaller` + `perMachine`.
  Harness green with 41 tests.

## 2026-11-03 — Activity 6: revert WebView2 bundling

- Bundling WebView2 and switching to a per-machine install were mistakes:
  WebView2 ships with normal Windows 10/11 installations, and the offline
  runtime grew the installer to 217 MB.
- `src-tauri/tauri.windows.conf.json` restored to the 0.1.5 content (default
  per-user install, `embedBootstrapper` + silent).
- `scripts/lib/windows-bundle.test.mjs` now pins those choices so they are not
  changed again by accident.
- README/docs note that systems with Edge/WebView2 removed are unsupported.

## 2026-11-12 — Activity 1: ket-document-autosave

Worktree `../chemistry-draw-backstage-menu`, branch `feat/file-workflow`, based on
`main` (Imago era, `c18046c`). Six tasks: docs → test → implement → implement →
fix → review, with one review round that returned REQUEST_CHANGES and a clean
re-review.

- **Policy:** `.ket` is the only save format. Save / Save As write `.ket`;
  Export is the only route to Molfile V2000/V3000, SMILES, InChI, SVG and PNG
  (`generateImage(ket, { outputFormat })`; `exportImage` is deliberately unused
  because it downloads directly and only renders SVG in 3.18) and never changes
  `path` or `format`.
- **Document model:** one document per window (`{ path, format: "ket", dirty }`),
  title `<name|Untitled>` + `*`, dirty driven by `ketcher.changeEvent`.
- **Autosave:** `.ket` + `{path, savedAt, dirty}` metadata in
  `<appDataDir>/recovery/`, 2 s debounce + 30 s interval, only while dirty, never
  the user's file; a write generation counter stops an in-flight write from
  recreating a cleared snapshot.
- **Recovery:** on launch, a snapshot newer than the original's mtime offers
  Restore/Discard in-app; Restore re-attaches the path and stays dirty.
  Missing/unreadable originals still offer recovery, with copy naming a vanished
  file.
- **Close guard:** `onCloseRequested` + Save/Discard/Cancel; New and Open reuse
  the same prompt, so a dirty document is never replaced silently.
- **UI:** all new dialogs are in-app components on Ketcher tokens (`Dialog`,
  `Button`, overlay `rgba(94,94,94,0.8)`), with `role="dialog"`, `aria-modal`,
  focus trap and Escape (recovery = Discard, close = Cancel). No native dialogs
  in new code.
- **Environment:** `task libs` rebuilt the shared `chemistry-builder` image from
  main's Dockerfile (Imago + OpenCV) and the sidecar binaries were built with
  the target-triple names Tauri expects before Clippy.
- **Tests:** 60 frontend tests (37 document, 23 autosave), 87 sidecar tests;
  typecheck, ESLint, Prettier, rustfmt, Clippy and ShellCheck clean; full harness
  green.

## 2026-11-12 — Activity 2: ketcher-toolbar-integration

- Removed the temporary bottom-left dock. Save, New and Export are now
  `customButtons` entries in Ketcher's top toolbar; clicks arrive as
  `CUSTOM_BUTTON_PRESSED` custom actions on `ketcher.eventBus`.
- Kept Ketcher's native **Save As…** (its dialog defaults to Molfile) as the
  click-only route to other formats. `.ket` defaulting comes from the app Save.
- The pre-existing Vite alias `file-saver` → `src/fileSaver.ts` now routes every
  native save: `.ket` → document save (path or Save As), other extensions →
  export save, no Tauri/handler → download. Pure `src/saveRoute.ts`, 19 tests.
- Shortcuts are captured on `window` (capture phase) and consume the event
  before the dialog/busy early return, so Ketcher's `Mod+S` dialog cannot open
  even while a save is in flight.
- Review: first round REQUEST_CHANGES (shortcut ordering, wrong hotkey evidence
  in docs, four inaccurate doc rows, a stray `src-tauri/untitled.ket`), fix task
  `f`, re-review PASS; C9 ticked.
- Gates: 79 frontend tests, 87 sidecar tests, typecheck, ESLint, Prettier,
  rustfmt, Clippy, ShellCheck and the full harness green.
- Still needs a GUI run: toolbar rendering/icons, live custom actions, shortcut
  behaviour against Ketcher's handlers, Tauri dialogs and the manual checklists.

## 2026-11-13 — Activity 3: toolbar-icon-native-style

- The user rejected the first icons: bigger than Ketcher's and filled. Measured
  the native ink boxes (save 4.5-19.4, open 4.0-19.8 x 5.0-18.9 → ~15x15 in a
  24 viewBox) versus ours (17-20 units, solid fills).
- Final design: transparent `imageLink` + CSS mask painted with
  `background-color: currentColor`, keyed by `img[alt="Save"|"New"|"Export"]`
  scoped to `.Ketcher-root`, so the button's colour drives default #333333,
  hover #167782 and the active state exactly like native icons.
- Glyphs redrawn as outlines (`fill=none`, 1.5-unit stroke, round caps) inside a
  15x15 live area; measured ink 4.5-19.5 for all three, matching native weight.
- Review rounds: REQUEST_CHANGES (solid fills/oversize, literal `black`, loose
  live-area guard, docs wording) → fixes → PASS. 10 icon tests.

## 2026-11-13 — Activity 4: hide-native-save-as

- Hid Ketcher's native "Save As…" entry with `buttons={{ save: { hidden: true } }}`
  (`src/ui/editorButtons.ts`, `as ButtonsConfig` because Ketcher's `ButtonName`
  union omits `save` while `isHidden`/`FileControls` read it at runtime).
- `recognize` stays hidden; no CSS or DOM hiding, no Ketcher edits.
- Consequences documented: Export is the only format route; the native save
  dialog and its image-save entry are unreachable; remaining library saves still
  use the `file-saver` alias; `Ctrl/Cmd+S` remains intercepted.
- Review: REQUEST_CHANGES (a stale manual step still used the native image
  save) → fix → PASS. 93 frontend tests.

## 2026-11-13 — Activity 5: native-modal-backdrop

- Ketcher's native modal overlay is `rgba(94,94,94,0.2)` with `background-color .3s`
  (`.Modal-module_modalOverlay` / `_animate` / `_hide`), and its panel is white
  with an 8 px radius, no border and no shadow (`.Dialog-module_dialog`).
- Tokens now carry `color.overlay` (0.2), `color.overlayHidden` (0.01) and
  `dialog.{radius,border,shadow,transition}`; `Dialog` fades the backdrop in on
  first paint (rAF, cleaned up) and builds the panel from those tokens.
- Every in-app dialog inherits it; per-dialog overrides are forbidden.
- Documented divergences: no panel transform/opacity entrance, flat overlay
  (Ketcher adds a 2 % hatch) and `position: fixed` above the app instead of
  `absolute`/`z-index: 40` inside the editor.
- Review: REQUEST_CHANGES (two overstated doc claims, missing pre-fade
  assertion) → fix → PASS. 98 frontend tests.

## 2026-11-13 — Activity 6: dialog-hatch-pattern

- Ketcher's native overlay is not a flat wash: `.Modal-module_modalOverlay`
  paints a 10x10 repeating SVG tile of diagonals (`#555`, width 2, opacity .02)
  over `rgba(94,94,94,.2)`. The `background:none\9` beside it is an IE9 hack.
- The exact 211-byte data URI now lives in `tokens.dialog.backdropPattern`
  (plus `backdropRepeat: repeat`, `backdropSize: 10px 10px`) and the shared
  `Dialog` overlay applies it; the colour still fades 0.01 -> 0.2 over 0.3 s
  while the image stays static.
- Verified byte-for-byte against the Ketcher CSS and rasterised: 10 px pitch,
  ~2 % stroke, no seam when tiled.
- Docs: conventions/verification/testing describe the hatch; the former "flat
  overlay" divergence is gone. 102 frontend tests.

## 2026-11-13 — Activity 7: hatch-background-image-url

- The hatch never painted: `Dialog` assigned the bare data URI to
  `backgroundImage`, but CSS needs `url("…")`, so the declaration was invalid
  and silently dropped (flat 20 % wash, no console error).
- Fix: the token stays the raw data URI and the overlay builds
  `url("${tokens.dialog.backdropPattern}")`. Confirmed in headless Chromium:
  bare = 1 colour in a strip, wrapped = 2 colours (hatch at 10 px pitch).
- Tests guard both directions (no bare assignment, token not pre-wrapped,
  repeat/size wired); docs record the raw-token/CSS-function rule.
- 105 frontend tests, harness green.

## 2026-11-13 — Activity 8: fs-scope-autosave

- Autosave failed with `forbidden path: .../dev.spalax.ChemistryDraw/recovery:
... allow-mkdir` because `fs:scope` only had `"**"`, a relative pattern that
  cannot match absolute paths.
- Scope is now `$APPDATA/**` (appDataDir/recovery) and `$HOME/**` (documents
  restored without a dialog grant); dialog-picked files keep their runtime
  per-path grant from the dialog plugin. No Rust changes.
- `src/capabilities.test.ts` guards the scope entries and the fs command list
  (109 frontend tests). Docs describe the scope model and the two manual checks.
- GUI verification pending: no WARN while editing, and Restore -> Save.

## 2026-11-13 — Activity 9: host-fontconfig-libs

- The sidecar logged ~45 `Fontconfig warning` lines per PNG render: the builder
  bundled Debian 12's libfontconfig 2.14, which cannot parse Fedora 45's newer
  /etc/fonts config.
- Fix: stop bundling platform font/PNG libs (`libfontconfig*`, `libfreetype*`,
  `libexpat*`, `libpng*`, `libbrotli*`) in build-libs.sh, the Taskfile libs
  copy and bundle-libs.sh, and drop the already-copied files.
- Verified with the real sidecar: render PNG against host libs -> 0 warnings,
  same output; `ldd` resolves them from the distro. 113 frontend tests.
- Follow-ups noted: strengthen the skip-list test against over-broad patterns;
  `libstdc++` is still shipped by the Arch PKGBUILD (pre-existing).

## 2026-11-13 — Activity 10: ketcher-rebond-guard

- Symptom: the renderer flooded `TypeError: undefined is not an object
(restruct.molecule.halfBonds.get(bond.hb1).p)` every frame after a
  struct/render desync (invalid-valence edit, undo of a deletion).
- Cause: Ketcher 3.18 `ReBond.getSelectionPoints` dereferences both half-bonds
  without checking; upstream fixed it in epam/ketcher#11165.
- Fix: extended `patches/ketcher-core@3.18.0.patch` (cumulative with the
  `parametrizeUrl` hunks) for `rebond.js` and `rebond.modern.js`:
  `getSelectionPoints` returns `[]` on a missing half-bond,
  `getSelectionContour` returns null, and the plate/drawHover callers no-op.
  `pnpm install` re-applied with the new patch hash; build uses the modern file.
- Not ported (outside this crash path): upstream's `setDoubleBondShift`,
  `stereoUpBondGetCoordinates` and `show` guards.
- `src/ketcherPatch.test.ts` guards the hunks and the installed dist (116 tests).

## 2026-11-13 — Activity 11: document-tabs

- Tabs hold file state only (`{id, path, ket, dirty}`); exactly one Ketcher
  instance. Switching serializes the outgoing tab with `getKet`, flushes its
  snapshot, sets a loading flag and loads the target with `setMolecule`, so the
  incoming tab is never dirtied by the programmatic load.
- Per-tab snapshots: `recovery/tabs/<id>.ket|json` + `index.json` (order +
  active id), serialized queues per tab and for the index, per-tab write
  generations and cleared-tab tombstones. Corrupt `.ket` snapshots are rejected
  by `isKetDocument` and skipped; the active-tab restore falls back safely.
- Silent restore on launch (content, paths, order, active); a missing index
  starts with one empty tab. Overlay stays until restore finishes.
- Ketcher-token tab strip at the top: active/regular/hover colours, dirty dot,
  X and middle-click close, `+`, overflow, roving tabindex with arrow keys,
  Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+W / Ctrl+T.
- Close guard: 0 dirty closes; 1 dirty active -> Save/Discard/Cancel; 1 dirty
  inactive or several -> Discard/Cancel only with matching copy. Discard clears
  only dirty tabs' snapshots and rewrites the index with survivors, after
  stopping the scheduler and clearing the `busyRef`, so an in-flight autosave
  cannot resurrect a discarded snapshot.
- Review: REQUEST_CHANGES twice (corrupt restore, guard copy, discard scope,
  index race; then the discard/autosave race) -> fixes -> PASS. 162 tests.

## 2026-11-13 — Activity 12: close-guard-copy

- The multi-tab prompt explained implementation limits ("Saving them all is
  not possible"). Replaced by a pure `closeGuardCopy` helper: state the
  situation, ask a question, offer only the actions that exist.
  - several: "Unsaved changes" / "N documents have unsaved changes." /
    "Are you sure you want to discard them?" / Discard + Cancel.
  - single inactive: same question with the document name / Discard + Cancel.
  - single active: "Save changes?" / "... has unsaved changes." /
    "Do you want to save them before closing?" / Save + Discard + Cancel.
- CloseGuardDialog renders the helper only; tests pin title, lines and action
  order; docs quote the new copy. 167 tests.

## 2026-11-13 — Activity 13: tab-strip-chrome

- Removed the doubled separator and the grey active fill. Final rule: one
  1 px `#cad3dd` line made of two layers — the strip's `inset 0 -1px 0` shadow
  (visible in the padding, gaps and after the last tab) and the inactive tabs'
  bottom border — while the active tab is white with no bottom edge, so the
  line disappears under it and the tab merges with the workspace.
- `tokens.tab.active = #ffffff`; strip `gap: 0`, no `borderBottom`; tabs keep
  top/left/right borders only plus the conditional bottom edge.
- Pixel-verified in headless chromium: exactly 1 px at y=35 across the strip,
  absent under the active tab, no 2 px band, height unchanged (36).
- `src/tabStrip.test.ts` pins both layers. Docs updated (conventions §6.6,
  architecture row, verification step 11, CHECKPOINTS C11). 174 tests.

## 2026-11-14 — Activity 14: open-as-project

- Root cause of the "Untitled pasted tab": non-.ket opens used
  `importedTab(id, text)` → `{path:null, dirty:true}` with no name, so the title
  could only say Untitled and every import looked unsaved.
- `TabState.name` added (display identity); `tabTitle` precedence path → name →
  Untitled; names drop the last extension for any file (`benzene.mol` →
  `benzene`), preserving `.ket`, Windows paths, extension-less names and dotfiles.
- Open split: `openProject` (.ket → path + name, clean) and `importStructure`
  (other formats → name, no path, clean), one entry dispatching by extension,
  untouched-tab reuse guarded by `name === null`.
- Save As defaults to `<name>.ket`; Export uses `<name>.<ext>`; window title and
  dialog copy use `tabDisplayName`. Snapshots persist `name` with a legacy
  fallback to the path base name.
- Review: REQUEST_CHANGES (names kept their extension) → fix → PASS. 193 tests.

## 2026-11-14 — Activity 15: file-menu

- The visible Open was Ketcher's native dialog (loads into the canvas, bypasses
  tabs/names/paths); our openProject/importStructure were only on Ctrl+O.
- Added a File button at the left of the tab strip (sibling of the tablist,
  Ketcher tokens, fixed popup with scroll) owning New, Open… (.ket only),
  Import… (structures, saved as .ket later), Save, Save As…, Export… and Recent
  documents (last 10 .ket, localStorage `chemistry-draw.recent`, dedupe, prune
  on missing file with an in-app error, visible empty hint).
- Hid Ketcher's native Open and Save As via `buttons`; removed the custom
  toolbar Save/New/Export buttons, their icons and injected styles.
- Open/Import are desktop-only (Tauri picker); Save/Export download in the
  browser and recents still persist.
- Review: REQUEST_CHANGES (docs claimed a browser fallback, empty-state wording,
  missing storage tests, ARIA nesting) → fix → PASS. 223 tests.

## 2026-11-15 — Activity 16: file-button-icon-and-native-open

- The File trigger now carries a 16 px document icon (currentColor, 1.5 stroke,
  round caps, 6 px gap) before its label.
- Ketcher's native Open is visible again: it is the deliberate "load a structure
  into the current canvas" path and does not touch the tab path/name or recents.
  Save As stays hidden; File → Open remains the `.ket` project open.
- 227 tests; Prettier drift in architecture.md fixed; harness green.

## 2026-11-15 — Activity 17: dedupe-open-path

- A `.ket` path belongs to at most one tab. Opening a path that is already
  open (File → Open or a recent entry) activates the owning tab and shows an
  in-app `Already open` notice instead of creating a divergent duplicate;
  Save As onto another tab's path is refused with the same notice.
- Matching is a pure `pathKey` (separators, trailing slash, Windows drive case
  folded, POSIX case preserved); `resolveOpenTarget`/`canSaveToPath` hold the
  decisions and are unit-tested.
- Restore dedupes snapshots by path (first wins, active id validated).
- Review: REQUEST_CHANGES (guard decisions untested, C13 unticked) → fix → PASS.
  251 tests.

## 2026-11-15 — Activity 18: backstage-menu

- Backstage implemented from the Stitch design, stripped of invented content:
  full-screen overlay with top bar, 260 px rail (New, Recent, Save & Export,
  Settings, About), content pane and a status strip with the real Indigo
  version/port and app version.
- Shown from the first frame at launch (the old loading splash is gone); the
  editor and silent tab restore run underneath. A home icon at the left of the
  tab strip opens it; Back to Editor/Escape return with the same tab and canvas.
- New/Recent (last 10 `.ket` + open tabs, path-uniqueness guard)/Save & Export
  reuse the existing handlers. Settings binds to ketcher.settingsService
  (curated real keys with unit pairs, ACS preset, reset, live subscribe). About
  reads package.json and /v2/info and links the real licenses.
- Focus trap, aria-modal, rail roving focus, Escape; all colours from tokens.
- Review: REQUEST_CHANGES (docs claimed untested behaviour, imageResolution cap,
  unticked C14) → fix → PASS. 279 tests.

## 2026-11-17 — Activity 19: remove-backstage-status-strip

- Removed the backstage footer (`Indigo … · sidecar :…` + app version) and the
  now-unused `formatBackstageStatus`, `starting` prop and `restoring` state.
- Also removed the Save & Export section from the backstage rail (New, Recent,
  Settings, About remain); Save/Save As/Export stay in the File menu only.
- About still shows the real Indigo version/port and app/Ketcher/React data.
- Contract tests assert the strip, formatter, `starting` and the section never
  return; docs updated. 284 tests.

## 2026-11-18 — Activity 20: backstage-models-placeholder

- Added a reserved **Models** entry to the backstage rail (New, Recent, Models,
  Settings, About) for future OCSR model management. The pane is deliberately
  empty: heading plus "OCSR models will be managed here.", no list, actions,
  versions or download affordances.
- A source contract test rejects any interactive control in the section; docs
  mark it as a reserved placeholder. 289 tests.

## 2026-11-18 — Activity 21: welcome-templates

- Rail renamed to Welcome, Open, Models, Settings, About and every item gained a
  16 px currentColor line icon (home, folder-open, cube, sliders, info).
- Welcome replaced New: title "Welcome", subtitle, Blank canvas / Import
  structure / Open project, and a Stitch-style TEMPLATES grid with four cards
  (line preview, name, description, tag).
- Cards insert real structures into a new dirty tab named after the template
  (path null, Save As on first save): benzene, cyclohexane and Ala-Gly via
  SMILES; the reaction uses a KET payload because Indigo's molecule converter
  rejects reaction SMILES. Cards stay disabled until the editor is ready.
- Open (formerly Recent) keeps text-only rows; previews are deferred until
  validated.
- Review: REQUEST_CHANGES (docs said clean Untitled, preview tests missing) →
  fix → PASS. 303 tests.

## 2026-11-18 — Activity 22: welcome-templates-polish

- Welcome now uses eight ring templates with a random, width-dependent visible
  subset (2/4/6/8 by viewport), a More templates button that opens Ketcher's
  Structure Library, and a prominent Back to editor action labelled with the
  active tab (dirty marker included) when tabs exist.

## 2026-11-18 — Activity 23: welcome-nonblank-and-more-templates

- Fixed the blank backstage: `renderSection` switches on `normalizeSection`, so
  a stale/unknown section id (HMR after a removed section) renders Welcome, and
  the rail highlights Welcome too. The backstage always reopens on Welcome.
- The template pool grew to 16 real rings (8 carbocycles + pyridine,
  pyrimidine, furan, thiophene, imidazole, pyrrole, piperidine, morpholine) with
  N/O/S vertex labels, so a wide window shows a random 8 of 16 and reshuffles
  each open. All 16 SMILES validated through the sidecar.
- Review: PASS with nits (rail normalized state, README count, C14 ticks, label
  contract) → applied. 351 tests.

## 2026-11-18 — Activity 24: real-template-library

- Welcome cards now come from Ketcher's real Structure Library: salts/solvents
  first, then functional groups (Ketcher appends salts to the groups list, so
  those names are skipped), each Struct serialized to KET and mapped to a
  descriptor (slug ids, name dedupe, empty skipped).
- Previews are rendered by Ketcher/Indigo with `generateImage(ket, {svg})`,
  cached per KET, with Rendering/No preview states; an empty library shows "No
  templates available". Click inserts the entry's KET into a dirty, path-less
  tab named after the entry.
- An armed template tool no longer leaks: `cancelActiveTool` dispatches Escape
  to the Ketcher root when the backstage opens or a tab is switched.
- The curated ring module is kept only as documented legacy; no card path reads
  it. Provider timing verified live (first render already populated).
- Review: REQUEST_CHANGES (empty-state claim, C14, stale legacy labels, one
  header) → fixed; 365 tests.

## 2026-11-19 — Activity 25: welcome-recent-structures

- Welcome gained the Stitch "Recent structures" table (Structure Name +
  thumbnail, Format, Size, Indigo Validation, Last Modified, Open), capped to
  the five newest, with loading/empty states.
- Real data only: `stat` for size/mtime, KET → Struct → molfile with
  KetSerializer/MolSerializer, then `structService.check` (Indigo) for the
  badge (Valid / Warnings / Invalid / unknown shown as `—`).
- Thumbnails are sidecar SVG renders cached at
  `<appDataDir>/previews/<sha256(molfile)>.svg` and served as data URIs; cache
  hits skip rendering, failures show a placeholder. `.ket` files are never
  modified and carry no preview field.
- A pure `buildRecentRow` covers the degradation matrix; 394 tests. Review:
  REQUEST_CHANGES (row model untested, cache key docs) → fixed → PASS.

## 2026-11-19 — Activity 26: welcome-first-run-and-four-templates

- Welcome always shows exactly four random cards from the Structure Library;
  the width-based 2/4/6/8 rule (and its resize listener) is gone.
- First run (only an untouched empty tab) hides Back to editor and makes Blank
  canvas primary; once a real document exists, Back to editor is primary and
  labelled with the active tab, and Blank canvas becomes secondary.
- The backstage top bar no longer has a Back to Editor control; the rail's Exit
  Backstage (and Escape) are the only exits.
- Tests pin the four-card count, the isUntouchedTab document predicate and the
  top-bar absence; 397 tests, harness green.

## 2026-11-19 — Activity 27: new-reuses-empty-tab

- Blank canvas / New now reuses the active tab when it is an untouched empty
  canvas instead of stacking another empty tab; with a real document it still
  creates one.
- Ketcher's `getKet()` returns a pretty-printed empty KET (`ket_version`), so the
  byte comparison with EMPTY_KET failed; added `isEmptyCanvasKet` (empty string,
  compact KET or serialized empty root) and used it in `isUntouchedTab`.
- `startNewDocument` decides the target before `getKet` and does not
  commit/flush on reuse; it resets the tab, writes one snapshot/index and skips
  `setMolecule` when the canvas is already empty.
- 410 tests, harness green.

## 2026-11-19 — Activity 28: welcome-actions-horizontal

- Welcome actions are a horizontal wrapping row (`row` + `wrap`, 8 px gap,
  720 px cap) with content-sized 36 px buttons instead of a vertical column;
  always at most four actions (Back to editor only with a document, Blank
  canvas, Import, Open). Primary emphasis and the four-card template grid are
  unchanged.
- Source/layout tests pin the row, sizing and action cap. 414 tests.

## 2026-11-19 — Activity 29: open-pane-rich-table

- The Open section now renders the same six-column Recent structures table as
  Welcome (thumbnail, format, size, Indigo validation, modified, actions), with
  Open and Remove (Welcome keeps Open only); the open-tabs list with Switch
  stays below. Both panes share the single App loader.
- Removed the stale "Open has no preview" contract; 419 tests.

## 2026-11-19 — Activity 30: template-previews-expanded

- Library entries are abbreviations, so Indigo rendered their label instead of
  the structure. Previews now render a copy of the KET with `expanded: true` on
  every SGroup (verified against the sidecar: expanded draws atoms); insertion
  still uses the original unexpanded KET.
- The library builds after paint through a shared promise and session cache, so
  Welcome paints four skeleton cards immediately instead of blocking on
  serializing the whole library; preview placeholders show an inline SVG
  spinner. Empty results are not cached and retry on a later backstage open.
- 432 tests, harness green.
