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
  unknown route (404).
- No real network. Native Indigo is linked, so chemistry tests are real — that
  is the point.
- Absence is tested cross-platform in `tests/imago_absent.rs`: `/v2/info` and
  `/v2/health` expose no `imago_versions` / `imago_worker`, and `/v2/imago/*`
  returns 404. The same module runs on Linux and Windows CI, so no
  `#[cfg(windows)]` variant is needed.
- The packaging contract tests (`scripts/lib/*.test.mjs`) assert `externalBin`
  never lists `imago-worker`, and that `scripts/check-native-libs.sh` fails on a
  directory holding `libimago*`/`*opencv*` files (case-insensitively, including
  broken symlinks) and passes silently on a clean one. They also cover the
  `--allowlist <source-dir>` mode: a bundled file absent from the builder image
  fails with "not provided by the builder image", while a missing target
  directory only warns on stderr.
- ONNX Runtime packaging contracts pin the 1.31.0 archives and SHA-256 values,
  assert every bundle copy uses `cp -a`, and require `build-deb.sh`,
  `build-rpm.sh` and `build-packages.sh` to run
  `scripts/repack-native-payload.sh` after bundling (removing an invocation
  fails the suite). The repack itself is tested for the version pin, the
  restored `.so -> .so.1 -> .so.1.31.0` chain, per-field RPM metadata reads
  (no `eval`) and a clean failure when the builder runtime is missing.
- Never test private state (`obj.field`); test behaviour.

---

## 5. Model-gated ML tests

ONNX model weights are gitignored and absent in CI, and the model-gated tests
also need a loadable ONNX Runtime, so the ML suite splits in two:

- **Always run** (no model, no runtime): preprocessing units, the tensor-contract
  comparator, the 400/413/503 error paths and anything that does not open a real
  session.
- **Model-gated**: real inference, the tensor-contract guard and the
  contract-mismatch path are marked `#[ignore = "requires local ONNX model"]` and
  run only when the model root exists. They also need a loadable ONNX Runtime
  (`ORT_DYLIB_PATH`).

`node scripts/harness.mjs` sets `CHEMISTRY_MODELS_DIR` (honouring an existing
value, else `<repo>/models`) and `ORT_DYLIB_PATH` (honouring an existing value,
else `<repo>/.ort/<platform>/libonnxruntime.so` or `onnxruntime.dll`). It passes
`--include-ignored` only when **both** `models/manifest.json` and the runtime
dylib exist; otherwise it prints which one is missing and the suite stays green
without them. Fetch the dev runtime with:

```bash
scripts/fetch-onnxruntime.sh
```

The manual command is:

```bash
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  ORT_DYLIB_PATH=$PWD/.ort/linux-x86_64/libonnxruntime.so \
  CHEMISTRY_MODELS_DIR=$PWD/models \
  cargo test -p indigo-server -- --include-ignored
```

`tests/mod.rs::models_dir()` honours `CHEMISTRY_MODELS_DIR` when set and
otherwise falls back to `<repo>/models`, so tests, harness and `main.rs` agree on
the model root. The same command runs the OCSR model-gated tests when
`models/ocsr-handdrawn-fp32/` holds the encoder, decoder and vocabulary;
otherwise those tests self-skip.

### Tensor-contract guard

`classifier_model_contract_matches_manifest` opens the artifact through the
registry and asserts the graph matches the manifest: inputs `input_2` float32
`[1, 224, 224, 3]`, `45214:0` and `45216:0` float32 `[1, 1, 1, 3]`, output
`Identity:0` float32 `[1, 1]`. It fails on artifact, manifest or loader drift
before any inference runs.

`validate_tensor_shape` is a pure comparator with unit tests: for the classifier
contract, a dynamic `-1` is accepted **only on axis 0** (batch); a dynamic width,
height or channel axis and any static mismatch are contract errors. A
model-gated test copies the real artifact into a temp root with a manifest
declaring `112x112` and expects `503`. The OCSR decoder has a second dynamic
axis (the decode sequence, axis 1); `validate_ocsr_shape` has its own unit
matrix: exact match, dynamic batch, manifest-dynamic decode sequence, a dynamic
vocabulary axis rejected, rank mismatch, static mismatch and a static graph
dimension where the manifest is dynamic. Every static dimension must stay exact.

### Invalid-model tests (no model)

Temp-dir tests cover each configuration failure with an actionable `503` naming
the manifest path and `CHEMISTRY_MODELS_DIR`: wrong checksum, missing artifact,
unsupported schema, a manifest without `image-classifier`, and an unsupported
preprocessing name. `health_hides_models_whose_artifact_is_missing` pins the
health rule: ids appear only when the artifact file exists.

The OCSR entry has the same temp-root coverage: a missing encoder, decoder or
vocabulary, a bad artifact checksum, and a vocabulary that disagrees with the
manifest (`start_id`/`end_id` or `vocab_size` versus the 156 decoder classes).
Each is a `503` naming the failing artifact and the model root. Checksum
verification and the vocabulary/manifest check run before any session is
created, so these tests need no ONNX Runtime and no real artifact.

### Fixtures

Fixtures are MIT-licensed images from the upstream DECIMER Image Classifier
repository. They are small enough to be committed under
`src-tauri/sidecar/fixtures/` (attribution stays in `NOTICE`); only the ONNX
models themselves are gitignored. They are used by model-gated runs and by the
endpoint tests that need a well-formed image without a model.
`caffeine.webp` is a WebP re-encode of `caffeine.png`.

| Fixture                         | Bytes  | Expected category |
| ------------------------------- | ------ | ----------------- |
| `caffeine.png`                  | 24,609 | `structure`       |
| `caffeine.webp`                 | 8,752  | `structure`       |
| `chinese_character.jpg`         | 1,962  | `no-structure`    |
| `random_scatter_plot_64933.png` | 37,999 | `no-structure`    |

The fixture tests assert status 200, `contains_molecule`, `category`,
`threshold == 0.000089` and `model == "image-classifier@Iagea/d21f4cb"`. They
also assert that `logit` is a number and `score == sigmoid(logit)` within
`1e-6`, which pins the post-processing without pinning a machine-dependent
score. They do not assert a fixed logit value: it varies across ONNX Runtime
builds and CPUs and would make the suite brittle.

### Request-cap tests

`filter_rejects_oversized_body` sends 10,485,761 bytes and expects `413`;
`filter_decodes_bodies_at_exactly_ten_megabytes` sends exactly 10,485,760 bytes
and expects `400` (the cap is inclusive). `filter_accepts_bodies_under_the_ten_megabyte_cap`
proves axum's 2 MiB default is not in effect.

### Preprocessing tests (no model)

- RGBA input is composited on white, not black.
- A grayscale image becomes three identical RGB channels; pure red
  `(255, 0, 0)` must produce the exact Rec.601 luma `76`.
- A wide or tall image keeps its aspect ratio after resize (longest side 224).
- The shorter side is centered on a white canvas (padding pixels are 255).
- Tensor values stay in `0..255` and the layout is NHWC `[1, 224, 224, 3]`.
- WebP bytes decode and preprocess.
- An image wider than 12,000 px is rejected with the decoder size-limit error
  (the cap is 12,000 px per side and 128 MiB of decoder allocations; the
  endpoint maps it to `400`).

### OCSR tests and the large-artifact split

The OCSR model is a pair of ONNX graphs plus a vocabulary, not one file:
`models/ocsr-handdrawn-fp32/encoder.onnx` (208,801,677 B),
`decoder_step.onnx` (107,017,280 B) and `vocab.json` (5,316 B). Together they
are ~316 MB (~301 MiB): gitignored, never committed and never bundled. The suite
uses the same two-tier split as the classifier, with an extra artifact guard:

- **Always run** (no model, no runtime): OCSR preprocessing units (including the
  NumPy-derived non-identity contrast-stretch pixel, the all-background crop and
  the extreme-aspect guard), vocabulary parsing/detokenization/digit remap, and
  greedy decoding against a **deterministic fake decoder step**. The fake records
  the exact token vector fed at each step and returns fixed probability rows, so
  `argmax`, `end_id`/`max_len` stopping (including an end token exactly on the
  last allowed step), the `confidence` mean and the `incomplete` decision are all
  tested without ONNX. Endpoint tests cover unsupported media type and
  undecodable bytes (`400`), over-cap bodies (`413`) and a missing/invalid model
  (`503`); the runtime-missing path is covered by the classifier suite and
  manual verification. The `incomplete` → `422` mapping is exercised through the
  `ensure_complete` helper the handler uses, never by hoping the real model
  truncates.
- **Model-gated**: real encoder + decoder inference, the two-graph tensor
  contract guard, a real structure fixture (`caffeine.png`) and health listing
  both ids. These are marked `#[ignore = "requires local ONNX model"]`. The
  contract and fixture tests build a temp model root whose manifest declares
  only the OCSR entry and symlink the three real artifacts into it, so they run
  with the OCSR pair installed even when the classifier is absent. Only
  `health_lists_both_models_when_present` requires both artifacts. On Windows
  without symlink privileges the temp-root tests self-skip with a message;
  install the artifacts under `models/` or enable Developer Mode to run them.
- **Artifact-gated**: every model-gated OCSR test starts by checking that the
  encoder, decoder and vocabulary exist under the model root and returns early
  with a message when they do not. The harness keeps `--include-ignored` when
  the shared manifest and runtime exist, so a checkout that has the classifier
  but not the 300 MB OCSR pair still runs the classifier gated tests and skips
  only OCSR.

### OCSR preprocessing tests (no model)

- Transparent RGBA is composited on white, not black.
- The contrast stretch maps the per-image minimum..maximum (all channels) to
  `0..255` with NumPy's `linspace` float math (explicit `0`/`255` endpoints,
  truncating cast), not integer floor division. The non-identity test uses a
  composited alpha of `255` and grey levels `150..255`: the reference LUT maps
  `171` to `50` (integer floor gives `51`) and the full pipeline yields the
  hardcoded pixel `48` (integer floor would yield `49`).
- The grayscale step uses the BGR2GRAY quirk: pure red `(255, 0, 0)` uses the
  `0.114` weight (≈29) and pure blue `(0, 0, 255)` the `0.299` weight (≈76),
  before `Contrast(1.8)`.
- Resize rules: a 300×300 square becomes 512×512; an image with either side
  ≥ 512 is not resized; any other image is scaled by `512 / max(w, h)` with
  `int()` truncation.
- White borders are cropped to the bounding box of non-background pixels; an
  all-background image is returned unchanged (unit test on `crop_empty_borders`,
  which checks the dimensions and every pixel).
- The central canvas is `max(512, int(1.2 * max(w, h)))` and padding is white.
  A canvas over `8,192` px per side is rejected as an extreme aspect ratio
  (`400`); a `12,000×1` image trips it.
- Brightness ×1.6 is applied before the final 512×512 LANCZOS resize.
- The final tensor is NHWC `[1, 512, 512, 3]` float32, normalized with the
  ImageNet mean/std (not the classifier's `0..255` range).

### OCSR vocabulary and decode tests (no model)

- `vocab.json` exposes `id_to_token` and `token_to_id`; ids `0` (pad), `13`
  (start) and `14` (end) are skipped when building the SMILES.
- The digit remap turns `! $ ^ < > ? £ ¢ € §` into `1 2 3 4 5 6 7 8 9 0`.
- The fake decoder step proves the loop: seed `[13]`, exact token vectors fed at
  each step, argmax of the last position, stop at `14`, stop at `max_len = 302`,
  an end token exactly on the last allowed step is complete,
  `incomplete = last != 14`, and `confidence = mean_confidence(...)` is the mean
  chosen-token probability including the end token (unit-tested directly).
- An incomplete prediction goes through the same `ensure_complete` helper as the
  handler: it maps to `AppError::Unprocessable`, and the response is a `422`
  with the actionable message and no `smiles` field.

### OCSR fixtures

The OCSR model-gated test runs `caffeine.png` against a temp root that declares
only the OCSR entry and asserts a `200`, the exact SMILES
`CN1C=NC2=C1C(=O)N(C)C(=O)N2C`, `incomplete == false`, `confidence` in
`0.99..=1.0` (the measured value is `0.9957286571634227`) and
`model == "ocsr-handdrawn@zenodo:10781330"`. The SMILES is deterministic for
this fixture; the confidence is pinned as a range so a different CPU or ONNX
Runtime build cannot make the suite brittle.

---

## 6. Frontend

There is no JS test runner configured yet. Frontend correctness is verified by
`pnpm exec tsc --noEmit`, `pnpm build` and the manual checklist in
`docs/verification.md`. If a runner is added, document it and add it to the
harness before writing tests that depend on it.

---

## 7. Assertion quality

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

## 8. Commands

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

# Model-gated inference tests (requires models/ and a loadable ONNX Runtime)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  ORT_DYLIB_PATH=$PWD/.ort/linux-x86_64/libonnxruntime.so \
  CHEMISTRY_MODELS_DIR=$PWD/models \
  cargo test -p indigo-server -- --include-ignored

# One test
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server info_endpoint_returns_version
```
