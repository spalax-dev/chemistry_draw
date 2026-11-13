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

## 2026-11-10 — Activity 1: remove Imago (Phase A)

- Activity 1 (`feat: remove-imago`) removed Imago end to end, following
  docs → test → implement → review.
- Docs: `architecture.md`, `verification.md`, `CHECKPOINTS.md` (C6 "No Imago
  Anywhere"), `conventions.md`, `testing.md`, `DEVELOPMENT.md`, `README.md`,
  `NOTICE`, `AGENTS.md`, `.gitignore`, `.opencode/agent/main-orchestrator.md`
  and the historical `KETCHER-BUG-parametrizeUrl.md` now describe an Indigo-only
  app; the contract is that Ketcher's _Recognize Molecule_ control is hidden
  until the DECIMER pipeline (Phase B) and that `/v2/info` + `/v2/health` expose
  no Imago fields, while `/v2/imago/*` does not exist.
- Tests: new cross-platform `src-tauri/sidecar/src/tests/imago_absent.rs`
  (5 tests: no `imago_versions` in `/v2/info` + `/v2/indigo/info`, no
  `imago_versions`/`imago_worker` in `/v2/health`, both Imago routes → 404) and
  `scripts/lib/no-imago-packaging.test.mjs` (11 tests pinning `externalBin`,
  sidecar bins/deps and build/packaging scripts). RED was confirmed first
  (5 failing Rust tests, 11 failing Node tests).
- Sidecar: deleted `ffi/imago*.rs`, `job/`, `service/imago_ops.rs`,
  `transport/imago.rs`, `bin/imago-worker.rs`; `AppState` is now
  `{ port, started_at }`; `build.rs` keeps the RPATH and drops `-limago`;
  `Cargo.toml` drops the worker bin and `uuid`; `tests/mod.rs` no longer builds
  a job store.
- Build/packaging/CI: `build-libs.sh` (no OpenCV/Imago), `Dockerfile`,
  `check-libs.sh`, `bundle-libs.sh`, `check-deps.sh`, all packaging scripts,
  `Taskfile.yml`, `tauri.linux.conf.json` (`externalBin` = `indigo-server`),
  `tauri.conf.json`, `ci.yml`, `release.yml`, `windows-build/setup` actions
  (smoke test now asserts absence) and `harness.mjs` `requiredLibs`.
- Frontend: `<Editor buttons={{ recognize: { hidden: true } }}>` in
  `src/App.tsx`; Ketcher only reads `options.buttons` from this prop, so hiding
  here leaves no dead (disabled) button.
- Review: `implementation-reviewer` requested docs fixes (historical banner for
  the Ketcher bug doc, roadmap current-state line, stale lapack/openblas
  packages, Windows-only smoke-test wording, examples); all fixed and
  re-reviewed as APPROVED.
- `node scripts/harness.mjs` green (exit 0): typecheck, ESLint, Prettier,
  frontend build, rustfmt, Clippy, 87 sidecar tests, ShellCheck.
- Roadmap Phase A marked complete; release builds and package-size comparison
  remain for the next release cut.

## 2026-11-10 — Activity 2: purge Imago from the builder image and artifacts

- The local `chemistry-builder` image (Oct 31) still carried `libimago.so` and
  OpenCV 4.6 under `/opt/chemistry/libs`, and packaging copied every `.so` from
  there into `src-tauri/lib`, so a rebuild would have re-shipped Imago.
- Rebuilt the image with `--no-cache` from the patched `build-libs.sh`:
  `/opt/chemistry/libs` went from 36 to **21 files**, zero imago/opencv.
- New `scripts/check-native-libs.sh`: fails on `*imago*`/`*opencv*` names and,
  with `--allowlist <source>`, on any library the builder image does not
  provide. Wired into `build-deb.sh`, `build-rpm.sh`, `build-appimage.sh` and
  `build-packages.sh` right after the native-lib copy.
- Packaging now snapshots `src-tauri/lib/linux-x86_64`, wipes it, copies only
  builder libs, and restores the checkout in an EXIT trap; `task libs` also
  wipes before copying. The Imago-era `libjpeg` trio that had been leaking into
  the payload from the dev dir is gone.
- Rebuilt artifacts (0.1.6, Imago-free): payloads bundle exactly the 21 builder
  libraries, no `imago-worker`, `libimago`, `libopencv` or `libjpeg`.
  Sizes vs the 0.1.0 Imago-era builds:
  - deb 34,340,202 → 19,829,342 B (−14.51 MB, −42.26%)
  - rpm 34,345,311 → 19,829,798 B (−14.52 MB, −42.26%)
  - AppImage 21,645,816 → 16,955,896 B (−4.69 MB, −21.67%)
    Removed payload: `imago-worker` (382,648 B), `libimago.so` (1,937,560 B) and
    the OpenCV trio (14.2 MB deduplicated, 38.1 MB as shipped with symlinks).
- Runtime check of the packaged sidecar: `/v2/info` and `/v2/health` expose no
  Imago fields; `/v2/imago/*` → 404; `/v2/indigo/render` still returns PNG.
- Docs: artifact payload verification is version-scoped and non-vacuous
  (`docs/verification.md`), C6 gained the artifact checkbox, `DEVELOPMENT.md`
  documents the guard/snapshot rules, and `ROADMAP.md` records the sizes.
- Review: implementation-reviewer rejected the first artifact build (host
  `libjpeg` leak + broken verification commands), all findings fixed, packages
  rebuilt and re-reviewed as APPROVED.
- Gates: `node --test scripts/lib/*.test.mjs` 65/65, ShellCheck clean,
  `node scripts/harness.mjs` green.

---

## Activity 3 — phase-b1-onnx-filter (feat, complete 2026-11-11)

ONNX Runtime foundation plus the DECIMER binary image classifier for the Phase B
image-recognition replacement.

- Delivery order: docs (contract, manifest schema, preprocessing invariants,
  binary limitation) → failing tests (RED) → runtime foundation → classifier
  endpoint → fix task → two reviews.
- Runtime: `ort` 2.0.0-rc.15, CPU, one intra-op thread, lazy cached sessions,
  **dynamic loading** (`load-dynamic`, `ort::init_from`) so the sidecar has no
  link-time ONNX Runtime dependency. The first review caught a static link that
  broke the Debian 12 build (glibc 2.38/GLIBCXX 3.4.31 symbols); the fix keeps
  the glibc 2.36 floor and restores the release sidecar to ~3.5 MB.
- Developer runtime: pinned ONNX Runtime 1.31.0 shared library fetched by
  `scripts/fetch-onnxruntime.sh` (SHA-256 verified) into gitignored `.ort/`;
  harness and the debug Tauri host set `ORT_DYLIB_PATH`. Shipping the runtime is
  a separate follow-up.
- Models: never committed or bundled. `models/manifest.json` + artifact under a
  gitignored `models/`, resolved via `CHEMISTRY_MODELS_DIR` (debug default
  `<repo>/models`). Manifest checks artifact SHA-256 and the graph tensor
  contract (names, dtypes, shapes; dynamic `-1` only on batch).
- Classifier contract: `input_2` f32 `[1,224,224,3]`, `45214:0` and `45216:0`
  f32 `[1,1,1,3]` zeros, output `Identity:0` f32 `[1,1]` logit;
  `score = sigmoid(logit)`, structure when `score <= 0.000089`.
- Preprocessing matches DECIMER `runtime_default`: white alpha composite,
  grayscale then RGB, aspect-preserving LANCZOS to 224, white centered pad,
  float32 NHWC 0..=255; no invert/equalize/sharpen/autocontrast. Decode bounded
  at 12,000 px/side and 128 MiB.
- Endpoint: `POST /v2/filter/classify`, raw PNG/JPEG/WebP, 10 MiB cap,
  200 with `contains_molecule`, `category`, `score`, `threshold`, `logit`,
  `model`; 400 unsupported/undecodable, 413 over cap (plain text, documented),
  503 missing/invalid runtime or model (WARN with actionable cause).
- Health: `onnxruntime_version` (API generation label) and `models` (ids declared
  by the manifest and present on disk); `/v2/info` unchanged.
- Tests: 113 default / 120 with `--include-ignored`; preprocessing, tensor
  contract, invalid-model 503s, exact Rec.601 grayscale, WebP, 10 MiB boundary
  and three MIT fixtures (caffeine structure; Chinese character and scatter plot
  no-structure). Model-gated tests run only when `models/` and the ORT dylib
  exist.
- Docs: architecture, conventions, testing, DEVELOPMENT, verification,
  CHECKPOINTS C8 and ROADMAP updated; NOTICE adds ONNX Runtime and `ort`.
- Review: first REQUEST_CHANGES (static link, any-axis dynamic dims, 503 logged
  as ERROR, missing invalid-model tests); fix task addressed every finding and
  the re-review returned PASS.
- Gates: harness green (blocks 1–13), policy tests 32/32, rustfmt/Clippy/
  ShellCheck clean.

---

## Activity 4 — image-check-ui (feat, complete 2026-11-12)

Manual image-classification path from the app UI, using the B1 sidecar endpoint.

- New floating **Check image** control (bottom-left, clear of Ketcher's left and
  bottom toolbars): hidden file input restricted to PNG/JPEG/WebP, raw bytes
  POSTed to `/v2/filter/classify`, native Tauri dialog with the verdict
  (`This image contains a molecule.` / `No molecule detected in this image.`).
- Loading disables the button (`Checking...`); the same file can be re-checked;
  400/413/503/network errors show actionable dialogs (`kind: "error"`), with an
  `alert` fallback outside Tauri. Client-side 10 MB cap and a 30 s request
  timeout. Recognize Molecule stays hidden.
- Helpers in `src/imageCheck.ts` (MIME detection, response parsing, verdict copy,
  raw-bytes request); `src/ImageCheck.tsx` owns the UI; `App.tsx` keeps the
  resolved `apiBase`.
- Added Vitest 3.2.7 (Node environment, `src/**/*.test.ts`), the `pnpm test`
  script and harness block 5b. 46 tests cover MIME type-vs-extension conflicts,
  malformed/plain-text/HTTP errors, exact 10 MiB boundary, timeout and request
  shape.
- Docs: architecture, testing, verification (manual steps incl. loading state),
  DEVELOPMENT, CHECKPOINTS C4 and ROADMAP updated. Agent instructions now list
  `pnpm test`.
- Review: first REQUEST_CHANGES (control overlapped Ketcher's bottom toolbar,
  plain-text 413/503 fallbacks untested); fix task moved the control, added the
  fallback/boundary/malformed tests, error dialog kind, 400 fallback, timeout and
  docs corrections; re-review PASS.
- Gates: `pnpm test` 46/46, tsc/lint/format/build clean, harness green (sidecar
  120/120), policy 32/32.

---

## Activity 5 — model-root-resolution (fix, complete 2026-11-12)

Fix the 503 from the image-check UI under `task run`.

- Root cause: `task run` builds the sidecar with `--release`, so the debug-only
  default was off and the sidecar resolved `models` relative to its working
  directory; the Tauri host never passed `CHEMISTRY_MODELS_DIR`.
- New pure resolver `service/ml/paths.rs`: explicit `CHEMISTRY_MODELS_DIR` >
  existing `<repo>/models` > cwd `models`; an empty explicit value counts as
  unset.
- `main.rs` delegates to the resolver; the debug Tauri host passes an absolute
  `<repo>/models` and preserves an existing value. Release delivery stays B3.
- Proof: the release sidecar launched from `/tmp` with no env logs
  `model root: /.../chemistry-draw/models`; an explicit value wins; an empty
  model root still returns the actionable 503.
- Tests: 5 path tests (explicit, explicit over an existing repo candidate, repo
  wins over cwd, cwd fallback, empty explicit) plus the existing suite.
- Docs: architecture precedence and module map, verification startup/bare
  sidecar wording, DEVELOPMENT dev auto-root, conventions and module docs.
- Review: functional fix approved; documentation-only findings corrected and
  re-reviewed as PASS.
- Gates: harness green (sidecar 125/125, Vitest 46/46), policy 32/32, fmt/Clippy/
  Prettier/ShellCheck clean. Stale dev servers and the leftover sidecar stopped.

---

## Activity 6 — remove-image-check-ui (chore, complete 2026-11-12)

Remove the temporary image-check UI aid after manual validation; the B1
classifier endpoint stays.

- Deleted `src/ImageCheck.tsx`, `src/imageCheck.ts` and the Vitest suite; removed
  the `test` script, the `vitest` dependency, the Vite `test` block and harness
  block 5b. `App.tsx` is back to the provider-only flow (no `apiBase` state, no
  control); Ketcher Recognize stays hidden.
- Docs and agent instructions return to the no-frontend-test-runner state; the
  backend endpoint, model-root precedence and fixtures remain documented.
- Review: PASS; no code changes required. Stale `pnpm tauri dev`/Vite/sidecar
  processes stopped, ports 1420/9321 free.
- Gates: tsc, ESLint, Prettier, build, rustfmt, Clippy, ShellCheck and the full
  harness green (125 sidecar tests, policy 32/32).

---

## Activity 7 — ship-onnx-runtime (chore, complete 2026-11-12)

Ship the native ONNX Runtime that the `ort` binding loads dynamically, so
packaged apps can run the classifier instead of returning 503.

- Pinned ONNX Runtime 1.31.0 with SHA-256 checks: Linux
  `onnxruntime-linux-x64-1.31.0.tgz` (`cc5c72…3a57`) and Windows
  `onnxruntime-win-x64-1.31.0.zip` (`3958d8…2195`).
- `scripts/build-libs.sh` downloads/verifies/extracts the Linux runtime into
  the builder output; `scripts/fetch-windows-libs.ps1` extracts only
  `onnxruntime.dll` via entry-level `ZipFile`.
- Packaging copies the builder libs with `cp -a` to preserve the
  `.so -> .so.1 -> .so.1.31.0` chain. Tauri dereferences resources, so
  `scripts/repack-native-payload.sh` restores the chain in deb/rpm after the
  bundle build; the AppImage chain was already correct.
- The Tauri host resolves `ORT_DYLIB_PATH`: debug prefers `.ort/<platform>`,
  then the bundled `lib/<platform>`; release uses the bundled runtime. Missing
  runtime still yields the actionable 503. No link-time ORT dependency.
- Contract tests pin the URLs, hashes, extraction paths, `cp -a`, repack
  invocations and the `sha256sum -c -` verification (the test fails if the
  command is removed). The builder tag was rebuilt from this worktree after a
  stale image from another worktree was found.
- Payloads: one real `libonnxruntime.so.1.31.0` + two symlinks, no models,
  Imago, OpenCV, `libstdc++` or `libgcc_s`. Packaged AppImage sidecar classify
  returns 200 for caffeine with the repo models and no `ORT_DYLIB_PATH`.
- Sizes: deb 30,851,320 (+11,021,978); rpm 30,983,791 (+11,153,993);
  AppImage 27,515,384 (+10,559,488); recorded in ROADMAP.
- Review: first REQUEST_CHANGES (stale builder tag, repack untested); fix task
  rebuilt the tag, added repack/path/CI tests, removed `eval`, used entry-level
  Windows extraction and fixed stale comments; re-review PASS.
- Gates: 75 Node tests, 125 sidecar tests, policy 32/32, harness green,
  ShellCheck/rustfmt/Clippy/Prettier clean.

---

## Activity 8 — phase-b2-ocsr-inference (feat, complete 2026-11-12)

Phase B2 OCSR inference: image → SMILES with the DECIMER hand-drawn FP32 model.

- Model choice: one model, no router — `ocsr-handdrawn-fp32`
  (`ocsr-handdrawn@zenodo:10781330`, CC-BY-4.0). Hand-drawn 0.7300 canonical;
  printed 0.694 vs 0.704 for the printed model, so it is the better single-model
  compromise for a drawing app.
- Local artifacts under gitignored `models/ocsr-handdrawn-fp32/`: encoder
  208,801,677 B (`996727…3f52`), decoder_step 107,017,280 B (`cfff97…8197`),
  vocab 5,316 B (`62c84d…c7dd`). The manifest records all three checksums and
  the exact contract; the hand-drawn export bakes the auxiliary inputs, so
  `zero_inputs` is empty (the printed export exposes them).
- Implemented the DECIMER `decimer_ocsr` preprocessing (alpha-on-white,
  NumPy-`linspace` contrast stretch, BGR-grey quirk, contrast 1.8, resize rules,
  empty-border crop, central square, brightness 1.6, 512 LANCZOS, ImageNet
  normalization), the vocab/digit remap, the encoder + decoder_step sessions and
  the greedy decoder (start 13, end 14, max 302, last-row argmax, softmaxed
  output, mean token confidence, incomplete detection).
- `POST /v2/ocsr/recognize`: raw PNG/JPEG/WebP, 10 MiB, 200 with
  `smiles`/`confidence`/`incomplete`/`model`, 400/413/422/503; lazy OCSR
  sessions so startup, health and the classifier do not load the ~316 MB pair.
- Real result: caffeine.png → `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`, confidence
  0.9957286571634227, incomplete false.
- Review: first REQUEST_CHANGES on test/doc evidence (non-empty-SMILES assert,
  missing shape/LUT/confidence/incomplete tests, docs drift); fix task pinned
  the exact SMILES, added the comparator matrix, NumPy-parity LUT, invalid-model
  503 tests, vocab/manifest consistency, extreme-aspect guard and docs fixes;
  re-review PASS.
- Docs: architecture contract, testing strategy, verification curls,
  CHECKPOINTS C8, ROADMAP B2, NOTICE (CC-BY-4.0).
- Gates: 166 default / 176 with `--include-ignored`, 75 Node tests, policy 32/32,
  harness green, fmt/Clippy/ShellCheck clean.
- Next: filter-gated pipeline + Ketcher `imago/uploads` adapter + Recognize UI.
