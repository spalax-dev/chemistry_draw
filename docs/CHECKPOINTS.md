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
      exactly `imago_versions: ["local-ocsr"]` as a synthetic capability,
      `/v2/health` exposes no `imago_worker`, `POST /v2/imago/uploads` returns
      an `upload_id`, and an unknown `GET /v2/imago/uploads/{id}` is `404`.
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
      (`local-ocsr`) so Ketcher enables Recognize; the real Imago backend,
      worker and libraries remain absent, and the `?version=` query is ignored.
- [ ] Ketcher's built-in Recognize control stays visible
      (`src/ui/editorButtons.ts` never hides `recognize`) and its Imago
      version selector is hidden by `src/overrides.css`; `App.tsx` maps no-molecule,
      low-confidence/incomplete, unsupported-image and model-unavailable
      failures to in-app dialogs with a generic fallback. A JSON body without
      a usable `error`/`message` is treated as JSON and shown as the generic
      failure, and the plain-text `413` path (a JSON parse error in Ketcher)
      maps to the "may be too large" copy; raw JSON never reaches the user.
- [ ] The replaced `imago_absent` contract is tested on every platform: the
      synthetic info capability, no `imago_worker`, `POST` returning
      `upload_id`, unknown `GET` `404`, job store states/TTL, missing-model
      `FAILURE`, filter rejection and a model-gated caffeine `SUCCESS` with a
      V2000 molfile.
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
      `imago_versions` capability list: the rest of its payload is unchanged and
      it exposes no inference/backend fields.
- [ ] Non-gated temp-dir tests cover wrong checksum, missing artifact,
      unsupported schema, a manifest without `image-classifier` and a
      preprocessing mismatch; a model-gated test covers a graph/manifest shape
      mismatch. Body-cap tests cover exactly 10,485,760 bytes (`400`) and one
      byte more (`413`). WebP is covered by a fixture test.
- [ ] Model-gated tests (`--include-ignored`, `models/` and the runtime present)
      pass, and the suite stays green without them.

## C9 — Document and Autosave Contract

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

---

**How to use this file:** a reviewer agent
(`.opencode/agent/implementation-reviewer.md`) goes through each checkbox, marks
`[x]` or `[ ]`, and rejects session close if any boxes in C1–C11 remain empty.
