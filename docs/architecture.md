# Architecture

> What "good work" means in this project.

## Delivery order

Changes land as **docs → test → implement → review**: documentation defines the
contract, a failing test proves the gap, the minimal implementation closes it,
and the reviewer verifies the result. `node scripts/harness.mjs` enforces the
task phases declared in `activities.json` (docs-only activities run
docs → review).

---

## 1. Project Overview

Chemistry Draw is an **offline-first desktop chemical structure editor**: a
[Tauri v2](https://v2.tauri.app/) shell around the [Ketcher](https://github.com/epam/ketcher)
React editor (Apache 2.0, EPAM Systems).

Instead of Ketcher's WASM backend, the app ships a **native REST sidecar** that
implements the Indigo v2 HTTP API on top of EPAM's C++ libraries. This is a
community packaging: it is not an official EPAM product.

| Piece             | Technology                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Desktop shell     | Tauri v2 (Rust)                                                                               |
| Frontend          | React 18 + TypeScript + Vite                                                                  |
| Editor            | `ketcher-react` / `ketcher-core` 3.18.x (patched, see §10)                                    |
| Chemistry backend | `indigo-server` sidecar: Rust + axum                                                          |
| Native chemistry  | `libindigo`, `libindigo-renderer` (FFI)                                                       |
| Image inference   | ONNX Runtime 1.31.0 (shipped) via `ort` 2.0.0-rc.15 (dynamic, CPU, DECIMER classifier + OCSR) |
| Packaging         | Linux: Docker builder → `.deb`, `.rpm`, AppImage; Windows: NSIS                               |

---

## 2. Process and data flow

```text
┌──────────────────────────── WebView ────────────────────────────┐
│  React + Ketcher                                                │
│  App.tsx → resolveApiBase() → RemoteStructServiceProvider       │
│  logging.ts → console/errors forwarded to the host log          │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTP 127.0.0.1:<port>/v2/*
┌─────────────────────────────▼───────────────────────────────────┐
│  indigo-server (axum, spawned and supervised by the Tauri host)  │
│  transport/ → service/ → ffi/                                    │
│  transport/filter → service/ml/ → ONNX Runtime (CPU)             │
└───────────────────────────────┬──────────────────────────────────┘
                                │ FFI
┌───────────────────────────────▼──────────────────────────────────┐
│ libindigo / libindigo-renderer                                   │
└──────────────────────────────────────────────────────────────────┘
```

The sidecar links Indigo and Indigo Renderer on every platform. It ships no
Imago backend: no Imago library, worker binary or native dependency, and
`/v2/health` has no Imago fields. Ketcher's built-in **Recognize Molecule**
control, however, hardcodes the Imago job protocol: `POST
{apiPath}imago/uploads` followed by `GET {apiPath}imago/uploads/:id`. The
sidecar registers that pair as a **compatibility shim**: the route name is
Ketcher's, the pipeline behind it is the local filter + OCSR + Indigo path, and
the real Imago library never runs. `/v2/info` advertises one synthetic
`imago_versions` entry (`local-ocsr`) because Ketcher disables the control when
the list is empty; it is capability advertisement, not an Imago build.

Phase B1 adds an ONNX Runtime classifier (`POST /v2/filter/classify`) that
decides whether an image contains a chemical structure. Phase B2 adds OCSR
inference (image → SMILES) through `POST /v2/ocsr/recognize`, the contract
activity 8 defines. Activity 9 (`phase-b2-recognize-e2e`) wires them end to end
— filter gate → OCSR → SMILES → V2000 molfile through Indigo — behind the
`imago/uploads` job protocol and re-enables the **Recognize Molecule** UI. The
flow is implemented; section 6 is its contract.

The inference paths are HTTP → `transport/{filter,ocsr}.rs` → `service/ml/` →
ONNX Runtime (CPU). They do not touch Indigo. The compatibility path is the one
exception: `transport/imago.rs` → `service/recognition.rs` runs the two ML
stages and then converts the SMILES through `ffi/` Indigo, because Ketcher needs
a molfile, not a SMILES. `/v2/info` keeps the fields Ketcher parses (plus the
synthetic capability list above); the inference diagnostics live only in
`/v2/health`.

The Tauri host (`src-tauri/src/lib.rs`) does **no chemistry**: it picks a free
port, spawns `indigo-server`, tracks the port it reports, forwards its logs and
kills it on exit (plus a stdin-EOF watchdog inside the sidecar for crashes).

---

## 3. Layering (one-way dependency)

Dependencies point one way only:

```text
frontend (src/)  →  HTTP  →  transport/  →  service/  →  ffi/
```

| Layer                 | Responsibility                                        | May not                 |
| --------------------- | ----------------------------------------------------- | ----------------------- |
| `src/`                | UI, Ketcher integration, API base resolution, logging | call native libs        |
| `src-tauri/src/`      | App lifecycle: port, sidecar spawn/kill, commands     | contain cheminformatics |
| `sidecar/transport/`  | HTTP parsing, status codes, JSON                      | call `ffi::` directly   |
| `sidecar/service/`    | Orchestration and domain errors                       | know about HTTP         |
| `sidecar/service/ml/` | ONNX sessions, model registry, preprocessing          | know about HTTP         |
| `sidecar/ffi/`        | `extern "C"` bindings, session handling               | know about HTTP         |

Pattern rules:

- A handler returns `Result<Json<_>, AppError>`; it never builds error bodies
  by hand (`error.rs` maps variants to status codes).
- Business logic lives in `service/`, not in handlers.
- All native calls go through `ffi/`; no `unsafe` FFI elsewhere.
- ML inference lives in `service/ml/`; handlers only validate the body, enforce
  the size cap and map errors.
- The host never links the chemistry libraries.

---

## 4. Frontend integration

- `src/App.tsx` resolves the API base by polling `GET /v2/info` until the
  sidecar answers (it starts asynchronously), using the port reported by the
  `indigo_port` command.
- Ketcher is mounted through `RemoteStructServiceProvider` pointing at
  `http://127.0.0.1:<port>/v2/`.
- `src/logging.ts` transparently mirrors `console.*`, uncaught errors and
  unhandled rejections into the Tauri log. It is a no-op outside Tauri.
- **Recognize Molecule** is Ketcher's built-in "Import Structure from Image"
  dialog. `App.tsx` removes the `hidden` button option and the sidecar
  advertises the synthetic `imago_versions` capability; Ketcher POSTs the
  image and polls the compatibility job. Failures reach `errorHandler` as JSON
  text; `App.tsx` maps them to friendly dialogs.
- Hash/`file-saver` shims exist for the webview; do not add Node-only APIs.

---

## 5. Sidecar API surface

| Method | Path                                                                | Backend                               |
| ------ | ------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/v2/info`                                                          | versions + `api_path` (real port)     |
| GET    | `/v2/health`                                                        | diagnostics for bug reports           |
| GET    | `/v2/indigo/info`                                                   | alias of `/v2/info`                   |
| POST   | `/v2/indigo/convert`, `aromatize`, `dearomatize`, `layout`, `clean` | Indigo                                |
| POST   | `/v2/indigo/render`                                                 | Indigo Renderer                       |
| POST   | `/v2/indigo/calculate`, `check`, `calculate_cip`, `automap`         | Indigo                                |
| POST   | `/v2/filter/classify`                                               | ONNX Runtime classifier               |
| POST   | `/v2/ocsr/recognize`                                                | ONNX Runtime OCSR (encoder + decoder) |
| POST   | `/v2/imago/uploads`                                                 | compatibility shim (filter + OCSR)    |
| GET    | `/v2/imago/uploads/{id}`                                            | in-memory recognition job store       |

Errors are `AppError` → `{ "error": "..." }`: 400 invalid input (including an
undecodable or unsupported image), 404 unknown id (including an unknown,
expired or restarted recognition job), 413 payload over the 10 MiB cap, 422
incomplete OCSR decoding (the decoder did not finish the structure), 500
backend failure, 503 model unavailable (missing, checksum mismatch or contract
mismatch). The `413` is the exception to the JSON shape: it comes from axum's
`DefaultBodyLimit`, whose body is plain text, not `{ "error": ... }`.
`/v2/info` exposes Indigo versions plus the synthetic `imago_versions`
capability list (the rest of its payload is unchanged); `/v2/health` adds the
targeted ONNX Runtime API generation and
the model ids whose artifacts are present on disk. The `/v2/imago/uploads`
pair is a compatibility shim for Ketcher's built-in job protocol, not an Imago
backend: the implementation is the local filter → OCSR → Indigo pipeline, no
Imago library or worker ships, and `/v2/health` exposes no Imago fields. The
only Imago-looking field is the synthetic capability list, which Ketcher needs
to enable its Recognize control.

---

## 6. ONNX inference foundation

Phase B replaces Imago with a two-model pipeline: a **filter** (does the image
contain a chemical structure?) and an **OCSR** model (image → SMILES). B1
delivers the runtime foundation, the filter and the shipped ONNX Runtime. B2
adds OCSR inference: one hand-drawn model, a separate preprocessing pipeline
and `POST /v2/ocsr/recognize`. Activity 9 (`phase-b2-recognize-e2e`) adds the
implemented filter gate, the Ketcher-compatible job adapter and the re-enabled
Recognize UI on top of it; model download (B3) stays out of scope.

### Runtime

- Rust binding: `ort` **2.0.0-rc.15** (pykeio), pinned, built with
  `default-features = false` and features `std`, `api-31`, `load-dynamic`.
- `libonnxruntime` is **loaded dynamically at runtime**: the sidecar has no
  link-time dependency on it. The path comes from `ORT_DYLIB_PATH`; when unset,
  the bare platform name (`libonnxruntime.so` / `onnxruntime.dll`) is passed to
  the loader, so `LD_LIBRARY_PATH` / `PATH` applies. Activity 7
  (`ship-onnx-runtime`) also **ships** the pinned library with Linux and Windows
  packages (§7); a failed load stays an actionable error (HTTP 503), never a
  panic.
- Developer setup: `scripts/fetch-onnxruntime.sh` downloads the pinned ONNX
  Runtime **1.31.0** Linux x86_64 shared build, verifies its SHA-256 and
  extracts only `lib/libonnxruntime.so*` into the gitignored
  `.ort/linux-x86_64/`, preserving the `libonnxruntime.so` ->
  `libonnxruntime.so.1` -> `libonnxruntime.so.1.31.0` chain. It is idempotent,
  fails with a clear message on other platforms, and never downloads models.
  The pinned URL and checksum live in the script.
- Host resolution: `src-tauri/src/lib.rs` sets `ORT_DYLIB_PATH` on the sidecar
  and logs the resolved path. Debug prefers the `.ort/<platform>/` developer
  override and falls back to the bundled `lib/<platform>/`; release always uses
  the bundled library. If neither exists, the sidecar keeps serving Indigo and
  the classifier returns `503`.
- Execution provider: **CPU only**, one intra-op thread, telemetry disabled. No
  GPU providers.
- Sessions are created lazily on first use and cached for the process lifetime,
  so the sidecar starts — and keeps serving Indigo — with no models and no
  runtime installed.

### Model directory and manifest

Models are never bundled with the app and never committed. The contract
delivered by activity 5 (`model-root-resolution`) resolves the model root in
this order (first match wins):

1. `CHEMISTRY_MODELS_DIR` when set — absolute or relative, used as-is and never
   rewritten.
2. An existing `<repo>/models`, the compile-time candidate derived from the
   sidecar crate location (gitignored).
3. `models` in the sidecar's working directory.

In development the Tauri host passes `<repo>/models` as an **absolute**
`CHEMISTRY_MODELS_DIR` to the sidecar, so `task run` and `pnpm tauri dev` find
the model store without a manual export and the startup log names the absolute
root. Release delivery (the host providing a downloaded model root) remains
Phase B3 and is not implemented yet.

```text
models/
  manifest.json
  image-classifier-fp16/
    classifier.fp16.onnx
  ocsr-handdrawn-fp32/
    encoder.onnx
    decoder_step.onnx
    vocab.json
```

`manifest.json` is the source of truth for each model: artifact paths,
SHA-256 checksums, provenance id and the exact tensor contracts. Loading checks
each file checksum, then validates input/output names, shapes and dtype against
the graph. A missing file, checksum mismatch or contract mismatch is a
configuration error (HTTP 503), never a silent fallback.

The classifier entry keeps the single-artifact schema-1 shape below. The OCSR
entry is a second key in the same `models` map; it declares two graphs and a
vocabulary, so it is described separately in the OCSR subsection. Adding it
does not change the classifier entry or the schema version.

```json
{
  "schema": 1,
  "models": {
    "image-classifier": {
      "id": "image-classifier@Iagea/d21f4cb",
      "file": "image-classifier-fp16/classifier.fp16.onnx",
      "artifact_sha256": "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9",
      "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
      "license": "MIT",
      "threshold": 0.000089,
      "preprocessing": "runtime_default",
      "inputs": [
        { "name": "input_2", "dtype": "float32", "shape": [1, 224, 224, 3] },
        { "name": "45214:0", "dtype": "float32", "shape": [1, 1, 1, 3] },
        { "name": "45216:0", "dtype": "float32", "shape": [1, 1, 1, 3] }
      ],
      "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 1] }
    }
  }
}
```

### Classifier tensor contract

Artifact `image-classifier-fp16/classifier.fp16.onnx`, provenance
`image-classifier@Iagea/d21f4cb`.

| Tensor       | Direction | dtype   | Shape              | Content            |
| ------------ | --------- | ------- | ------------------ | ------------------ |
| `input_2`    | input     | float32 | `[1, 224, 224, 3]` | preprocessed image |
| `45214:0`    | input     | float32 | `[1, 1, 1, 3]`     | zeros (auxiliary)  |
| `45216:0`    | input     | float32 | `[1, 1, 1, 3]`     | zeros (auxiliary)  |
| `Identity:0` | output    | float32 | `[1, 1]`           | one logit          |

The exported graph declares a **dynamic batch dimension** (`-1`); the manifest
and this contract use batch `1`, which is what the app always feeds. Contract
validation treats `-1` as dynamic and requires every other dimension to match
exactly.

Post-processing: `score = sigmoid(logit)`; the image is `structure` when
`score <= 0.000089`, otherwise `no-structure`. The direction is deliberate: a
**low** score means structure. The model is binary and emits nothing else.

Identity:

- artifact sha256 `d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9`;
- upstream checkpoint sha256
  `1f1f192e3a63c8985f20d8a0777a558458ef829379e5373fdad25bc0b4161978` — provenance
  only, **not** the file hash;
- license: MIT (Iagea/DECIMER-Image-Classifier), see `NOTICE`.

### Preprocessing (`runtime_default`, must not drift)

1. Composite RGBA on a white background.
2. Convert to grayscale, then back to 3-channel RGB.
3. Aspect-preserving LANCZOS resize so the longest side is 224.
4. Paste centered on a white 224×224 canvas.
5. Feed float32 values in `0..255`, NHWC (`[1, 224, 224, 3]`).

The two auxiliary inputs are fed zeros. Decoding is bounded before any pixels
are materialized: images wider or taller than **12,000 px** or needing more than
**128 MiB** of decoder allocations are rejected with `400`, exactly like
undecodable bytes. Invariants, measured in the integration report and not
negotiable without new evidence:

- **Never auto-invert** scans or photos: hand-drawn OCSR fell to 0/289 canonical
  and the classifier lost 14.85 pp where it was measured.
- **Never histogram-equalize**: the classifier lost 14.19 pp.
- **No sharpening or autocontrast in the default path**: the winners flip by
  domain (printed vs hand-drawn), so no transfer is assumed.

Any preprocessing change requires a measured delta on the frozen evaluation
before it ships; "looks cleaner" is not evidence.

### Known limitation: the classifier is binary only

The model separates `structure` from `no-structure`; it cannot tell one molecule
from several, and it does not detect reactions. In the frozen evaluation, 146 of
250 `several_molecules` images (~58%) were classified `no-structure`, and those
146 account for 146 of the 174 false negatives. The classifier runs without a
confidence gate: its AUC is 0.603 and the dominant error is systematically
confident, so a gate would not recover it. The B2 UX must not promise
multi-molecule or reaction handling, and "no structure" is not proof that no
structure exists.

Measured latency on CPU in the toolchain report: p50 **49 ms**, p95 **206 ms**.

### Endpoint

`POST /v2/filter/classify`

- Body: raw image bytes with `Content-Type: image/png`, `image/jpeg` or
  `image/webp`. No multipart, no base64, no job id.
- Limit: 10 MiB (10,485,760 bytes). Bodies of exactly 10,485,760 bytes are
  decoded; larger bodies get `413`. That `413` comes from axum's
  `DefaultBodyLimit` and its body is plain text, not `{ "error": ... }`.
- `200` response:

```json
{
  "contains_molecule": true,
  "category": "structure",
  "score": 0.0000042,
  "threshold": 0.000089,
  "logit": -12.38,
  "model": "image-classifier@Iagea/d21f4cb"
}
```

`category` is `structure` when `contains_molecule` is `true` and `no-structure`
otherwise. `score` is `sigmoid(logit)` and `threshold` is `0.000089`, echoed so
clients do not hardcode it.

- Errors: `400` undecodable or unsupported image (including over-limit
  dimensions or decoder allocations), `413` payload over 10 MiB, `503` model
  unavailable (missing, checksum mismatch or contract mismatch).

### OCSR inference contract (Phase B2)

> **Status:** activity 8 (`phase-b2-ocsr-inference`) delivered this contract.
> Activity 9 (`phase-b2-recognize-e2e`) consumes it from the filter-gated
> pipeline and the Ketcher `imago/uploads` adapter described below. The
> endpoint itself stays a single-image API and does not gate on confidence.

**Model choice.** Phase B2 pins **one** OCSR model and **no router**:
`ocsr-handdrawn-fp32`, provenance `ocsr-handdrawn@zenodo:10781330`. The DECIMER
v2 hand-drawn FP32 export is the single-model compromise for a drawing app:

| Evaluation set       | Hand-drawn FP32 (chosen) | Printed model |
| -------------------- | ------------------------ | ------------- |
| Hand-drawn canonical | **0.7300 (711/974)**     | 0.677         |
| Printed canonical    | 0.694                    | **0.704**     |

The hand-drawn model gives up only **1.0 pp** on printed images, while the
printed model loses **5.3 pp** on hand-drawn input. One model therefore serves
every filter-approved image; a per-style router or ensemble would add a second
failure mode without a measured win. CPU latency measured in the integration
report is p50 **1115 ms**, p95 **2156 ms**.

Artifacts are downloaded from
`spalax-dev/chemistry-draw-ocsr` into `models/ocsr-handdrawn-fp32/`, are
licensed **CC-BY-4.0** (Zenodo record 10781330, see `NOTICE`), and are never
bundled or committed. The encoder + decoder pair is 315,818,957 bytes
(~301 MiB):

| Artifact            | Bytes       | SHA-256                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `encoder.onnx`      | 208,801,677 | `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52` |
| `decoder_step.onnx` | 107,017,280 | `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197` |
| `vocab.json`        | 5,316       | `62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd` |

The vocabulary hash is not derived from the graph export: the manifest records
the SHA-256 of the downloaded `vocab.json`, so a corrupted, truncated or
substituted vocabulary is rejected exactly like a bad graph file.

**Manifest extension.** The OCSR model is a second key in the existing `models`
map. Schema 1 and the `image-classifier` entry are unchanged; the new entry uses
the same `file`/`artifact_sha256` spelling per artifact:

```json
"ocsr-handdrawn": {
  "id": "ocsr-handdrawn@zenodo:10781330",
  "source": "https://huggingface.co/spalax-dev/chemistry-draw-ocsr",
  "license": "CC-BY-4.0",
  "preprocessing": "decimer_ocsr",
  "start_id": 13,
  "end_id": 14,
  "max_len": 302,
  "confidence_threshold": 0.901,
  "encoder": {
    "file": "ocsr-handdrawn-fp32/encoder.onnx",
    "artifact_sha256": "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
    "inputs": [
      { "name": "image", "dtype": "float32", "shape": [1, 512, 512, 3] }
    ],
    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, 256, 512] }
  },
  "decoder": {
    "file": "ocsr-handdrawn-fp32/decoder_step.onnx",
    "artifact_sha256": "cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197",
    "inputs": [
      { "name": "tokens", "dtype": "int32", "shape": [1, -1] },
      { "name": "enc_out", "dtype": "float32", "shape": [1, 256, 512] }
    ],
    "zero_inputs": [],
    "output": { "name": "Identity:0", "dtype": "float32", "shape": [1, -1, 156] }
  },
  "vocab": {
    "file": "ocsr-handdrawn-fp32/vocab.json",
    "artifact_sha256": "62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd"
  }
}
```

`-1` marks a dynamic graph axis. For OCSR it is the decode-sequence axis of the
decoder (`tokens` axis 1 and `Identity:0` axis 1); batch may also be dynamic
`-1` as for the classifier. Every non-dynamic dimension must match exactly.
The hand-drawn export has **no additional graph inputs**: the `217602:0` and
`217606:0` names are baked initializers, so `zero_inputs` is `[]`. The printed
export is the one that exposes them as inputs. The loader still supports extra
graph inputs for other exports: every name in `zero_inputs` must be an input of
the graph, and each is fed an all-zero tensor with the dtype and shape the graph
declares. A graph input that is neither one of the declared inputs nor listed in
`zero_inputs` is a contract error (503), and the entry is not used.

Loading is per model family and lazy: the first `/v2/ocsr/recognize` request
verifies the three checksums, validates both graphs and creates the two
sessions; the pair is cached for the process lifetime. Startup, `/v2/health`
and `/v2/filter/classify` never open the OCSR graphs, so the ~316 MB pair does
not slow them.

**Tensor contract.** Encoder artifact
`ocsr-handdrawn-fp32/encoder.onnx`:

| Tensor       | Direction | dtype   | Shape              | Content                      |
| ------------ | --------- | ------- | ------------------ | ---------------------------- |
| `image`      | input     | float32 | `[1, 512, 512, 3]` | `decimer_ocsr` image, NHWC   |
| `Identity:0` | output    | float32 | `[1, 256, 512]`    | encoder features (`enc_out`) |

Decoder-step artifact `ocsr-handdrawn-fp32/decoder_step.onnx`:

| Tensor       | Direction | dtype   | Shape           | Content                             |
| ------------ | --------- | ------- | --------------- | ----------------------------------- |
| `tokens`     | input     | int32   | `[1, seq]`      | start id plus generated ids         |
| `enc_out`    | input     | float32 | `[1, 256, 512]` | encoder output, fed unchanged       |
| `Identity:0` | output    | float32 | `[1, seq, 156]` | next-token probabilities, softmaxed |

Other exports may expose additional auxiliary inputs; those are listed in
`zero_inputs` and fed zeros. The hand-drawn export stubs only the three tensors
above.

The decoder output is **already softmaxed**: values are probabilities, `argmax`
is taken directly, and softmax is never applied again. The vocabulary size is
156 (output axis 2).

**Greedy decode and tokenizer.** One encoder run produces `enc_out`; the
decoder then runs once per emitted token:

1. Seed the token sequence with `[start_id]`, `start_id = 13`.
2. Feed the full sequence as `tokens` int32 `[1, seq]` plus `enc_out` and the
   zero inputs.
3. Take the last position's `[156]` probability row, choose its `argmax` and
   append the id; the chosen value is that step's probability.
4. Stop after appending `end_id = 14`, or after at most `max_len = 302` decoding
   steps.
5. `incomplete` is `true` when the loop stopped at `max_len` and the last id is
   not `end_id`; otherwise it is `false`.

`confidence` is the arithmetic mean of the chosen-token probabilities over the
steps, including the final `end_id` step. `/v2/ocsr/recognize` does **not**
gate on it: a complete low-confidence decode is still a `200` with the value.
The in-domain hand-drawn threshold measured in the integration report is
**0.901** and the manifest records it as `confidence_threshold`. The
Recognize Molecule compatibility flow (below) enforces that gate, but the value
is provisional and must be recalibrated on real inputs before it is treated as
final.

Detokenization uses the two maps in `vocab.json`, `id_to_token` and
`token_to_id`. Ids `0` (pad), `13` (start) and `14` (end) are skipped; `end_id`
terminates the string. DECIMER's digit remap is applied **after** token lookup:
`! $ ^ < > ? £ ¢ € §` become `1 2 3 4 5 6 7 8 9 0`. The remap changes the SMILES
text only; it never changes token ids.

The loader also checks the vocabulary against the manifest before opening any
session: `vocab.start_id` and `vocab.end_id` must equal the manifest values, and
`vocab.vocab_size` must equal the decoder output's class axis (`156`). A
disagreement is a configuration error (`503`), not a decode-time surprise.

**Preprocessing (`decimer_ocsr`, must not drift).** This is a separate pipeline
from `runtime_default`; the classifier path is unchanged. It is a port of the
toolchain's `runtime/preprocess.py`, and the order is the contract:

1. Open the image as RGBA and composite it on white.
2. Contrast stretch: build a LUT mapping the current per-image minimum..maximum
   (across all channels) to `0..255`, then apply it.
3. BGR2GRAY quirk on the RGB array: `gray = 0.114*R + 0.587*G + 0.299*B` — the
   OpenCV BGR weights applied **without** swapping the channels. Clip to
   `0..255`, convert to mode `L`, then apply PIL `ImageEnhance.Contrast(1.8)`.
4. Resize rules, in this order: a square image with side `< 512` becomes
   `512×512`; if either side is `>= 512` it is not resized; otherwise both sides
   are scaled by `512 / max(w, h)` with `int()` truncation and LANCZOS.
5. Crop empty borders: pixels `> 200` are background; crop to the bounding box
   of pixels `<= 200`; if every pixel is background, keep the image unchanged.
6. Central square: `side = max(512, int(1.2 * max(w, h)))`, white canvas, paste
   centered. A canvas over `8,192` px per side is rejected as an extreme aspect
   ratio (`400`) before the allocation, so a pathological but under-cap image
   cannot balloon into a many-hundred-megabyte canvas.
7. Brightness ×1.6 (PIL `ImageEnhance.Brightness` semantics, clipped).
8. Resize to exactly `512×512` with LANCZOS, RGB, float32.
9. Convert to `0..1`, normalize per channel with ImageNet mean
   `[0.485, 0.456, 0.406]` and std `[0.229, 0.224, 0.225]`, and emit NHWC
   float32 `[1, 512, 512, 3]`.

Decoding is bounded by the same `12,000 px` per side and `128 MiB` of decoder
allocations as the classifier; over-limit input is `400`. The central canvas is
additionally capped at `8,192 px` per side after the border crop (an extreme
aspect ratio is `400`), so the intermediate allocation stays bounded. As with
`runtime_default`, any change to this pipeline requires a measured delta on the
frozen evaluation.

**Endpoint.** `POST /v2/ocsr/recognize`

- Body: raw image bytes with `Content-Type: image/png`, `image/jpeg` or
  `image/webp`. No multipart, no base64, no job id.
- Limit: 10 MiB (10,485,760 bytes), inclusive. Larger bodies get `413` from
  axum's `DefaultBodyLimit`; that body is plain text, not `{ "error": ... }`.
- The handler validates the media type and decodes the image **before**
  resolving the model, so malformed input is `400` even without a model; a
  well-formed image without a usable model is `503`.
- `200` response:

```json
{
  "smiles": "CCO",
  "confidence": 0.93,
  "incomplete": false,
  "model": "ocsr-handdrawn@zenodo:10781330"
}
```

`smiles` is the detokenized, digit-remapped string; `confidence` is the mean
chosen-token probability; `incomplete` is `false` on success; `model` is the
manifest provenance id.

- `422` when decoding is incomplete (`incomplete: true`): the image decoded and
  the model ran, but the decoder reached `max_len = 302` without `end_id`. The
  body is the standard error envelope with an actionable message:

```json
{ "error": "could not finish the structure; try a sharper image" }
```

A truncated SMILES is **not** returned: an unfinished structure is not a
result. `AppError::Unprocessable` maps this variant to `422`.

- Errors: `400` undecodable or unsupported image (including over-limit
  dimensions or decoder allocations), `413` payload over 10 MiB, `422`
  incomplete decode, `500` unexpected inference failure, `503` model or runtime
  unavailable (missing, checksum mismatch or contract mismatch).

This endpoint is stateless and returns the SMILES with its confidence. The
confidence gate, the filter and the molfile conversion belong to the
compatibility flow below; `/v2/ocsr/recognize` itself keeps returning `200` for
a complete low-confidence decode.

### Recognize Molecule compatibility flow (Phase B2)

> **Status:** implemented by activity 9 (`phase-b2-recognize-e2e`). This
> subsection describes the shipped contract and the tests that pin it.

**Why a shim.** Ketcher 3.18 hardcodes the Imago job protocol in
`RemoteStructService.recognize()`: `POST {apiPath}imago/uploads` with the image
blob, then `GET {apiPath}imago/uploads/:id` every 500 ms after a 300 ms
delay. The route name is Ketcher's, not ours. The sidecar implements the
protocol as a **compatibility shim** — same paths, same states, same
`metadata.mol_str` — backed by the local filter, OCSR and Indigo. No Imago library, worker, job format or native
dependency is involved, and the version query is accepted and ignored because
one local OCSR model serves every request. Patching Ketcher to call a new path
would be a second permanent fork; the shim keeps the Ketcher boundary at the
existing `parametrizeUrl` patch only.

**Ketcher protocol.**

1. `POST {apiPath}imago/uploads[?version=<v>]` with the raw image as the body
   and the blob's `Content-Type` (`application/octet-stream` is Ketcher's
   fallback). The shim accepts `image/png`, `image/jpeg` and `image/webp`; any
   other media type is `400`, and a body over 10 MiB (10,485,760 bytes) is
   `413` from axum's `DefaultBodyLimit` (plain text, not `{ "error": ... }`).
   The `version` query is ignored.
2. `200 { "upload_id": "<id>" }` — Ketcher reads `upload_id` from the body.
3. Ketcher waits **300 ms** before the first poll, then polls
   `GET {apiPath}imago/uploads/<id>` every **500 ms** until the job leaves
   `PENDING`; there is no fixed attempt limit. The bound on a stuck job is the
   sidecar's, not the client's (see the job store below).
4. `{ "state": "PENDING" }` keeps polling.
5. `{ "state": "SUCCESS", "metadata": { "mol_str": "<V2000 molfile>" } }` ends
   the poll; Ketcher parses `mol_str` and adds the structure to the canvas.
6. `{ "state": "FAILURE", "error": "<message>" }` ends the poll. Ketcher throws
   `new Error(JSON.stringify(response))`, so the whole JSON reaches the editor
   error handler; the UI owns the friendly copy.
7. An unknown, expired or restarted job id is `404 { "error": ... }`; Ketcher
   rejects with that message, which the UI also maps.

POST does not decode the image: the body is stored and a worker runs
`spawn_blocking` (ONNX Runtime and Indigo are synchronous) so the async runtime
keeps serving Indigo. Decode failures, including the 12,000 px / 128 MiB bounds
and the `8,192` px central canvas, are therefore FAILURE states, not `400`.
Only the media type and the 10 MiB cap are validated at POST time.

**Pipeline.** One job runs, in order:

1. **Filter gate.** `contains_molecule` from the classifier. `false` fails the
   job with `No molecule was detected in this image.` This is the binary
   classifier from B1: it cannot count molecules or detect reactions, and 146
   of 250 multi-molecule images (~58%) were `no-structure` in the frozen
   evaluation. `no-structure` is not proof that no structure exists, so the
   copy does not tell the user they drew nothing.
2. **OCSR.** The same encoder/decoder pair as `/v2/ocsr/recognize`. An
   `incomplete` decode or `confidence < confidence_threshold` (manifest value
   `0.901`, provisional) fails the job with the message
   `The structure could not be read confidently. Try a sharper or larger image.`
   A truncated SMILES is never converted: an unfinished structure is an error,
   exactly as in activity 8. Unlike the single-image endpoint, the shim **does**
   gate on confidence. The threshold is the in-domain hand-drawn value measured
   in the integration report; it has not been calibrated on real Chemistry Draw
   inputs. Changing it requires a measured delta, a manifest update and a docs
   update, following the classifier-threshold rule in `docs/conventions.md` §9.
3. **SMILES → molfile.** The SMILES goes through the same
   `indigo_ops::convert` as `/v2/indigo/convert`, with
   `chemical/x-mdl-molfile` (V2000) as the output format. Convert lays the
   structure out before writing, so the molfile carries usable 2D coordinates.
   A conversion failure (empty or rejected SMILES, Indigo error) fails the job
   with the message
   `The recognized structure could not be prepared for the editor. Try again.`
4. **SUCCESS.** `{ "state": "SUCCESS", "metadata": { "mol_str": "<molfile>" } }`.

**Failure states.** The `FAILURE` body is always
`{ "state": "FAILURE", "error": "<message>" }` with HTTP `200`; only an
unknown, expired or restarted job id is `404`.

| Condition                                             | FAILURE `error`                                                               | UI dialog                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| filter returns `no-structure`                         | `No molecule was detected in this image.`                                     | No molecule found        |
| `incomplete` or low confidence                        | `The structure could not be read confidently. Try a sharper or larger image.` | Structure not recognized |
| undecodable / unsupported / over-dimension image      | `Unsupported image. Use a PNG, JPEG or WebP file.`                            | Unsupported image        |
| model missing, checksum/contract mismatch, no runtime | `Recognition models are not available. Check the model setup.`                | Models not available     |
| SMILES → molfile failure                              | `The recognized structure could not be prepared for the editor. Try again.`   | Recognition failed       |
| still `PENDING` after the TTL                         | `Recognition timed out. Try again.`                                           | Recognition timed out    |

A POST with an unsupported `Content-Type` is `400` and maps to the unsupported
image dialog. An over-cap POST is the documented **plain-text exception**: axum's
`DefaultBodyLimit` answers `413` with `Failed to buffer the request body`, not
`{ "error": ... }`. Ketcher parses every response with `response.json()`, so the
plain text makes that call throw a JSON syntax error (`Unexpected token`); the UI
maps it to "The server could not process the image. It may be too large."
`App.tsx` maps the documented strings (including the JSON that Ketcher wraps
around a `FAILURE`) to the dialogs above and never shows raw JSON: a JSON body
without a usable `error`/`message` is still treated as JSON and gets the generic
`Recognition failed.` message, and an unrecognized non-JSON failure is shown as
the plain error.

**Job store and TTL.** The store is in-memory and per-process: an opaque id maps
to one job (`PENDING`, `SUCCESS` or `FAILURE`), the uploaded bytes and
timestamps. A sidecar restart drops every job, so a later poll is `404`. Two
independent bounds apply:

- **Worker bound: 120 s.** A pipeline still running after 120 seconds is
  abandoned and its job resolves as `FAILURE` with the timeout message. This is
  a bound on processing, not a fixed delay; it is generous because the first
  recognition loads the ~316 MB OCSR pair from disk.
- **Store TTL: 10 minutes (600 s).** A job still `PENDING` after 10 minutes
  (for example a lost worker) resolves as `FAILURE` with the timeout message on
  its next poll. A resolved job is discarded 10 minutes after it resolved, so a
  poll after that is `404` (the timeout `FAILURE` is reachable for 10 minutes).
  The uploaded bytes are dropped as soon as the job resolves.

Both the upload and the poll handler call `purge` before answering, so expired
entries leave the map instead of accumulating for the process lifetime; there is
no background reaper. The store is deliberately not persisted and exposes no
listing: it exists only to bridge Ketcher's asynchronous protocol to a
synchronous pipeline.

**UI re-enabled.** `App.tsx` no longer passes
`buttons={{ recognize: { hidden: true } }}`. The control is enabled by the
sidecar's synthetic `imago_versions` list, not by a local option: Ketcher
recomputes the button's `disabled` state from `app.imagoVersions` after
`GET /v2/info` and keeps the control disabled when the list is empty.

Ketcher's built-in dialog still renders an "Imago version" selector, so
`src/overrides.css` (imported by `App.tsx` after the Ketcher stylesheet) hides
the label with `label[class*="imagoVersion"] { display: none !important; }`.
The selector is meaningless here: Chemistry Draw serves one local OCSR model,
so there is no version choice; the label and the optional `?version=` query are
Ketcher protocol artifacts, not an Imago dependency. Ketcher defaults the value
to `imagoVersions[1]`, which is `undefined` for the single synthetic entry, so
it omits `?version=` entirely; when a version is present the shim accepts and
ignores it. Ketcher's built-in "Import Structure from Image" dialog uploads,
polls and inserts; no custom React upload UI is added. `handleError` gains the
failure mapping above, with a generic fallback for unknown JSON.

**Stale recognition results.** Ketcher turns every `recognize` promise into a
dialog `setStruct` dispatch, so changing the image while the previous job is
still running can let the older result overwrite the new preview (or clear it
with an old error). `App.tsx` therefore uses `StaleSafeStructServiceProvider`,
a thin subclass of `RemoteStructServiceProvider`: each `recognize` call takes a
monotonic token, and only the latest token may resolve or reject. Older
resolutions and rejections return a never-settling promise, so the stale
Ketcher thunk never dispatches; the other struct-service methods are untouched.
Ketcher's `StructRender` additionally caches the rendered SVG by the molfile
title line, and the sidecar writes an empty title for every structure, so the
wrapper rewrites the latest result's title (`Recognized structure <token>`) to
keep the cache key distinct. The title is cosmetic: atoms and bonds are
untouched, and the editor loads the same molecule. This is app-level code, not
a Ketcher patch.

**Input and bounds.** Raw PNG/JPEG/WebP only, 10 MiB inclusive (10,485,760
bytes), no multipart and no base64. The classifier's `12,000 px` per side and
`128 MiB` decoder bounds and the OCSR `8,192 px` central-canvas bound still
apply inside the worker; they fail the job as an unsupported image.

### Health and module map

`/v2/health` adds `onnxruntime_version` and `models` to the existing
diagnostics. `onnxruntime_version` names the ONNX Runtime **API generation**
`ort` targets (for example `onnxruntime api 1.31.x (ort 2.0.0-rc.15)`), not the
loaded binary's exact patch version. `models` lists only ids declared by the
manifest **whose required artifact files exist on disk** (a cheap existence
check, no checksum, no session): the classifier's single file and the OCSR
model's encoder, decoder and vocab. With both installed it reports
`image-classifier@Iagea/d21f4cb` and `ocsr-handdrawn@zenodo:10781330`; an OCSR
model with only some of its files present is not listed. Health never opens an
OCSR session.
`/v2/info` adds the synthetic `imago_versions` capability list; the rest of the
payload (`Indigo`, `indigo_version`, `api_path`) is unchanged. Ketcher parses
the capability and needs no inference metadata.

```text
sidecar/src/
  transport/filter.rs     POST /v2/filter/classify
  transport/ocsr.rs       POST /v2/ocsr/recognize
  transport/imago.rs      POST /v2/imago/uploads, GET /v2/imago/uploads/{id}
  service/recognition.rs  filter → OCSR → molfile pipeline and failure mapping
  service/jobs.rs         in-memory recognition job store and TTL
  service/ml/
    mod.rs                shared cache and entry points
    runtime.rs            dynamically loaded ONNX Runtime environment and sessions
    registry.rs           manifest, checksums and contract validation (both models)
    paths.rs              model-root precedence (explicit, repo, cwd)
    preprocess.rs         runtime_default image → NHWC tensor (bounded decode)
    ocsr_preprocess.rs    decimer_ocsr image → normalized NHWC tensor
    ocsr_vocab.rs         vocab.json, detokenization and digit remap
    ocsr_decode.rs        greedy encoder/decoder loop and stop/incomplete rules
    ocsr.rs               encoder/decoder sessions and prediction post-processing
    classifier.rs         three-input run, sigmoid, threshold
```

The OCSR modules are the layout delivered by activity 8; the compatibility
modules are the layout delivered by activity 9.

---

## 7. Native libraries

Indigo, Indigo Renderer and ONNX Runtime are **not vendored in git**.

- **Linux**: built or fetched in the Docker builder and copied by `task libs`
  into `src-tauri/lib/linux-x86_64/` (gitignored). The same directory is what
  packaging ships. `libstdc++` and `libgcc_s` are **never** shipped: the target
  distro runtime is used. The real support floor is **glibc 2.36**
  (`arc4random@GLIBC_2.36` in `libindigo.so`): Debian 12+, Ubuntu 24.04+,
  current Fedora.
- **Windows**: `scripts/fetch-windows-libs.ps1` downloads the pinned EPAM
  Indigo **1.46.0** x86_64 archive, verifies its SHA-256, extracts
  `indigo.dll`, `indigo-renderer.dll`, `msvcp140.dll`, `vcruntime140.dll` and
  `vcruntime140_1.dll` into `src-tauri/lib/windows-x86_64/` (gitignored) and
  generates the MSVC import libraries `indigo.lib` / `indigo-renderer.lib`
  from the `indigo*` C exports.

Activity 7 (`ship-onnx-runtime`) adds the pinned ONNX Runtime **1.31.0** to
that shipped set on both platforms; both downloads are SHA-256 verified:

| Platform | Pinned archive                     | SHA-256                                                            | Payload                                           |
| -------- | ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Linux    | `onnxruntime-linux-x64-1.31.0.tgz` | `cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57` | `lib/libonnxruntime.so*` (real file 29,345,384 B) |
| Windows  | `onnxruntime-win-x64-1.31.0.zip`   | `3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195` | `onnxruntime.dll` (17,253,176 B)                  |

Both archives are the official 1.31.0 release assets:
[Linux x64](https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz)
and
[Windows x64](https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-win-x64-1.31.0.zip).

- Linux: `scripts/build-libs.sh` downloads, verifies and extracts
  `libonnxruntime.so*` into the builder output, so `/opt/chemistry/libs` holds
  the chain `libonnxruntime.so` -> `libonnxruntime.so.1` ->
  `libonnxruntime.so.1.31.0` (one real file). `task libs` and the packaging
  scripts copy it with `cp -a`, preserving the symlinks instead of shipping
  three copies. Tauri's resource copier dereferences symlinks, so
  `scripts/repack-native-payload.sh` restores the chain inside the `.deb` and
  `.rpm` payloads; the AppImage AppDir is assembled with `cp -a` directly.
- Windows: `scripts/fetch-windows-libs.ps1` downloads, verifies and extracts
  `onnxruntime.dll` next to the Indigo DLLs.

The runtime is still **loaded dynamically** through `ORT_DYLIB_PATH`: the
sidecar has no link-time dependency, `ldd` shows no `libonnxruntime`, and no
`OrtGetApiBase` symbol appears in the binary. Host precedence is
`.ort/<platform>/` (debug developer override, fetched by
`scripts/fetch-onnxruntime.sh`) over the bundled `lib/<platform>/`; release uses
the bundled copy only. Missing both leaves Indigo working and makes the
classifier answer `503`.

ONNX Runtime 1.31 needs **glibc 2.28** and **GLIBCXX 3.4.22**, below the Debian
12 builder (glibc 2.36, GLIBCXX 3.4.30), so the application floor stays
**glibc 2.36**. Model weights remain **not bundled**: no `.onnx` file or
`manifest.json` is shipped in any artifact; model download is Phase B3.

---

## 8. Packaging

Platform settings live in `src-tauri/tauri.linux.conf.json` and
`src-tauri/tauri.windows.conf.json`; `tauri.conf.json` only holds what is
common (Tauri merges the platform file at build time).

Linux: `task packages` runs everything inside `chemistry-builder` and writes to
`dist-packages/`:

- `.deb` / `.rpm`: Tauri bundler (`tauri build --bundles deb,rpm`).
- AppImage: **custom AppDir** assembled by `scripts/make-appimage.sh` and packed
  with `appimagetool`. Tauri's linuxdeploy bundler is deliberately not used
  because it copies the whole ELF closure (GTK/WebKit/Wayland), which breaks EGL
  on other distros.

The Linux payloads bundle the builder's `lib/linux-x86_64/` as a Tauri
resource: exactly one real `libonnxruntime.so.1.31.0` plus the
`libonnxruntime.so.1` and `libonnxruntime.so` symlinks, and no model files.
`check-native-libs.sh --allowlist /opt/chemistry/libs` runs before bundling and
rejects any file the builder image did not provide.

Windows: `pnpm tauri build --bundles nsis` produces an NSIS installer under
`target/release/bundle/nsis/`. It bundles `indigo-server.exe` plus the five
Indigo/MSVC DLLs and `onnxruntime.dll` under `lib/windows-x86_64/`; `externalBin`
lists only `indigo-server`.

The Windows build lives in `.github/actions/windows-build`: toolchain, DLL fetch,
sidecar build, harness, smoke test and NSIS bundle. Both `ci.yml` (artifact) and
`release.yml` (release asset) call it, so the published installer is the same
one CI validated. A release publishes `.deb`, `.rpm`, AppImage and the Windows
`.exe`.

The NSIS bundle keeps Tauri's default per-user install and embeds only the
WebView2 bootstrapper (`embedBootstrapper`). WebView2 is part of normal Windows
10/11 installations; systems where Edge/WebView2 was removed are not supported.
Bundling the offline runtime (~215 MB) was tried and rejected as too large.

`scripts/build-packages.sh` serializes runs with `flock` because concurrent
builds share the target volume and bundle directory.

Version bumps are driven by release-please and must stay in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
`src-tauri/sidecar/Cargo.toml`.

---

## 9. Observability

- Rust host + frontend + sidecar output go to a rotating file via
  `tauri-plugin-log` (stdout + app log dir, 2 MB × 5 files).
- The sidecar's stdout/stderr is forwarded line by line with ANSI stripped.
- `GET /v2/health` exposes uptime, PID, port, the Indigo version, the targeted
  ONNX Runtime API generation and the model ids whose artifacts are on disk. It
  is for support, not for Ketcher.
- Panics are logged with location.

---

## 10. Temporary workaround

`ketcher-core` 3.18.0 has a bug in `parametrizeUrl` that turns the port in
`127.0.0.1:9321` into a placeholder. We ship `patches/ketcher-core@3.18.0.patch`
(registered in `pnpm-workspace.yaml`). Upstream fixed it in
[epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552) but has not
published a release with the fix yet. Removal procedure:
`docs/KETCHER-BUG-parametrizeUrl.md`.

---

## 11. Non-goals

- Online accounts, telemetry, or cloud sync.
- Shipping prebuilt binaries in git.
- Reimplementing Ketcher's editor UI.
- Supporting glibc < 2.36 or webkit2gtk < 4.1.
- Shipping Imago or OpenCV. B1 ships an ONNX classifier gate; B2 adds OCSR
  inference through the two-model pipeline plus the Ketcher-compatible job
  shim. No Imago code, worker or native library is shipped. The pinned ONNX
  Runtime 1.31.0 native library (loaded dynamically) is shared by both, but
  model weights are never bundled; downloading models is Phase B3.
