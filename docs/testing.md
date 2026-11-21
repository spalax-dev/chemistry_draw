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
- **Frontend unit tests** live next to their module as
  `src/<module>.test.ts` (Vitest) and cover pure helpers and constants only; see
  §6.1.

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
- The compatibility contract is tested cross-platform in the suite that
  replaces `tests/imago_absent.rs`: `/v2/info` (and its `/v2/indigo/info`
  alias) advertises exactly the synthetic `imago_versions: ["local-ocsr"]`
  capability when a temp root holds both models' artifacts and manifest, and
  `[]` on an empty root (the B3 gate), `/v2/health` exposes no `imago_worker`,
  `POST /v2/imago/uploads` returns an `upload_id`, and a `GET` for an unknown
  id is `404`. The old assertion that `/v2/imago/uploads` returns `404` is
  gone: the route is now the compatibility shim, while the real Imago backend
  stays absent. The same module runs on Linux and Windows CI, so no
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
  A pattern that would also skip `libindigo*`, `libindigo-renderer*` or
  `libonnxruntime*` must fail the test, because those stay bundled.
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

## 5. Model-gated ML tests

ONNX model weights are gitignored and absent in CI, and the model-gated tests
also need a loadable ONNX Runtime, so the ML suite splits in two:

- **Always run** (no model, no runtime): preprocessing units, the tensor-contract
  comparator, the 400/413/503 error paths, the recognition job store and
  upload protocol, and anything that does not open a real session.
- **Model-gated**: real inference, the tensor-contract guard, the
  contract-mismatch path and the end-to-end Recognize pipeline are marked
  `#[ignore = "requires local ONNX model"]` and run only when the model root
  exists. They also need a loadable ONNX Runtime (`ORT_DYLIB_PATH`).

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

### Model delivery tests (B3)

The catalog/downloader suite never touches the real network. Each test builds a
fresh app state with its own temp model root and an injected dummy catalog
(`AppState::with_catalog`); it does not read or write the shared `models/`
checkout. The bundled catalog is the production default: three tests pin its
versions, URLs, sizes, SHA-256 values and the published total, while the
download tests use the dummy catalog. The suite does not set
`CHEMISTRY_MODEL_CATALOG`: catalog errors are injected through
`AppState::with_catalog_error`, so parallel tests never mutate the environment.
`CHEMISTRY_MODEL_CATALOG` remains the runtime support override (a path to a JSON
catalog); an unreadable or invalid override is an actionable `500` on the model
routes. The test HTTP server is a small axum/tokio listener bound to
`127.0.0.1:0`, serving dummy artifacts from a temp directory and recording each
request's `Range` header. Dummy artifacts are a few KiB with SHA-256 values
computed in the test, and the catalog declares their URLs, sizes and hashes.

- **Status with an empty root.** `GET /v2/models` is `200` with the test catalog
  version, `ready: false`, `manifest_present: false`, the declared total bytes,
  every model `installed: false` with its `missing` paths and
  `download.state: "idle"`. `/v2/info` has `imago_versions: []`. No directory is
  required for the route to answer.
- **Success and manifest generation.** A catalog with the four small artifacts
  (classifier, encoder, decoder step and vocabulary) downloads to a temp root;
  the server receives the expected GETs; the files appear at their final paths
  with no `.part` left; `<model root>/manifest.json`
  is schema 1, carries `catalog_version`, maps `path`/`sha256` to
  `file`/`artifact_sha256`, and parses through the existing registry. Status
  becomes `ready: true` with `installed_bytes == total_bytes`, and `/v2/info`
  advertises `["local-ocsr"]`.
- **Range resume.** Pre-seed `<path>.part` with the first N bytes; the download
  sends `Range: bytes=N-`, the server answers `206` with the remainder, and the
  final file is byte-identical. Two dedicated tests cover restart semantics: a
  server mode that ignores Range (`200` with the full body) truncates and
  restarts, and a mode that answers `416` to the range request discards the
  `.part`, retries without Range and completes. A cancelled run keeps the
  `.part` and a retry resumes from it instead of restarting.
- **Checksum mismatch and repair.** A catalog hash that does not match the
  served bytes ends `failed`, removes the `.part`, leaves no final file and
  names the path, expected and actual hash. `POST /v2/models/verify` reports
  `status: "corrupt"` and the repair hint. Repair is tested in the normal case
  too: a generated manifest plus all four artifacts with one same-size corrupt
  file makes `download` answer `202` (not a no-op), fetch only that artifact,
  replace it, rewrite the manifest and leave `verify` `ok`.
- **Cancel.** A slow/chunked response is cancelled with
  `POST /v2/models/download/cancel`: state `cancelled`, no error, `.part`
  retained, and a second POST resumes rather than restarting.
- **Offline.** A URL pointing at a closed `127.0.0.1` port ends `failed` with an
  actionable connection message and keeps any `.part`; the sidecar keeps serving
  Indigo.
- **Disk guard.** `ensure_space` has pure floor tests; the downloader has an
  injectable free-space probe so an integration test simulates a full volume,
  asserts the run fails before any HTTP request with the required/available
  bytes and writes no artifact, then simulates enough space and completes.
- **Update and repair by catalog version.** A generated manifest with an older
  `catalog_version` reports `update_available: true`; a download re-verifies
  the matching artifacts without fetching them, rewrites the manifest with the
  active version, and verify stays `ok`. A corrupt artifact is repaired. A newer
  installed catalog reports `update_available: false` and a download is `409`
  with no request and an untouched manifest. The catalog total uses checked
  arithmetic and rejects an overflowing or absurd size sum.
- **Manifest validity and publishing.** A syntactically valid but unusable
  manifest (`{}`) is `manifest_present: true` but `ready: false`, and
  `/v2/info`/`/v2/health` do not advertise models; a download regenerates it.
  A successful run publishes the manifest last through `manifest.json.tmp` plus
  a rename (no `.tmp` remains), and a failed run with an existing manifest
  leaves that previous file byte-identical.
- **Restart state.** A complete root reports `ready` and a partial root reports
  `idle` on a fresh app state; neither contacts the network. An explicit
  download on the partial root resumes its `.part` with `Range`.
- **Broken catalog.** An injected catalog error makes all model routes `500`
  with the `{ "error": ... }` envelope while `/v2/info` and `/v2/health` answer
  `200` with no models; the model root is never created.
- **Endpoint conflicts.** A second `POST /v2/models/download` while a run is
  active is `409`; cancel without a download is `409`; verify during a run is
  `409`; a POST when every hash and the manifest match is `200` and starts no
  worker.

The real Hugging Face download (~324 MB) is a **gated/manual smoke**, not CI: an
`#[ignore = "requires network"]` test (or a script) downloads both families into
a temporary root, checks the pinned SHA-256 values, the generated manifest and
the measured total, and runs only on demand. CI never downloads 324 MB and never
requires Hugging Face to be reachable.

The model-gated inference tests described at the start of this section are
unchanged: they still need a local model root (`models/` or
`CHEMISTRY_MODELS_DIR`) and a loadable ONNX Runtime, and self-skip otherwise.

### Clean-install and packaging contract tests (B3)

The clean-install contract lives in scripts and packaging configuration, so
`scripts/lib/*.test.mjs` guard it without building a package, launching Tauri or
touching the network. The suite asserts the real files:

| Target                                                                                    | Assertion                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-packages.sh`, `scripts/make-appimage.sh`, `Taskfile.yml`                   | no step copies `models/`, `*.onnx` or a `manifest.json` into a payload; the bundle resource copy stays `lib/linux-x86_64/**`                                                                                                                                                                                                                                                  |
| `src-tauri/tauri.linux.conf.json`, `src-tauri/tauri.windows.conf.json`, `tauri.conf.json` | `resources`/`externalBin` name no model path and keep `indigo-server`; `../models` never appears                                                                                                                                                                                                                                                                              |
| `.github/actions/windows-build/action.yml`                                                | the smoke starts the sidecar with an empty model root and asserts `GET /v2/models` `200` with `ready: false`, `manifest_present: false`, `installed_bytes: 0`, `total_bytes: 323987190` and `download.state: "idle"`, and `GET /v2/info` `200` with `imago_versions: []`; the obsolete `local-ocsr` expectation on the model-less runner is gone and no step downloads models |
| `docs/verification.md` payload inspection and `scripts/lib/clean-install.test.mjs`        | the absence greps cover `.onnx`/`models/`/`manifest.json`, and the payload keeps Indigo plus `libonnxruntime`                                                                                                                                                                                                                                                                 |
| clean-root packaged smoke                                                                 | a script/check exists for the AppImage payload with an empty `CHEMISTRY_MODELS_DIR`, reproducing the empty `/v2/models` and `/v2/info` `[]` assertions                                                                                                                                                                                                                        |

Rules:

- Assert the real files, not a fixture. Removing the empty-root `/v2/models`
  check, restoring `local-ocsr` on the runner, adding a model copy to a
  packaging script, or dropping the `.onnx` absence grep must each make a test
  fail; the Windows checks are RED before the action is updated.
- The contract tests never build a package, launch the app or download models.
  The payload inspection, the packaged sidecar download/verify/recognize and
  the clean app-data flow stay the manual/gated smoke in
  `docs/verification.md` §2 "Clean install (B3)". The temporary Playwright flow
  (§6.2) can be pointed at a fresh profile for the clean-root UI state machine,
  but it is still recreated per activity and never committed.

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

### OCSR repetition guard (no model)

The guard is a pure function of the emitted ids: no model, no runtime, no
timing, so every case runs in the always-run tier against `FakeGraphs`. It
bounds the pathological periodic tail found by the parity pilot (the 302-step
`C=` loop of `hdm::CDK_Depict_5_82`); the design and the measured parameters are
in `docs/benchmarks/ocsr-tail-fix.md`.

- A one-token cycle (the same id repeated) stops at the configured run length
  with `incomplete = true` and no `end_id`.
- A long alkane run (20 `C` ids then `end_id`) is **not** cut: the one-token
  tier is high enough that a legitimate chain completes; this is the rule that
  keeps the guard from truncating long hydrocarbons.
- A two-token cycle (`C`, `=`) stops far below `max_len = 302`, with the exact
  stop step asserted; the production stop is 32 generated tokens (33 ids
  including `start_id`, 16 complete `C`, `=` cycles).
- A legitimate repeated motif below the cutoff is **not** cut: the decode
  reaches `end_id` with the motif intact.
- An `end_id` before the threshold completes normally (`incomplete = false`);
  the guard never fires on the end step.
- A long non-repetitive decode still runs to `max_len` and reports
  `incomplete = true`; the guard never replaces the existing bound.
- The returned ids, the probability count (one per generated token) and the
  exact stop step are asserted, not just the `incomplete` flag.

**Mutation rule.** A guard that never fires fails the one-token and `C=` cases;
a guard that applies the two-token threshold to a one-token run fails the
long-alkane case; a guard that fires on the legitimate motif fails the
below-cutoff case; a guard that changes EOS or `max_len` behaviour fails the EOS
and non-repetitive cases; a boundary error (fires at `R - 1`, not at `R`) fails
at least one case. The pathological image itself is checked by the pilot
measurement and `docs/verification.md`, never by a committed
multi-hundred-megabyte fixture.

### OCSR fixtures

The OCSR model-gated test runs `caffeine.png` against a temp root that declares
only the OCSR entry and asserts a `200`, the exact SMILES
`CN1C=NC2=C1C(=O)N(C)C(=O)N2C`, `incomplete == false`, `confidence` in
`0.99..=1.0` (the measured value is `0.9957286571634227`) and
`model == "ocsr-handdrawn@zenodo:10781330"`. The SMILES is deterministic for
this fixture; the confidence is pinned as a range so a different CPU or ONNX
Runtime build cannot make the suite brittle.

### Recognize Molecule compatibility tests

The `/v2/imago/uploads` shim has three test layers. The suite that replaces the
old absence contract also pins `/v2/info` to exactly
`imago_versions: ["local-ocsr"]` with a temp root holding both models, to `[]`
without them (the B3 gate), and `/v2/health` to no `imago_worker`; it never
asserts that the route returns `404`.

**Always run (no model, no runtime):**

- **Job store with an injected clock.** Create → `PENDING`; completion →
  `SUCCESS` with `metadata.mol_str`; failure → `FAILURE` with the message; a
  job still `PENDING` at the TTL boundary becomes the timeout `FAILURE`; a
  resolved job is pruned at `resolved_at + TTL` and a later lookup is unknown
  (`404`); ids are unique. `len`/`is_empty` make pruning observable: the purge
  test asserts the expired entries actually leave the map, not merely that
  `get` answers `None`. The store is a pure state machine, so there is no
  `sleep` and no wall-clock flakiness.
- **Production pruning.** A stale resolved job is staged through the shared
  store, then a poll and an upload each shrink it to the expected count,
  proving both handlers call `purge` before answering.
- **HTTP protocol with a stub pipeline.** `POST` returns `200 { upload_id }`
  and ignores `?version=`; an unknown `GET` is `404`; the sequence is
  `PENDING` → terminal; the `SUCCESS` body has `state` and exactly
  `metadata.mol_str`; the `FAILURE` body has `state` and an `error`, with no
  `mol_str`. The test helper polls with a short interval (20 ms) and a bounded
  deadline; the real Ketcher client waits 300 ms, then polls every 500 ms with
  no fixed attempt limit.
- **POST validation.** Missing or unsupported `Content-Type` is `400`; a body
  over 10,485,760 bytes is `413` and exactly 10,485,760 bytes is accepted by
  the route (then the worker fails if it is not an image). Undecodable bytes
  are a job `FAILURE`, not a `400`: POST validates only the media type and the
  cap, and the poll is asserted to end `FAILURE` with the exact unsupported
  image copy. The image decodes before the model registry is resolved, so that
  assertion works without a model installed.
- **Pipeline gates with stubbed stages.** Filter `contains_molecule: false` →
  `No molecule was detected in this image.`; a confidence just below `0.901`
  and an `incomplete` prediction both → the low-confidence message; a
  confidence exactly at `0.901` on a complete decode passes; a conversion error
  → the conversion message; a missing model/registry → the model-unavailable
  message. The exact strings are asserted because the UI matches them.
- **Missing model.** A temp root with no manifest (or no recognizer entry)
  yields a `FAILURE` job, not a `503`: `POST` still returns an `upload_id`, the
  worker resolves the configuration error, and `GET` reports
  `state: "FAILURE"` with the setup message. `/v2/filter/classify` and
  `/v2/ocsr/recognize` keep their direct `503`.
- **Timeout.** Two bounds are covered. The 120 s worker bound is tested through
  the injected seam in `spawn_processing_with` (a 20 ms bound, a fake blocking
  pipeline released after the timeout) and asserts the exact timeout `FAILURE`.
  The 600 s store TTL transition covers the `PENDING` → timeout `FAILURE` path
  deterministically with the injected clock.

**Model-gated (both models):**

- A non-structure fixture (`chinese_character.jpg` or
  `random_scatter_plot_64933.png`) through `POST` and polling → `FAILURE` with
  the no-molecule message and no `mol_str`.
- `caffeine.png` through `POST` and polling → `SUCCESS`; `metadata.mol_str`
  contains `V2000` and `M  END`, and its counts line declares caffeine's
  `14 15` atoms/bonds header. Converting that molfile back with Indigo yields
  the known caffeine SMILES `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`. The client
  receives a molfile, never a SMILES. The real pipeline is asynchronous, so the
  test polls with a bounded timeout until the job leaves `PENDING`; it never
  relies on a fixed sleep. It needs the classifier and the OCSR pair, so it
  self-skips when either is absent.

---

## 6. Frontend

Frontend correctness is verified by `pnpm exec tsc --noEmit`, `pnpm build`, the
Vitest suite for pure helpers below, and the manual checklist in
`docs/verification.md`.

### 6.1 Vitest scope: pure helpers

Vitest is the frontend test runner. The test task adds it (with the `test`
script and a harness block) before the first helper test is written. Tests live
next to the module as `src/<module>.test.ts` and cover **only** pure functions,
constants and the fetch adapters with an injected `FetchLike` from
`src/document.ts`, `src/autosave.ts`, `src/saveRoute.ts`,
`src/recognizeErrors.ts`, `src/modelSetup.ts`, `src/ketcherOptions.ts`,
`src/ui/toolbarIcons.ts` and `src/ui/tokens.ts` — no DOM, no network, no Tauri
imports, no React rendering. `src/ketcherOptions.ts` is tested with fake
container/fiber/store objects; its `document` fallback is never reached in the
Node environment.

| Helper / module          | Behaviour under test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentTitle`          | `Untitled` with no path; base name without `.ket`; `*` only while dirty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| names                    | `documentName` and `exportFileName`: base name, untitled fallback, Windows paths, export extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| dirty transitions        | an editor change sets dirty; Save and `.ket` Open/New clear it; importing another format marks the document dirty with `path: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| save target              | Save with no path defaults to `untitled.ket`; with a path it reuses it; Save As appends `.ket`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| save vs export mapping   | `.ket`/`getKet` for Save; V2000, V3000, SMILES, InChI, SVG, PNG sources and file extensions for Export; Export leaves `path` and `format` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| saved-blob routing       | `.ket` (any case) routes to document save: existing path, Save As when `path` is `null`; `.mol`/`.smi`/`.inchi`/`.svg`/`.png` route to export save with `path` and `format` unchanged; no Tauri or no registered handler falls back to a download; an unknown or missing extension takes the export route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| saver default filename   | an untitled `.ket` document save suggests `untitled.ket`; the export route keeps the filename Ketcher supplied (the app's own Export naming is `exportFileName`, covered by the `names` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| autosave scheduling      | debounce coalesces rapid edits; the slow interval writes only while dirty; a clean document never writes; timers reset after a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| recovery decision        | no metadata, `dirty: false`, snapshot older than the last clean save, snapshot newer, unknown or missing original path, unreadable metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| write generation         | a write started before `clearSnapshot()` cannot recreate the snapshot; a stale write removes the shared snapshot files it just committed (metadata, structure, partial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| close-guard decision     | clean allows close; Save closes after saving; Discard closes without saving; Cancel stays open; a cancelled Save As aborts the close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| recognition errors       | `unwrapError` unwraps Ketcher's stringified `FAILURE` body (`{"state":"FAILURE","error":"…"}`, with or without an `Error:` prefix) and reports `json: true`; a JSON body without a usable `error`/`message` stays JSON with an empty detail; plain text (including a `No molecule…` message) is not JSON and keeps the original message; the plain-text `413` parse errors (`Unexpected token`, `is not valid JSON`, `JSON Parse error`) map to "The server could not process the image. It may be too large."; `friendly` maps every documented substring to its copy, including the editor/server hints (`already have edge between vertices`, `Indigo load error`, `Load failed`, `Connection terminated unexpectedly`); the title selection returns `Structure problem` for a mapped copy or a JSON body and `Error` for an unmapped non-JSON failure; `errorMessage` returns an `Error`'s message verbatim and `String(value)` for a non-Error, so the document workflow never applies the recognition copy; `isModelUnavailable` returns `true` for the exported `MODEL_UNAVAILABLE` substring in a JSON `FAILURE` body with an `Error: ` prefix, in a bare JSON body and in plain text, and `false` for an unrelated failure or a JSON body with no usable detail, so only the documented model-unavailable failure forces the Models control; its copy points at setting up or repairing from the Models entry |
| ketcher options          | `applyKetcherAppOptions` dispatches exactly `APP_OPTIONS` (with the merged `app` payload), `UPDATE` and a no-op `ACTION` for a store whose `getState().options.app` exists; returns `false` and dispatches nothing for a missing React root, a non-fiber root, a store without `getState`, a state without `options.app`, a throwing `getState` and a throwing dispatch; the fiber walk stops at 10,000 nodes (a store past the cap is not reached); `findKetcherRoot` returns the `clientArea.closest(".Ketcher-root")` element, tolerates a missing or throwing `closest`, and returns `null` outside a DOM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| toolbar icon module      | the exported `imageLink` is a valid, fully transparent SVG data URI (draws nothing); the four button ids and titles stay stable (`chemistry-draw:save`/`Save`, `chemistry-draw:new`/`New`, `chemistry-draw:export`/`Export`, `chemistry-draw:models`/`Models`); the generated style has exactly one mask rule per `alt` (Save/New/Export/Models) with a `mask-image` data URI; the style contains no literal colour — no hex, no `%23` escape and no named colour such as `black`/`white`/`grey` — only `currentColor`; every glyph is an outline (`fill='none'`, `stroke-width='1.5'`, round caps/joins) whose path centrelines stay inside 5.25-18.75                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| model setup format       | `formatBytes` uses binary units with one decimal above bytes: `0` → `0 B`, `1023` → `1023 B`, `1024` → `1.0 KiB`, `1536` → `1.5 KiB`, `8,162,917` → `7.8 MiB`, `315,824,273` → `301.2 MiB`, `323,987,190` → `309.0 MiB`, `1,073,741,824` → `1.0 GiB`; a negative, `NaN` or infinite count returns `0 B`. `progressPercent` floors and clamps: `0/0` → `0`, `0/100` → `0`, `50/100` → `50`, `1/3` → `33`, `100/100` → `100`, `150/100` → `100`, `-1/100` → `0`, and a non-finite value → `0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| model status parsing     | `parseModelsStatus` accepts the documented `/v2/models` payload, returns it typed as `ModelsStatus` (unknown extra fields are allowed and do not reject it), accepts `installed_catalog_version: null`, `current_file: null` and `error: null`; returns `null` for a non-object, a missing/`null` `download`, an unknown/non-string `download.state`, a non-array `models`, a model `missing` that is not a string array, non-boolean `ready`/`installed`/`update_available`, a negative or non-finite byte count, a non-integer or mistyped `catalog_version`/`installed_catalog_version`, a non-string model `key`/`id`/`version`/`license`, and a non-string `download.current_file`/`download.error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| model HTTP adapters      | `fetchModelsStatus`, `startModelDownload`, `cancelModelDownload` and `verifyModels` join `apiBase` with and without a trailing slash, send the documented method (`GET` for the status, `POST` for actions/verify) and parse the documented bodies; a non-OK response surfaces the `{ "error": … }` envelope, falls back to a plain-text body and then to `statusText`/`HTTP <status>`; a `409` action names the status and the backend detail; a malformed status or verify body throws the "not a valid …" message; a rejected fetch maps to the actionable "Could not reach the local model service at <base>" message with the cause appended; verify returns the parsed artifact report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| model setup view         | `setupView(status, verify)` returns the phase and primary label for every state: `ready: false` + `idle` → `not-installed`/`Download`; `downloading` → `downloading`/`null` with `canCancel: true`; `verifying` → `verifying`/`null` with `canCancel: false`; `cancelled` → `paused`/`Resume`; `failed` → `failed`/`Retry`; `ready` → `ready`/`Verify`; `ready` + `update_available` → `update`/`Update`; `ready` + a verify report with `ok: false` → `repair`/`Repair`; a `failed` run on a ready install stays `failed`/`Retry`; an explicit verify failure wins over `update_available`; `canVerify` is true only on a ready install with no active run; Later is not part of the view and is always rendered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| model control visibility | `modelsControlVisible(status, verify, attention)` is `true` for a `null` status (not read yet), for every `ready: false` status, for `ready: true` with `update_available: true`, for `ready: true` with a verify report whose `ok` is `false`, for `ready: true` with `download.state` downloading, verifying, cancelled or failed, and for a healthy ready install once `attention` is `true` (the recognition-unavailable override); it is `false` only for a `ready: true` install with `update_available: false`, an `idle`/`ready` download state, no verify report (or an `ok: true` report) and `attention: false`; a `null` report never hides an unknown, not-ready or updating install                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| model install health     | `modelInstallHealthy(status)` is `true` only for a non-null status with `ready: true`, an `idle`/`ready` download state and `update_available: false`; it is `false` for `null`, a not-ready install, an available update, and a `downloading`, `verifying`, `cancelled` or `failed` run. `modelsControlVisible` applies the attention override first and then uses this helper, so the visibility table is unchanged; `App.tsx` uses the same helper to decide when a completed download-style run is proof of health                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| attention note           | `modelAttentionNoticeVisible(status, verify, attention)` is `true` only when `attention` is true, the status is non-null and `setupView(status, verify).canVerify` is true with `verify === null \|\| verify.ok`; it is `false` without the override, for a `null` status, for a not-ready install, for a ready install whose run is `downloading`, `verifying`, `cancelled` or `failed`, and for a verify report that needs Repair, so the note is rendered exactly when the dialog offers the Verify action it points at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| dialog tokens            | the overlay token is exactly `rgba(94,94,94,0.2)` and the pre-fade token is `rgba(94,94,94,0.01)`; the hatch overlay token's data URI decodes to a 10×10 SVG whose path is `M0 10 10 0zm12-2-4 4zM-2 2l4-4z` with `stroke` `#555`, `stroke-width` 2 and `stroke-opacity` 0.02; its repeat and size tokens are `repeat` and `10px 10px`; the old `rgba(94,94,94,0.8)` overlay is gone; the dialog panel tokens resolve to radius `8px`, border `none` and shadow `none`; `tokens.dialog.transition` is `background-color 0.3s` (the transition lives on that token, not on the overlay colour); the generic 3 px `radius` and soft shadow remain for non-dialog surfaces and are asserted non-empty; every in-app dialog gets its overlay and panel styling from these tokens, with no per-dialog colour, radius, border or shadow; `tokens.dialog.backdropPattern` stays a bare `data:image/svg+xml` URI that does not itself start with `url(`, while the `background-image` the overlay applies wraps that token as `url("…")` — the token raw, the CSS function owned by the component                                                                                                                                                                                                                                                                                                                              |

Rules:

- Assert exact values, not "does not throw"; the tables in `docs/architecture.md`
  §5.3–5.5 are the expected outputs.
- Use `vi.useFakeTimers()` and fixed timestamps. No real timers, no wall clock.
- Mutation check before committing: removing the debounce, writing while clean,
  or returning the Save format for Export must each make a test fail. For the
  saver, routing a `.mol` blob to document save (or a `.ket` blob to export)
  must fail a test. For the dialog tokens, restoring the `rgba(94,94,94,0.8)`
  overlay, dropping the diagonal hatch from the overlay, changing its stroke
  colour/width/opacity or its `repeat`/`10px 10px` size, the `3px` panel radius,
  the `1px` panel border or any panel shadow must each make the token test fail.
  For the hatch, dropping the `url("…")` wrapper from the applied
  `background-image` or pre-wrapping the token itself must each fail a test.
  For recognition errors, dropping the `json` flag, echoing the raw body,
  removing a documented substring from the mapping, returning the `Error`
  title for a mapped failure, or dropping the `isModelUnavailable` match (a JSON
  body with/without the `Error: ` prefix, plain text, and the negative
  unrelated/no-detail cases) must each make a test fail. For model setup,
  rounding instead of flooring the percent, defaulting an unknown status to
  `idle`, mapping `cancelled` to Retry, dropping Repair, returning Verify while
  a run is active, or accepting a malformed status must each make a test fail.
  For the Models control, showing it on a healthy ready install, hiding it
  while the status is unknown/not ready, an update is available, a run is
  downloading, verifying, cancelled or failed on a ready install, a verify
  report needs repair, or `attention` is true, must each make a test fail. For
  the install-health helper, treating a `null`, not-ready, updating or
  active/cancelled/failed install as healthy must each make a test fail, which
  pins the accepted-start rule: the fake `202` still reports `downloading`, so a
  predicate that called that healthy would clear the attention on an accepted
  start and must fail these tests. The stale-proof regression is the browser
  flow's close-during-repair probe (§6.2), not a unit test. For the
  attention-note helper, showing the note without the override, on a
  `null`/not-ready status, while a ready run is
  downloading, verifying, cancelled or failed, or while the verify report needs
  Repair must each make a test fail.
  For the model HTTP adapters, dropping the error-envelope/plain-text read,
  ignoring a `409`, accepting a malformed verify report or swallowing the
  unreachable-service message must each make a test fail.
- The dialog-token test asserts the exported `tokens` constants directly; the
  rendered overlay tint, hatch visibility, fade smoothness and panel shape are
  covered by the manual checklist (`docs/verification.md` §2, "In-app dialog
  styling").
- The `ErrorDialog` rendering itself — title, copy, Close button and
  Ketcher-style backdrop — is not unit-tested (Vitest renders no React) and is
  covered by the manual check in `docs/verification.md` section 2,
  "Recognize Molecule end to end".
- Do not mock Tauri in these tests. The I/O adapters (`appDataDir`,
  `writeTextFile`, `onCloseRequested`) stay thin and are covered manually.
- Clearing `dirty` and the recovery snapshot is **not** part of the pure
  `routeSavedBlob`: `saveRoutedBlob` in `src/App.tsx` writes the blob first and
  then applies the state change. That adapter is not unit-tested.

### 6.2 Model setup UI

The setup UI has three layers. The pure helpers and the HTTP adapters in
`src/modelSetup.ts` are covered by Vitest; the dialog
(`src/ui/ModelSetupDialog.tsx`), the `Dialog` panel and the fetch/poll/action
loop in `App.tsx` are exercised by a **temporary local browser flow** plus the
manual checklist in `docs/verification.md` §2, "Model setup UI (B3)". There is
no committed Playwright suite, no `pnpm test:e2e` script and no Playwright
dependency in `package.json`: the flow needs Chromium, a sidecar process and a
dev server, so it is recreated for the activity and its output is reported, not
checked in. Vitest renders no React and mocks no Tauri, as in §6.1.

The helper contract, with the exact expected values in the §6.1 table:

| Helper                        | Responsibility                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `formatBytes`                 | binary units (`B`, `KiB`, `MiB`, `GiB`) with one decimal above bytes; defensive `0 B` for invalid counts                                                                                                                                                                 |
| `progressPercent`             | integer percent, floored and clamped to `0..100`; `0` when the total is not positive                                                                                                                                                                                     |
| `parseModelsStatus`           | validates a `GET /v2/models` body into `ModelsStatus` or returns `null`; no coercion and no unknown states                                                                                                                                                               |
| `setupView`                   | maps the status plus an optional verify report to `{ phase, primary, primaryLabel, canCancel, canVerify }`                                                                                                                                                               |
| `modelsControlVisible`        | `true` for an unknown or not-ready status, a ready install with an update, an active/cancelled/failed run, a verify report `ok: false` or `attention: true`; `false` only on a healthy ready install (`idle`/`ready` download state, no update, no repair, no attention) |
| `modelInstallHealthy`         | `true` only for `ready: true`, an `idle`/`ready` download state and no catalog update; the health predicate behind the visibility and attention-clear decisions                                                                                                          |
| `modelAttentionNoticeVisible` | `true` only while `attention` is set and `setupView` offers Verify (`verify` null or `ok: true`, ready install, no active/cancelled/failed run); the dialog renders the muted attention note only then                                                                   |

`setupView` precedence is fixed: an active run (`downloading`, `verifying`),
then `failed`, then `cancelled`, then a ready install (repair > update > ready),
then not installed. A failed repair on a ready install therefore offers Retry,
not Verify; a verify report with `ok: false` wins over `update_available`.
Button labels are exactly `Download`, `Resume`, `Retry`, `Update`, `Verify`,
`Repair`; `Cancel` is separate and only true while downloading. `Later` is not
part of the view and is always rendered by the dialog.

The **Models** toolbar control is the same kind of decision:
`modelsControlVisible(status, verify, attention)` hides it on a healthy ready
install — `ready: true`, `download.state` `idle`/`ready`, no catalog update, no
verify repair and `attention: false` — and shows it whenever setup needs
attention: the status is unknown or not ready, an update is available, a verify
report needs repair, a run is downloading, verifying, cancelled or failed even
though the install is ready, or the recognition-unavailable `attention` override
is set. That last case covers a corrupt-but-present artifact: a status read sees
presence and the manifest only, so `ready` stays true, but a recognition failure
that reports the models unavailable forces the control visible until a Verify
report with `ok: true` or a completed download-style run whose status is healthy
proves the files; an accepted start (`202`) is not proof, and the dialog shows a
muted Verify note while the override is armed on a ready, verify-capable dialog
(`modelAttentionNoticeVisible`). The active/cancelled/failed case keeps
**Cancel**, **Resume** and **Retry** reachable instead of stranding a run behind
a hidden control. The toolbar button itself is React/DOM, so only the helper is
unit-tested; the hide/show is asserted in the temporary browser flow below, and
the dialog stays available while the control is visible. An already open dialog
is not force-closed when the install becomes ready.

**HTTP adapters.** `src/modelSetup.ts` owns the routes and response handling:
`fetchModelsStatus`, `startModelDownload`, `cancelModelDownload` and
`verifyModels` take an injectable `FetchLike` and are unit-tested with a fake
fetch (no network). The tests pin endpoint joining (with and without a trailing
slash), the `{ "error": … }` envelope, a plain-text error body, the status-text
fallback, a `409` action error, a malformed status or verify body and an
unreachable service. `App.tsx` owns the polling/action loop; it clears the last
verify report when a Download/Resume/Retry/Update/Repair action starts and when
it succeeds, so a repaired install returns to `ready`/Verify instead of staying
on Repair. Closing the dialog does not clear it, so **Later** then reopening a
dismissed Repair shows Repair again. The attention override is stricter and has
two separate flags in `App.tsx`: the override is React state and the pending
health proof is a ref:

- A Verify report with `ok: true` clears the override.
- Accepting a download-style run does not clear the override; it arms the health
  proof. A response that is already healthy (the `200` no-op re-hash) is proof
  and clears it immediately; otherwise a later status read clears it only when
  the completed run reports healthy (`modelInstallHealthy`). An ordinary read
  with no accepted run in flight cannot clear it.
- A new model-unavailable failure invalidates any pending health proof before
  its own silent status read, so a proof armed by an earlier run can never clear
  a failure observed now. A recognition failure that arrives while a repair is
  already running also invalidates that run's proof, so its completion no longer
  clears the attention; only an `ok: true` Verify, or a later accepted run whose
  completion reads healthy, does (conservative on purpose).

Those React transitions are covered by the browser flow below, not by Vitest.

**Browser flow evidence (temporary, not committed).** A local Playwright script
drives `pnpm dev` in Chromium against a real sidecar and a dummy catalog; it
never downloads the real models and never contacts Hugging Face:

- A temp model root is paired with a **dummy catalog** injected through
  `CHEMISTRY_MODEL_CATALOG` (the support override, never set by a release
  build). The catalog declares the four artifacts (classifier, encoder, decoder
  step and vocabulary) with a few KiB of dummy bytes, sizes and SHA-256 values
  computed by the script, and URLs pointing at a loopback HTTP server.
- The sidecar runs against that root on `127.0.0.1:9321` (the browser's
  `resolveApiBase` fallback) and the Vite dev server is driven by Chromium. No
  Tauri build is involved: the setup dialog uses only `fetch`.
- The dummy artifacts are not executable ONNX graphs, so the flow asserts the
  capability and control state, never inference. Real inference stays
  model-gated in the backend suite (§5).

Assertions actually run:

1. With a fresh root, the `Models` dialog opens automatically after the editor,
   the `Models` control is visible in the toolbar, and the dialog shows both
   families, per-model sizes and the dummy total. It renders no **Licenses and
   source** block, no `huggingface.co` URL and no repeated license paragraph;
   no download request has been made.
2. **Later** closes the dialog; the `Models` control (still visible because the
   install is not ready) reopens it; opening the Ketcher Open dialog shows the
   image-recognition entry disabled while `/v2/info` advertises `[]`.
3. Tagging the `.Ketcher-root` element and drawing a structure with Ketcher's
   bond tool, then clicking **Download**, shows progress and ends on the ready
   state. After the ready status the `Models` control is gone from the toolbar,
   while the open dialog stays until **Later**. The same DOM node is still
   present, the rendered structure SVG is unchanged,
   `window.currentState.editor.historySize()` is unchanged and
   `window.currentState.editor.undo()` steps the canvas back through the
   pre-download history, proving the in-place option-store update did not
   remount the editor or reset the undo stack. The recognition entry is now
   enabled and `/v2/info` advertises the capability. No request targets
   `huggingface.co`, and `page.on("dialog")` records no browser alert.
4. **Verify → Repair → ready**: a same-size corrupt artifact in the temp root
   makes Verify report the file and the primary action become **Repair**; the
   `Models` control is visible again while the report is `ok: false`. Choosing
   **Later** and reopening from **Models** still shows **Repair** with the
   control visible (the report is kept across a dialog close); closing again
   leaves the control visible. Repair runs, ends ready, the primary action
   returns to **Verify** (regression for a stale verify report) and the control
   is hidden again. The selective refetch of only the bad artifact stays a
   sidecar-suite assertion (§5).
5. **Recognition-unavailable attention**: before the failure the flow re-asserts
   that the `Models` control is hidden (the install is healthy). On the ready
   install the dummy artifacts are not loadable ONNX graphs, so `/v2/info`
   advertises the ids but a Recognize attempt ends `FAILURE` with the
   model-unavailable message. After dismissing the in-app `ErrorDialog`, the
   `Models` control is visible even though the status is ready, and clicking it
   opens the dialog; the dialog shows **Models ready** with the muted attention
   note (a recognition attempt reported the models unavailable; Verify checks
   the files). A Repair request forced to fail with HTTP `500` shows the
   in-dialog error and leaves the control visible after **Later** and reopen.
   The real Repair (its artifact server delayed) then shows **Repair**, keeps
   the control visible while `downloading`, and hides it only after the run
   completes healthy (the status read clears the attention override); the note
   is not rendered during the run because the dialog cannot offer Verify, and it
   disappears with the override. After a second recognition failure (past the
   5 s error dedupe) the flow fabricates an accepted `202` whose body still
   reports `downloading` (the request is not forwarded, so no run starts) and
   keeps answering the following status polls with `downloading` for ~2.5 s:
   across at least two polls the control stays visible, the dialog stays on
   **Downloading** and the attention note stays absent; when the polls then read
   the healthy install the control hides again. The flow then runs the
   **close-during-repair** regression: after another recognition failure re-arms
   the attention it starts a real Repair, **Later** closes the dialog before any
   poll sees progress, the run
   completes with no status read, and a fresh recognition failure (past the
   dedupe) must leave the control visible and the note present after its silent
   refresh settles — a pending proof from the earlier run may not clear a
   failure observed now. A subsequent **Verify** reads `ok: true` and hides the
   note and the control, the other clear path.
6. A closed-port catalog (error state): the `Models` control is visible (the
   status is not ready), the error is rendered in the dialog's `role="alert"`
   region with **Retry**, and no native alert fires.
7. Dialog layout at 1280x800 and at the 900x600 minimum, in the normal and
   error states: the panel is inside the viewport and the action row is
   visible.

Not covered by that flow: the **Cancel/Resume** and **Update** UI paths. Their
labels and precedence are unit-tested through `setupView`, the Update visibility
through `modelsControlVisible`, their backend semantics (`.part` resume, `409`
during verify, catalog comparison) are covered by the sidecar suite (§5), and
the click-through stays in `docs/verification.md` §2. Selection retention after
the capability update is also manual; the flow checks the structure and the undo
stack only.

The real Hugging Face download (~324 MB) is the gated/manual smoke in §5, not
this flow. The temporary browser flow needs a browser and a sidecar process, so
the Vitest harness block stays the unit gate and the activity runs the flow
explicitly.

The same flow covers the **clean-root** variant with a fresh profile and the
dummy catalog: the Models dialog auto-opens once, **Later** leaves the editor
usable, reopening from **Models** shows the same state, and the dummy download
ends ready and enables the capability. It proves the clean-root state machine
only; the packaged app, the real Hugging Face download and the app-data path are
the manual checks in `docs/verification.md` §2 "Clean install (B3)", and no
committed e2e suite is added.

### 6.3 Manual checklist

The real flows cannot be unit-tested without a WebView and a filesystem, so
`docs/verification.md` §2 is mandatory: "Documents, autosave and recovery"
(Save, Save As, each Export format, crash simulation, the recovery
Restore/Discard prompt, all close-guard paths), "Toolbar integration" (the four
custom buttons, the conditional Models control, the hidden native Save As entry,
the shortcuts and the browser fallback), "Model setup UI" (the Models control
visible on a clean root, hidden after ready and back on update/repair,
auto-open/Later, download/progress/ready, cancel, retry, verify/repair, the
Verify-fail → Repair → ready reset, the dialog without a license/source block,
the dialog at 1280x800 and 900x600, and the capability update without canvas
loss),
"Recognize Molecule end to end" (the in-app `ErrorDialog` for recognition
failures with no native alert) and "Clean install (B3)" (the payload absence
greps, the packaged sidecar on an empty root through the real
download/verify/filter/OCSR smoke, and the packaged app's clean app-data Models
flow).

### 6.4 Model parity harness (Phase D)

The Phase D pilot (`docs/benchmarks/model-parity.md`) has two layers. The
**pure metric layer** is unit-tested in Node; the **benchmark run** is manual
and gated, because it needs the external datasets, the toolchain and the
installed models.

| Layer             | Files                                                               | How it runs                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure metric layer | `scripts/lib/model-parity.mjs`, `scripts/lib/model-parity.test.mjs` | `node --test scripts/lib/model-parity.test.mjs`; `scripts/harness.mjs` block 3 auto-discovers every `scripts/lib/*.test.mjs` (7 files, 143 tests; 51 in this file)     |
| RDKit comparator  | `scripts/lib/ocsr-match.py`                                         | Called by the runner with `$TOOLCHAIN/.venv/bin/python`; reads JSONL `{id, expected, got}` and writes `exact`/`canonical`/`valid`/`incomparable` plus canonical SMILES |
| Runner            | `scripts/model-parity.mjs`                                          | Manual, with `$TOOLCHAIN`, `CHEMISTRY_MODELS_DIR` and `ORT_DYLIB_PATH`; documented in `docs/verification.md` §2 "Model parity pilot (Phase D)"                         |

The unit tests use synthetic fixtures only: no dataset, no model, no sidecar,
no network. They pin these rules:

- **Label mapping:** `one_molecule` and `several_molecules` → `structure`;
  `other` → `no-structure`; `reactions` is excluded from the binary metric and
  reported separately. An unknown category is rejected, not silently mapped.
- **Binary metric:** accuracy is `(TP + TN) / n` over the non-reaction rows
  only; TP/FN/FP/TN follow the documented row order; a reaction row never
  enters the denominator. A fixture with TP 87, FN 62, FP 0, TN 79 (166/228)
  pins the binary function used for the reference derivation.
- **OCSR metric:** `exact_match` is raw string equality over all 300 rows;
  `canonical_match` is RDKit canonical equality over comparable pairs only (a
  `422`/incomplete has no returned SMILES and is not comparable); a `422`
  still counts as invalid and as an exact failure. `valid` mirrors the
  toolchain heuristic (an answer exists, not an RDKit parse check);
  `incomparable` covers both missing answers and either side failing to parse.
  An invalid (`422`/incomplete) row carrying a boolean canonical result is
  rejected, so it cannot enter the comparable denominator.
- **Percentiles:** nearest-rank on the sorted latencies, index
  `ceil(p * n) - 1`; p50/p95 for small fixtures and for `n = 300` (indices 149
  and 284).
- **Reference derivation:** filtering the toolchain eval details by frozen pilot
  IDs keeps 300 rows, recomputes the same binary aggregate, and rejects a
  duplicate or missing ID.
- **Threshold direction:** `score <= 0.000089` is `structure`; the boundary
  value and values a small step above/below are asserted (the test STEP is
  16,384 ULPs at `0.000089`).
- **Sidecar default:** the runner defaults to `target/release/indigo-server`
  (the shipped build) and never to `target/debug`; `--sidecar` stays the
  override. A debug-build latency must not be reported as the app result.

**Mutation rule.** Each of these must fail a test: including `reactions` in
the binary denominator, flipping `structure`/`no-structure`, counting a
reaction as `no-structure`, using 300 instead of the comparable-pair count for
canonical accuracy, counting an incomplete/`422` as valid or as comparable,
letting an invalid row carry a canonical result, replacing nearest-rank with the
mean or an off-by-one index, computing accuracy over all 300 instead of the
binary `n`, treating `score < 0.000089` as `structure`, or accepting a
duplicate/missing pilot ID. A metric change that no unit test catches is a
review finding.

The benchmark run itself is not CI: it is the gated manual procedure in
`docs/verification.md` §2, and its raw output stays under `build/benchmarks/`.
The committed report is `docs/benchmarks/model-parity.md` §4; unit tests never
read the external datasets. The reference-shaped fixtures (166/228, 210/292,
121/300, 299/300) pin the metric function, not the benchmark result.

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

# Recognize compatibility job protocol (no model needed)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server tests::recognition

# Model catalog/downloader (loopback HTTP + dummy artifacts, no real network)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server tests::model_delivery
```
