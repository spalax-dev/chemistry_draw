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
