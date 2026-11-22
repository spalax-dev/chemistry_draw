# CHECKPOINTS — Final State Evaluation

> In multi-agent systems, the path is not evaluated, the destination is.
> These are objective checkpoints a judge (human or AI) can use
> to decide if the project is healthy.

## C1 — Harness is Complete

- [ ] Base files exist: `AGENTS.md`, `scripts/harness.mjs`,
      `scripts/harness-lib.mjs`, `scripts/harness-lib.spec.mjs`,
      `scripts/build_harness.mjs`, `activities.json`, `progress/current.md`;
      the current tree is in `docs/harness/structure.md`. The v1
      `activity-policy` scripts no longer exist.
- [ ] Docs exist: `docs/architecture.md`, `docs/conventions.md`,
      `docs/verification.md`, `docs/testing.md`.
- [ ] `node scripts/harness.mjs` exits with code 0.

## C2 — State is Coherent

- [ ] Story, activity and task state follow the two-stage harness: one active or
      awaiting-approval story, activities claimed before editing, disjoint batch
      `touches`, and state written only by the orchestrator. The v1 `phase` and
      `reviewer` rules are retired; see `docs/harness/verification.md` §4 and
      `docs/harness/CHECKPOINTS.md` C2.
- [ ] Every `done` activity has associated passing gates (or, for docs work, the
      relevant harness blocks).
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

## C6 — No Imago Backend (compatibility route only)

- [ ] `scripts/fetch-windows-libs.ps1` pins Indigo 1.46.0, verifies SHA-256 and
      never vendors DLLs/`.lib` files.
- [ ] No Imago code, worker binary, native library or packaging reference
      remains (outside `CHANGELOG.md`, `progress/history.md`, the roadmap and
      the checks that assert its absence). The `/v2/imago/uploads` pair is our
      compatibility shim (filter → OCSR → Indigo), not Imago code; no Imago
      library or worker runs.
- [ ] The former Imago-absence suite runs on every platform and pins the
      compatibility contract: `/v2/info` (and `/v2/indigo/info`) advertises
      exactly `imago_versions: ["local-ocsr"]` as a synthetic capability when
      both models are installed and `[]` otherwise (the B3 gate), `/v2/health`
      exposes no `imago_worker`, `POST /v2/imago/uploads` returns an
      `upload_id`, and an unknown `GET /v2/imago/uploads/{id}` is `404`.
- [ ] The packaging contract test asserts `externalBin` never lists
      `imago-worker`.
- [ ] Rebuilt artifacts contain no imago-worker/libimago/OpenCV (deb/rpm/AppImage
      inspected).
- [ ] Rebuilt artifacts contain the shipped ONNX Runtime 1.31.0 payload — one
      real `libonnxruntime.so.1.31.0` plus the `.so.1`/`.so` symlinks on Linux,
      `onnxruntime.dll` on Windows — and no model weights.
- [ ] NSIS installer is uploaded as an artifact.
- [ ] With both model sets and a loadable runtime, Recognize Molecule is visible
      and `caffeine.png` inserts a V2000 structure into the canvas; a
      non-structure image, a low-confidence/incomplete decode, an unsupported
      image and missing models each surface an in-app dialog, never raw JSON.
- [ ] Docs state that the `/v2/imago/*` pair is a Ketcher compatibility shim,
      that no Imago library/worker ships, and list the Windows build commands.
- [ ] Linux harness and packaging metadata remain green.

## C7 — Document → Test → Implement

- [ ] Every activity starts with its documentation task, and the tests activity
      precedes the implementation activity, per `docs/harness/development.md`
      and `docs/harness/testing.md`.
- [ ] New behaviour has a failing-test (RED) evidence path before its
      implementation, per `docs/harness/testing.md`.
- [ ] The harness gates and the story approval are the current process; the v1
      `phase`/`activity-policy` checks are retired (`docs/harness/verification.md`).

## C8 — ONNX Foundation Contract

- [ ] `models/` and `.ort/` are gitignored; no ONNX model weight is committed
      or bundled. The pinned ONNX Runtime 1.31.0 **is** shipped from the builder
      image / Windows fetch script and loaded dynamically (`ort`
      `load-dynamic`, `ORT_DYLIB_PATH`); the sidecar has no
      `DT_NEEDED libonnxruntime` or `OrtGetApiBase` symbol.
- [ ] `scripts/fetch-onnxruntime.sh` pins ONNX Runtime 1.31.0, verifies its
      SHA-256 and extracts only `lib/libonnxruntime.so*` into
      `.ort/linux-x86_64/`; it is idempotent and ShellCheck-clean.
- [ ] `models/manifest.json` records the artifact path, `artifact_sha256`,
      provenance id and the exact tensor contract; loading validates names,
      shapes, dtype and checksum.
- [ ] The classifier contract holds: `input_2` float32 `[1, 224, 224, 3]`,
      `45214:0` and `45216:0` fed zeros as float32 `[1, 1, 1, 3]`, output
      `Identity:0` float32 `[1, 1]`; `score = sigmoid(logit)` and `structure`
      when `score <= 0.000089`, else `no-structure`.
- [ ] The classifier contract comparator accepts dynamic `-1` only on axis 0
      (batch); dynamic width/height/channels and static mismatches are errors,
      with pure unit tests. The OCSR decoder sequence axis (axis 1) is the only
      additional dynamic axis.
- [ ] Preprocessing follows DECIMER `runtime_default` and never auto-inverts,
      histogram-equalizes, sharpens or autocontrasts in the default path.
      Decoding is bounded (12,000 px per side, 128 MiB) and over-limit input is
      `400`.
- [ ] The manifest has a second `ocsr-handdrawn` entry that pins the encoder,
      decoder-step and vocabulary files (`artifact_sha256`), sets
      `preprocessing: "decimer_ocsr"`, `start_id: 13`, `end_id: 14`,
      `max_len: 302` and `confidence_threshold: 0.901`, and declares both tensor
      contracts. The `image-classifier` entry and schema 1 stay unchanged.
- [ ] The OCSR tensor contract holds: encoder `image` float32
      `[1, 512, 512, 3]` → `Identity:0` float32 `[1, 256, 512]`; decoder
      `tokens` int32 `[1, seq]` + `enc_out` float32 `[1, 256, 512]` (+ declared
      extra inputs fed zeros) → `Identity:0` float32 `[1, seq, 156]`, already
      softmaxed. Greedy decode seeds `[13]`, argmaxes the last position, stops
      at `14` or `max_len = 302`, treats `last != 14` as `incomplete`, and
      reports the mean chosen-token probability as `confidence`.
- [ ] `decimer_ocsr` runs the exact order: RGBA on white, per-image contrast
      stretch, BGR2GRAY quirk (`0.114*R + 0.587*G + 0.299*B`),
      `Contrast(1.8)`, resize rules, empty-border crop, central square,
      brightness 1.6, 512×512 LANCZOS RGB, ImageNet normalization in NHWC. The
      tokenizer skips pad/start/end and remaps `!$^<>?£¢€§` → `1234567890`.
- [ ] `POST /v2/ocsr/recognize` accepts raw PNG/JPEG/WebP under the 10 MiB cap,
      returns `smiles`, `confidence`, `incomplete: false` and `model`, and maps
      undecodable input to `400`, over-cap to `413`, missing/invalid model or
      runtime to `503`, and a truncated decode (`incomplete: true`) to `422`
      with an actionable message and no partial SMILES.
- [ ] `POST /v2/imago/uploads` accepts raw PNG/JPEG/WebP (10 MiB cap) and
      returns an `upload_id`; `GET /v2/imago/uploads/{id}` reports `PENDING`,
      `SUCCESS` with `metadata.mol_str` (V2000) or `FAILURE` with an actionable
      message; an unknown/expired id is `404`. Jobs run in `spawn_blocking` and
      do not survive a restart. The worker has a 120 s processing bound (a
      pipeline over it becomes the timeout `FAILURE`); the store TTL is 10
      minutes (a `PENDING` job becomes a timeout `FAILURE`; a resolved job is
      pruned at `resolved_at + TTL`). Both handlers prune the store before
      answering, so expired entries actually leave the map.
- [ ] The compatibility pipeline is filter → OCSR → SMILES → molfile through
      Indigo. It maps a filter rejection, an `incomplete` or low-confidence
      decode, an unsupported image, a missing model/runtime, a conversion
      failure and a timeout to the documented `FAILURE` messages, and never
      returns a partial SMILES.
- [ ] The `confidence_threshold` `0.901` is enforced only by the compatibility
      pipeline (the single-image endpoint still returns `200` for a complete
      low-confidence decode). The value is **provisional**: it is the in-domain
      hand-drawn measurement and needs recalibration on real inputs before it is
      treated as final.
- [ ] `/v2/info` advertises exactly one synthetic `imago_versions` entry
      (`local-ocsr`) when the manifest and both models' required artifacts are
      present, and `[]` otherwise, so Ketcher enables Recognize only when it can
      work; the real Imago backend, worker and libraries remain absent, and the
      `?version=` query is ignored.
- [ ] Ketcher's built-in Recognize control stays visible
      (`src/ui/editorButtons.ts` never hides `recognize`) and its Imago
      version selector is hidden by `src/overrides.css`; `App.tsx` maps no-molecule,
      low-confidence/incomplete, unsupported-image and model-unavailable
      failures to in-app dialogs with a generic fallback. A JSON body without
      a usable `error`/`message` is treated as JSON and shown as the generic
      failure, and the plain-text `413` path (a JSON parse error in Ketcher)
      maps to the "may be too large" copy; raw JSON never reaches the user.
- [ ] The replaced `imago_absent` contract is tested on every platform: the
      synthetic info capability with models and the empty list without them, no
      `imago_worker`, `POST` returning `upload_id`, unknown `GET` `404`, job
      store states/TTL, missing-model `FAILURE`, filter rejection and a
      model-gated caffeine `SUCCESS` with a V2000 molfile.
- [ ] OCSR sessions load lazily on the first recognition request and are
      cached; startup, `/v2/health` and `/v2/filter/classify` never open them.
      Health lists both model ids only when their required artifacts exist.
- [ ] OCSR preprocessing, vocabulary and greedy-decode tests run without the
      model (fake decoder step); real-fixture and tensor-contract tests need
      `models/ocsr-handdrawn-fp32/` (~316 MB, gitignored, never bundled) and
      self-skip when absent.
- [ ] `NOTICE` records the DECIMER v2 hand-drawn OCSR model (CC-BY-4.0,
      Zenodo 10781330) and states the artifacts are downloaded, not bundled; the
      docs record the single-model decision and its metrics (0.7300 hand-drawn
      canonical; printed 0.694 vs 0.704; printed model 0.677 on hand-drawn).
- [ ] The sidecar starts without models and without the runtime; a missing,
      corrupt or contract-mismatched model returns 503 with an actionable
      message naming the manifest path and `CHEMISTRY_MODELS_DIR`, never a panic
      or a fallback. The 503 is logged at WARN, not as an internal error.
- [ ] `/v2/health` reports the targeted ONNX Runtime API generation and only
      model ids whose required artifacts exist on disk (classifier file; OCSR
      encoder + decoder + vocab). `/v2/info` adds only the synthetic
      `imago_versions` capability list, gated on those artifacts: the rest of
      its payload is unchanged and it exposes no inference/backend fields.
- [ ] Non-gated temp-dir tests cover wrong checksum, missing artifact,
      unsupported schema, a manifest without `image-classifier` and a
      preprocessing mismatch; a model-gated test covers a graph/manifest shape
      mismatch. Body-cap tests cover exactly 10,485,760 bytes (`400`) and one
      byte more (`413`). WebP is covered by a fixture test.
- [ ] Model-gated tests (`--include-ignored`, `models/` and the runtime present)
      pass, and the suite stays green without them.

## C9 — Document and Autosave Contract

> **US-01 update (1.x):** the single-document Restore/Discard prompt and the
> `recovery/autosave.*` snapshot are replaced by per-tab snapshots and silent
> restore (ADR 0010, ACT-07). The current manual workflow is
> `docs/harness/verification.md` §10; the recovery bullets below describe the
> 0.x baseline.

- [x] `.ket` is the only save format: Save and Save As write `.ket`, while
      Export is the only route to Molfile V2000/V3000, SMILES, InChI, SVG and
      PNG, and never changes the document path or format.
- [x] The window title shows the document name (or `Untitled`) plus a dirty
      marker; a successful Save, Open or New clears the dirty state.
- [x] Opening a `.ket` file gives a clean document with that path; opening
      `.mol`/`.smi`/`.sdf`/`.rxn` imports through Ketcher, leaves `path` `null`
      and keeps the document dirty.
- [x] Autosave writes `.ket` plus metadata into the app data dir only while
      dirty, debounced and on a slow interval, never to the user's file, and
      the snapshot is cleared after Save, New or Open; an in-flight write
      cannot recreate a snapshot after that cleanup.
- [x] A snapshot newer than the last clean save triggers an in-app
      Restore/Discard prompt on launch; Restore re-attaches the original path
      when known. A missing or unreadable original still offers recovery
      (missing files are called out in the prompt).
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

## C10 — Ketcher Toolbar Integration

- [x] No app-owned toolbar, dock or floating control group exists; Save, New
      and Export (plus the Models entry added by C13) render as Ketcher toolbar
      `customButtons` with sentence-case titles and icons that inherit the
      toolbar button colour (transparent `imageLink` painted by a CSS mask,
      Ketcher's native 28/32/40 px metrics, no hard-coded icon colour).
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
- [x] Ketcher's built-in **Recognize** entry stays visible
      (`src/ui/editorButtons.ts` hides only `save`) so the ONNX/OCSR flow is
      reachable; `src/overrides.css` hides the unused Imago version selector in
      the Recognize dialog.
- [x] The pure routing helper (`.ket` → document save, other extensions →
      export save, no Tauri/no handler → download) has Vitest coverage and was
      RED before implementation.
- [x] The manual checklist in `docs/verification.md` §2 "Toolbar integration"
      passes, including the browser fallback.

## C11 — Bundled vs Host Native Libraries

- [x] The Linux bundled set is Indigo, Indigo Renderer and non-platform deps
      only (ONNX Runtime ships as a separate payload); `libfontconfig*`,
      `libfreetype*`, `libexpat*`, `libpng*` and `libbrotli*` are excluded by
      the `scripts/build-libs.sh` dependency skip list, the Taskfile `libs` copy
      and `scripts/bundle-libs.sh` `SKIP_PATTERNS`, guarded by the test in
      `docs/testing.md` §4.2.
- [x] `src-tauri/lib/linux-x86_64` contains none of those files, `ldd` resolves
      them from the host, and a PNG render logs no `Fontconfig warning` (manual
      step in `docs/verification.md` §2).
- [x] `.deb`/`.rpm`/AppImage ship no platform font/PNG libraries and rely on the
      distribution's copies, which GTK already pulls in, as documented in
      `docs/architecture.md` §8.

## C12 — Model Delivery (B3)

- [x] No model weight or `manifest.json` is bundled or committed: the catalog is
      compiled into the sidecar, the packages contain no `.onnx` file or
      `models/` path, and `NOTICE` records the MIT classifier and CC-BY-4.0
      OCSR attribution.
- [x] `GET /v2/models` answers `200` with no model root, manifest or models:
      bundled catalog version, `ready: false`, total/installed bytes, per-model
      `installed`/`missing` and `download.state: "idle"`; the sidecar starts and
      serves Indigo.
- [x] `POST /v2/models/download` is opt-in (no startup download), returns `202`,
      is `409` while a run is active and `200` only when every installed
      artifact re-hashes to the catalog and the manifest is current; cancel
      keeps the `.part` and a retry resumes with HTTP Range; verify/repair
      reports missing/corrupt artifacts and the repair hint.
- [x] Every artifact is size-checked and SHA-256-verified, installed by atomic
      rename, and a bad checksum deletes the `.part` and fails without a final
      file; disk-space and offline failures are actionable; the generated
      `models/manifest.json` is schema 1 with `catalog_version` and loads through
      the registry.
- [x] Release passes `<app_data>/models` as `CHEMISTRY_MODELS_DIR`, an explicit
      env value wins, debug keeps `<repo>/models`, and the directory is created.
- [x] `/v2/info` advertises `imago_versions: ["local-ocsr"]` only when the
      manifest and both models' required artifacts are present, and `[]`
      otherwise; `/v2/health` keeps the same cheap existence rule.
- [x] Tests use a local HTTP server, dummy artifacts and
      an injected test catalog / catalog-error seam; CI never downloads the ~324 MB real models; the
      real HF smoke is gated/manual and the model-gated inference tests remain.

## C13 — Model Setup UI (B3)

- [x] Ketcher's top toolbar registers a fourth custom entry `Models`
      (`chemistry-draw:models`, transparent `imageLink` plus a masked outline
      glyph on the same 24-unit grid and metrics as Save/New/Export), but it is
      a **conditional control**, not a permanent toolbar item: it is visible
      when `/v2/models` is unknown or not ready, when `update_available` is
      true, when the last verify report is `ok: false`, whenever
      `download.state` is downloading, verifying, cancelled or failed (an
      active, interrupted or failed run on a ready install keeps its Cancel,
      Resume and Retry reachable), and when a recognition failure reported the
      models unavailable (the `attention` override, cleared only by proof of
      health: accepting a download-style run does not clear it but arms the
      proof — an already-healthy `200` no-op re-hash clears immediately, else a
      later status read clears only when the completed run reports healthy — and
      an `ok: true` verify clears it too; a new model-unavailable failure
      invalidates any pending health proof before its own silent status read, so
      an earlier run cannot clear a failure observed now); it is hidden only on a
      healthy ready install with an `idle`/`ready` download state, no update, no
      repair and no attention flag. The rule
      is the pure `modelsControlVisible` helper; no app-owned toolbar or dock is
      added.
- [x] The in-app `Dialog`/`Button` setup dialog auto-opens exactly once on
      startup when `/v2/models` reports `ready: false`, can be reopened from
      **Models** while the control is visible (unknown/not ready, update,
      repair, an active/cancelled/failed run or the recognition-unavailable
      attention case), and **Later**/Escape closes it while drawing and Indigo
      operations keep working. Opening it or choosing Later starts no download.
      **Later** then reopening does not clear an `ok: false` verify report: the
      dialog still shows Repair and the control stays visible.
- [x] The dialog shows both model families with provenance, per-model and total
      sizes (8,162,917 B / 315,824,273 B / 323,987,190 B, binary formatting to
      ~309 MiB), installed bytes, catalog version and download state; it has no
      **Licenses and source** block, Hugging Face URL or repeated license
      paragraph (attribution stays in `NOTICE` and the docs). Download is
      opt-in.
- [x] Action labels match the status: Download / Resume / Retry / Repair /
      Update / Verify, Cancel only while downloading, and Later always;
      `verifying` offers no cancel (`409`), a `409`/failed request re-fetches
      the status instead of alerting, and a verify report with `ok: false`
      turns the primary action into Repair.
- [x] While `downloading`/`verifying` the UI polls `GET /v2/models` about every
      500 ms with one in-flight request and shows bytes, percent and the current
      artifact; terminal states and closing the dialog stop polling.
- [x] Offline, disk-space, checksum, transport and `409` errors stay inside the
      dialog in a `role="alert"` region; there is no Tauri
      `message()`/`confirm()` and no browser `alert()`/`confirm()`.
- [x] Until ready `/v2/info` advertises `imago_versions: []` and Recognize is
      disabled; after a successful download the app copies the advertised list
      into Ketcher's option store in place, so Recognize enables without
      remounting the editor or losing the canvas or undo history. The temporary
      local browser flow checks the same DOM node, the structure and the undo
      stack; selection retention is a manual check in `docs/verification.md`.
      `local-ocsr` is never hardcoded in the webview, and a ready install at
      startup applies the same update with no dialog.
- [x] Pure helpers (`formatBytes`, `progressPercent`, `parseModelsStatus`,
      `setupView`, `modelsControlVisible`, `modelInstallHealthy`,
      `modelAttentionNoticeVisible`) and the HTTP
      adapters (with an
      injected fake fetch) are covered by Vitest with the not-installed,
      downloading, verifying, paused, failed, ready, update and repair cases,
      the Models-control null/not-ready/ready/update/repair cases plus
      ready+downloading, ready+verifying, ready+cancelled, ready+failed and the
      healthy-ready + `attention` override, the install-health true case for a
      healthy ready root and false for `null`, not-ready, update, downloading,
      verifying, cancelled and failed, the attention note true only on a ready
      verify-capable dialog and false without the override, on a `null`/not-ready
      status, during an active/paused/failed run and while Repair is shown,
      malformed
      status/verify bodies and `readError`/`409`/unreachable-service handling,
      plus `isModelUnavailable` for a prefixed JSON body, a bare JSON body,
      plain text and the unrelated/no-detail negatives. A
      temporary local Playwright run against a dummy catalog and loopback server
      (not a committed suite, no `pnpm test:e2e`) exercises auto-open,
      Later/reopen, Download → ready with the Models control visible on the
      empty root and hidden after ready, Verify, Verify-fail → Later → reopen
      still Repair/control visible → Repair → ready
      with the control back while repair is needed, the recognition-unavailable
      failure forcing the control visible after the in-app error is dismissed
      (with the muted Verify note in the dialog and a prior hidden-control
      re-assertion), a forced `500` repair request keeping the control visible
      after Later/reopen, an accepted `202` whose body still reports
      `downloading` (not forwarded, with the following polls answering
      `downloading` for ~2.5 s) keeping the control visible across at least two
      polls and the note absent because Verify is unavailable, the
      real repair keeping the control visible while
      `downloading` and hiding it only once the completed run reads healthy,
      the close-during-repair → new recognition failure regression (a pending
      proof from the earlier run must not clear the fresh attention) followed by
      an `ok: true` Verify hiding the note and control, the
      dialog without a license/source block, the in-dialog error/Retry
      state, the action row at 1280x800 and 900x600, and the capability update
      without a remount.
      Cancel/resume and Update labels are covered by the `setupView` tests,
      their backend semantics by the sidecar suite, and their click-through by
      the manual checklist. No flow downloads the real ~324 MB models.
- [x] Model weights remain unbundled, uncommitted and absent from installers;
      the dialog downloads only from the catalog's Hugging Face URLs and never
      uploads an image, drawing or document.

## C14 — Clean-install validation (B3)

- [x] Rebuilt `.deb`, `.rpm`, AppImage and NSIS payloads contain no `.onnx`
      file, `models/` path or generated `manifest.json`; they keep the Indigo
      libraries and the ONNX Runtime 1.31.0 payload (`libonnxruntime.so.1.31.0`
      with its symlink chain on Linux, `onnxruntime.dll` on Windows); the
      absence greps print nothing and their measured sizes are recorded in
      `docs/verification.md` §2 "Clean install (B3)" and `docs/ROADMAP.md` B3.
- [x] The packaged sidecar run from the AppImage payload with an empty
      `CHEMISTRY_MODELS_DIR`, the packaged `LD_LIBRARY_PATH` and no dev checkout
      answers `GET /v2/models` with `200`, `ready: false`,
      `manifest_present: false`, `installed_bytes: 0`,
      `total_bytes: 323987190` and `download.state: "idle"`, and `/v2/info`
      with `imago_versions: []`; neither route creates a manifest or contacts
      Hugging Face.
- [x] `POST /v2/models/download` on that packaged empty root downloads the real
      artifacts from Hugging Face (323,987,190 B), verifies the pinned sizes and
      SHA-256 values, writes a schema-1 `manifest.json` with
      `catalog_version: 1` and both model keys, and ends `ready`;
      `POST /v2/models/verify` then reports `ok: true` with no repair hint, no
      `.part` file remains, and `POST /v2/filter/classify` plus
      `POST /v2/ocsr/recognize` on `caffeine.png` answer `200` with the
      documented category, SMILES and model ids. This is the gated/manual
      smoke; CI never downloads the 324 MB.
- [x] Launching the packaged app with an empty app-data root
      (`XDG_DATA_HOME`/`%APPDATA%` equivalent) creates the empty models
      directory, auto-opens the **Models** dialog once and starts no download;
      **Later** leaves the app usable and the **Models** control (visible while
      the root is empty) reopens the same state. Download progresses to ready,
      the control disappears and Recognize enables without remounting the
      editor; the drawn structure, selection, undo history and Save/Open/Export
      workflow survive, and no native alert or second OS window appears in any
      setup state. A relaunch with the populated root neither auto-opens nor
      shows the control; a second fresh root repeats the first-run flow.
- [x] The Windows CI smoke runs the release sidecar with an empty model root
      and asserts `GET /v2/models` `ready: false`/`total_bytes: 323987190` and
      `GET /v2/info` `imago_versions: []`, while keeping the
      `/v2/imago/uploads` compatibility checks, and the NSIS payload carries no
      model weights.
- [x] The clean-install/packaging contract tests exist and fail without their
      change: no packaging script or bundle resource copies `models/`, `.onnx`
      or a model root; the Windows action contains the empty-root `/v2/models`
      and `/v2/info` `[]` checks; a packaged clean-root smoke check exists.
- [x] The 0.1.7 package-size delta versus 0.1.6 is measured and recorded with
      Indigo/ONNX Runtime retained and no weights added; no `.onnx`, `.part`,
      `models/` or `.so` file is committed; `node scripts/harness.mjs` is green.

## C15 — Phase D model-parity pilot

- [x] The protocol is documented in `docs/benchmarks/model-parity.md` with
      purpose, provenance, frozen IDs, classifier mapping, OCSR metric rules,
      acceptance, TIFF conversion and tracking policy, and the report has no
      `TBD` left.
- [x] The classifier FP16 run reproduces the same-ID FP16 reference: binary
      accuracy **≥ 0.7231** (0.7281 reference − 0.5 pp, 165/228) over **228**
      non-reaction rows, all 300 images decoded, and the 72 `reactions` reported
      separately (not counted in the binary matrix). Confusion TP/FN/FP/TN
      recorded.
- [x] The hand-drawn OCSR FP32 run reproduces the FP32 pilot reference: RDKit
      canonical **≥ 0.7092** (0.7192 reference − 1.0 pp, 208/292) over
      comparable pairs; exact (reference 121/300), valid (299/300, 1
      incomplete), comparable `n` and the `422`/incomplete rule recorded.
- [x] p50/p95 are recorded on the same machine and the shipped **release**
      binary (nearest-rank, after one warm-up) for both models, and per-image
      agreement plus every disagreement against the toolchain is recorded (raw
      rows stay under `build/benchmarks/`); debug-build latency is not
      reported as the app result.
- [x] The classifier artifact (`d5f5506…af505a9`), encoder
      (`996727a2…c78193f52`), decoder (`cfff9788…c6bb6d68197`) and vocab
      (`62c84d90…fa3c7dd`) hashes are checked equal to the toolchain selection;
      the report pins the toolchain commit `c2265a6d`, the frozen-manifest and
      label SHA-256 values, and the run identity.
- [x] The TIFF → RGB PNG conversion rule is followed for the 197 classifier
      pilot TIFFs (toolchain Pillow, first frame, lossless RGB pixels, temp
      files only), and the app's supported formats remain PNG/JPEG/WebP only.
- [x] The threshold decision is recorded: classifier `0.000089` and OCSR
      `0.901` are retained unless the pilot evidences a parity failure that
      justifies a separate calibration; no per-image tuning was done.
- [x] The parity unit tests in `scripts/lib/model-parity.test.mjs` are green and
      mutation-checked: including reactions, flipping the mapping, using 300 as
      the canonical denominator, counting a `422` as valid/comparable, letting
      an invalid row carry a canonical result, or breaking the nearest-rank
      percentile must each fail.
- [x] The classifier reference reconciliation is recorded: the historical
      `classifier.fp32.pilot300.json` (`0.7361`, n=216, 84 reactions) is not the
      current frozen pilot (0/300 ID overlap; 8/300 category+filename) and was not used as the baseline.
- [x] No dataset (166 MB classifier / 25 MB HDM), toolchain checkout, model
      weight, converted PNG or raw per-image prediction is committed;
      `node scripts/harness.mjs` is green.

## C16 — OCSR incomplete-tail fix (Phase D follow-up)

- [x] `docs/benchmarks/ocsr-tail-fix.md` records the failure (`hdm::CDK_Depict_5_82`,
      the 302-step `C=` cycle, 37.3 s, HTTP `422`, the reference chain), why
      lowering `max_len` is not the fix, the decode contract, the guard design
      and semantics, the fake-decoder cases, the pilot300 before/after protocol,
      acceptance, residual risk and rollback. Every `[task c]` placeholder is
      replaced with the measured value; the pre-guard token trace is
      `2026-11-18T22-43-16-297Z` and the guarded run is
      `2026-11-18T22-58-26-248Z`.
- [x] The repetition guard only stops a bounded periodic tail; it keeps
      `incomplete = true` → `422`, and does not change `max_len`, the model, the
      start/end ids, the thresholds, preprocessing or the normal decode path.
      `K = 2`, `R = 16` (two-token), `R₁ = 32` (one-token); the pathological row
      answers `422` in **2,186.158 ms** (before 37,270.662 ms) with 33 ids
      instead of 303.
- [x] Fake-decoder tests (no model) cover a one-token run, the two-token `C=`
      cycle, a legitimate repeated motif below the cutoff, EOS before the
      cutoff, a non-repetitive long decode and the pathological row, plus a long
      alkane run for the one-token tier; RED was confirmed before the
      implementation (`cargo test -p indigo-server ocsr` failed on the missing
      guard API), the tests are GREEN after it (58 passed, 3 ignored), and the
      mutation rule holds.
- [x] The pilot300 before/after shows the pathological row still `422` in
      **≤ 5 s** (before: 37.3 s; after: **2.19 s**) and the aggregate unchanged —
      canonical **211/290**, exact **122/300**, valid **299/1** — with **0**
      per-image differences against the accepted run; no valid row is truncated.
- [x] The chosen guard parameters, the longest legitimate periodic run
      (one-token `C` ×8, two-token `O)` ×6), the margins (4× and 2.67×) and the
      raw run path are recorded; the residual risk (a legitimate periodic tail
      above the threshold, alkane > C31) and the rollback (raise `R`/`R₁`, never
      `max_len`) are documented.
- [x] `docs/architecture.md`, `docs/testing.md`, `docs/verification.md` and
      `docs/ROADMAP.md` are updated; `node scripts/harness.mjs` is green; the
      working tree is left uncommitted for user approval.

---

**How to use this file:** go through each checkbox and mark `[x]` or `[ ]`.
There is no reviewer agent in the two-stage harness; the user checks the
approval boxes. Any empty box in C1–C16 blocks session close, and
`docs/harness/CHECKPOINTS.md` holds the harness-level evaluation.
