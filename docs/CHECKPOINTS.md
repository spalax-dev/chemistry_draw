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

## C6 — No Imago Anywhere

- [ ] `scripts/fetch-windows-libs.ps1` pins Indigo 1.46.0, verifies SHA-256 and
      never vendors DLLs/`.lib` files.
- [ ] No Imago code, route, worker binary, native library or packaging
      reference remains (outside `CHANGELOG.md`, `progress/history.md`, the
      roadmap and the checks that assert its absence).
- [ ] `src-tauri/sidecar/src/tests/imago_absent.rs` runs on every platform:
      `/v2/info` and `/v2/health` expose no `imago_versions` / `imago_worker`,
      and `/v2/imago/*` returns 404.
- [ ] The packaging contract test asserts `externalBin` never lists
      `imago-worker`.
- [ ] Rebuilt artifacts contain no imago-worker/libimago/OpenCV (deb/rpm/AppImage
      inspected).
- [ ] NSIS installer is uploaded as an artifact.
- [ ] Docs state that Recognize Molecule is hidden until B2 wires OCSR and list
      the Windows build commands.
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

- [ ] `models/` and `.ort/` are gitignored; no ONNX artifact, model weight or
      `libonnxruntime` file is committed or bundled in B1. The runtime is loaded
      dynamically (`ort` `load-dynamic`, `ORT_DYLIB_PATH`) and the sidecar has
      no `DT_NEEDED libonnxruntime` or `OrtGetApiBase` symbol.
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
- [ ] Contract validation accepts dynamic `-1` only on axis 0 (batch); dynamic
      width/height/channels and static mismatches are errors, with pure unit
      tests.
- [ ] Preprocessing follows DECIMER `runtime_default` and never auto-inverts,
      histogram-equalizes, sharpens or autocontrasts in the default path.
      Decoding is bounded (12,000 px per side, 128 MiB) and over-limit input is
      `400`.
- [ ] The sidecar starts without models and without the runtime; a missing,
      corrupt or contract-mismatched model returns 503 with an actionable
      message naming the manifest path and `CHEMISTRY_MODELS_DIR`, never a panic
      or a fallback. The 503 is logged at WARN, not as an internal error.
- [ ] `/v2/health` reports the targeted ONNX Runtime API generation and only
      model ids whose artifact exists on disk; `/v2/info` is unchanged.
- [ ] Non-gated temp-dir tests cover wrong checksum, missing artifact,
      unsupported schema, a manifest without `image-classifier` and a
      preprocessing mismatch; a model-gated test covers a graph/manifest shape
      mismatch. Body-cap tests cover exactly 10,485,760 bytes (`400`) and one
      byte more (`413`). WebP is covered by a fixture test.
- [ ] Model-gated tests (`--include-ignored`, `models/` and the runtime present)
      pass, and the suite stays green without them.

---

**How to use this file:** a reviewer agent
(`.opencode/agent/implementation-reviewer.md`) goes through each checkbox, marks
`[x]` or `[ ]`, and rejects session close if any boxes in C1–C8 remain empty.
