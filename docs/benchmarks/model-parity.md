# Model parity — Phase D pilot300

> **Status: protocol frozen and results recorded (2026-11-17; latency re-measured
> on the release build 2026-11-18).** Both pilot gates pass on the same 300 IDs:
> the classifier matches the FP16 reference on all 300 labels, and the OCSR
> canonical rate is above its reference. See §4 for the run identity, measured
> values, the release-build latency and the per-image differences.

## 1. Purpose and scope

Phase D starts with a **model-parity pilot**: run the frozen `pilot300` split
through the Chemistry Draw sidecar and check that the two shipped models
reproduce the decimer-onnx-toolchain's frozen predictions on the **same IDs**.
The pilot answers one question:

> Do the models installed in the app behave like the toolchain-selected
> artifacts on the same inputs?

It is a parity check, not a new evaluation, not a variant comparison and not a
threshold recalibration. A parity failure is investigated; a parity pass does
not by itself change a model, a threshold or a preprocessing pipeline.

| Role             | Model id                         | App artifact                                                      | SHA-256                                                            |
| ---------------- | -------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Image classifier | `image-classifier@Iagea/d21f4cb` | `models/image-classifier-fp16/classifier.fp16.onnx` (8,162,917 B) | `d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9` |
| Hand-drawn OCSR  | `ocsr-handdrawn@zenodo:10781330` | `models/ocsr-handdrawn-fp32/encoder.onnx`                         | `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52` |
| Hand-drawn OCSR  | `ocsr-handdrawn@zenodo:10781330` | `models/ocsr-handdrawn-fp32/decoder_step.onnx`                    | `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197` |
| Hand-drawn OCSR  | `ocsr-handdrawn@zenodo:10781330` | `models/ocsr-handdrawn-fp32/vocab.json`                           | `62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd` |

The model artifacts are byte-identical to the toolchain selection bundle
(`$TOOLCHAIN/chemistry-draw-ocsr/image-classifier-fp16/` and
`$TOOLCHAIN/chemistry-draw-ocsr/ocsr-handdrawn-fp32/`). The run verifies the
hashes again before it starts; a mismatch is a setup failure, not a model
result.

**In scope:** classifier binary accuracy and confusion on the non-reaction
pilot rows; classifier reactions reported separately; OCSR RDKit canonical,
exact and valid rates; per-image agreement with the toolchain; p50/p95 on one
machine.

**Out of scope:** variant selection, whole `eval1000` runs, printed OCSR,
re-tuning the classifier threshold or the OCSR confidence gate, preprocessing
changes, the `/v2/imago/*` compatibility pipeline, packaging and model
delivery.

## 2. Provenance and fixed inputs

The dataset and the toolchain live in a checkout outside this repository. In
this document `$TOOLCHAIN` is that checkout; all paths below are relative to it
unless stated otherwise.

| Input                            | Path (relative to `$TOOLCHAIN`)                             | SHA-256                                                            |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Toolchain commit                 | git `c2265a6d83f3eb5a7ef0fd5df4741335627c5f20`              | —                                                                  |
| Classifier frozen manifest       | `data/manifests/frozen/classifier.frozen.json`              | `27304f11f2613f17780f044e52441a408254898a11ccaed89b9adaf885f43621` |
| Hand-drawn frozen manifest       | `data/manifests/frozen/handdrawn.frozen.json`               | `92a1931a3a7f2abe535ef6f0b24e37962899a1ab2da36e9c150cfd126b729f24` |
| Classifier labels                | `data/benchmark/classifier-curated/labels.jsonl`            | `c18023b791b39d74bd0621ea033e3b19d158267c24737624a20dbb409ac8bac1` |
| Hand-drawn labels                | `data/benchmark/handdrawn-hdm/labels.jsonl`                 | `352e626d6be3fcdfdbf37826ada6f2d6e6eae3debe78a20e6c2f0839bb2e33a1` |
| Classifier FP16 eval reference   | `data/benchmark/eval-1000/classifier.e4-fp16.eval1000.json` | `c19cd03dc8b8809b250aecaf9ce512a2d17f48e1100bad01f17e3b10b5fcdc53` |
| Classifier FP32 historical pilot | `data/benchmark/pilot/classifier.fp32.pilot300.json`        | `fa6ab2c58c9d0e22eb5a6be2622516bd009c60ca54cf2e16cb68b45c20292f82` |
| Hand-drawn FP32 pilot reference  | `data/benchmark/pilot/handdrawn.fp32.pilot300.json`         | `d8df90cd3ddc439435db1b5dea00541d8c9a87ef48910ff13db6dc647490ba0c` |

### 2.1 Datasets

| Source                | Images (relative to `$TOOLCHAIN`)                                  | License / provenance                                                                                                         |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `classifier-13378718` | `data/benchmark/classifier-curated/classified/` (166 MB)           | Zenodo **13378718**; the record indicates **MIT with mixed image origins** — verify the original terms before redistribution |
| `handdrawn-hdm`       | `data/benchmark/handdrawn-hdm/DECIMER_HDM_Dataset_Images/` (25 MB) | Zenodo **7617107**, **CC-BY-4.0**, checksums verified at import                                                              |

The labels' `image` field resolves against the dataset root shown above
(`$TOOLCHAIN/data/benchmark/classifier-curated/` and
`$TOOLCHAIN/data/benchmark/handdrawn-hdm/`). Neither dataset, nor the toolchain
checkout, is copied into this repository; `models/` is gitignored and the
weights are never committed or bundled.

### 2.2 Frozen split semantics

Both frozen manifests use seed `20260308`. The pilot is the **first 300 IDs of
the eval split in frozen order**; the run reads `splits.pilot` directly and
never re-shuffles or substitutes an ID. The hand-drawn pilot and the classifier
pilot are independent (no cross-model pairing).

- **Classifier:** frozen n=4000, stratified over the four source classes;
  `eval` n=1000; `pilot` n=300. The pilot contains **72 reactions and 228
  binary rows** in the current manifest (a previous split had 84/216; see
  §2.3).
- **Hand-drawn:** frozen n=1400; `eval` n=1000; `pilot` n=300.

### 2.3 Reference reconciliation (important)

The historical `classifier.fp32.pilot300.json` (0.7361 binary accuracy, n=216,
84 reactions) was generated **before** the current
`classifier-curated/labels.jsonl` and `classifier.frozen.json` were written on
2026-11-09 (00:31 versus 09:21). Only **8 of its 300 image paths** (category +
filename; **0/300 IDs**) overlap the current `classifier.frozen.json`
`splits.pilot`, so it is **not a same-ID reference** and must not be used as the
acceptance baseline. The toolchain report's pilot row inherits that file; this
document does not rewrite the external report.

The valid same-pilot reference is derived from the toolchain's per-image FP16
predictions in `classifier.e4-fp16.eval1000.json`, restricted to the current
frozen pilot IDs:

| Reference (same pilot IDs)         | Value                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| Binary accuracy                    | **0.7281** (166/228)                                        |
| Confusion (TP/FN/FP/TN)            | 87 / 62 / 0 / 79 (expected structure row first)             |
| Reactions (excluded)               | 72 → 48 predicted `structure`, 24 predicted `no-structure`  |
| Headline FP16 eval1000 (context)   | 0.7679 (n=754; TP 319/FN 174/FP 1/TN 260)                   |
| FP32 eval predictions on pilot IDs | 0.7281 (166/228), identical aggregate — the pilot is stable |

The derivation is part of the run: filter `details[]` by the 300
`splits.pilot` IDs, then reuse the same binary function as the sidecar run.
Task `c` pins the derivation command and the reference hash in §4. If the
toolchain is rerun instead, it must be rerun on the same 300 IDs and its
aggregate pinned before the sidecar run.

The hand-drawn reference **is** paired: its 300 IDs match
`handdrawn.frozen.json` `splits.pilot` exactly.

## 3. Protocol

### 3.1 Common rules

- Use the same 300 IDs, in the same frozen order, for the reference and the
  sidecar run. No image is dropped, replaced or retried with different
  settings. A dropped image is a run failure and is investigated.
- Call the production endpoints: `POST /v2/filter/classify` and
  `POST /v2/ocsr/recognize`. Do **not** use `/v2/imago/uploads`: that shim adds
  the `0.901` confidence gate and Indigo conversion, which are not part of this
  model comparison.
- One process, CPU execution provider, one intra-op thread, the same machine
  for both models. Record machine, date, sidecar commit, ONNX Runtime version
  and RDKit version.
- Convert TIFF inputs as described in §3.6 before the run; keep the ID →
  converted-file map in the run manifest.
- Raw per-image outputs (predicted label or SMILES, score, latency, errors) go
  to `target/benchmarks/model-parity/<run-id>/`; the committed document carries
  only aggregates and counts.

### 3.2 Classifier

- Expected label comes from `classifier-curated/labels.jsonl`:
  `one_molecule` and `several_molecules` → `structure`, `other` →
  `no-structure`. On disk the `other` class is stored under the `rest/` folder;
  the label record carries `category: "other"`, and that field is the source of
  truth. `reactions` are **excluded from the binary metric** and reported
  separately. The sidecar emits binary only, so the 4-class mapping applies to
  the ground-truth labels; there is no 4-class prediction matrix.
- Predicted label is the sidecar's `category`; it is `structure` exactly when
  `score <= 0.000089`, otherwise `no-structure`. `0.000089` is fixed for the
  run and is not tuned.
- Binary `n` is the number of non-reaction pilot rows (currently 228). Accuracy
  is `(TP + TN) / n`, with TP = expected `structure` and predicted `structure`,
  FN = expected `structure` and predicted `no-structure`, FP = expected
  `no-structure` and predicted `structure`, TN = both `no-structure`. Record
  the confusion matrix with that row order.
- Reactions: count, predicted `structure`/`no-structure`, excluded from
  accuracy. No accuracy number is computed over reactions.
- All 300 images must decode after conversion. A decode failure (after the
  format conversion) is a run failure, not a dropped row.
- Record per-image agreement with the toolchain FP16 reference: agreements,
  disagreements, and the disagreement rows (ID, expected, toolchain predicted,
  sidecar predicted, score). The same counts are recomputed against the FP32
  eval predictions as a secondary check.

### 3.3 Hand-drawn OCSR

- Expected SMILES comes from `handdrawn-hdm/labels.jsonl`; the sidecar returns
  `smiles`, `confidence` and `incomplete`.
- `valid`: the toolchain heuristic — a non-incomplete answer exists. It is
  **not** an RDKit parse check: the seven reference answers that do not parse
  (nine in the sidecar run) still count as valid. `incomplete`: the sidecar
  answered `422` (the decoder reached `max_len` without `end_id`) or returned
  `incomplete: true`; there is no SMILES in a `422`. RDKit **2026.09.1** (the
  toolchain virtualenv's version) decides parseability and therefore the
  comparable denominator.
- `exact_match`: raw string equality between the expected and returned SMILES,
  denominator **300**.
- `canonical_match`: parse both strings with RDKit, compare isomeric canonical
  SMILES (`Chem.MolToSmiles(Chem.MolFromSmiles(...))`); denominator is
  **comparable pairs** (both parse). A `422`/incomplete row has no returned
  SMILES, so it is not comparable; it still counts as an `exact_match` failure
  and as invalid. Record the numerator, the comparable denominator and the
  full-300 complement.
- The `0.901` `confidence_threshold` is **informational for this pilot**: the
  single-image endpoint does not gate on it. Do not apply it. Record confidence
  as a diagnostic only; do not filter rows by confidence.
- All 300 rows must answer `200` or `422`. Any other status (`400`, `5xx`) is a
  run failure and is investigated.
- Per-image agreement: compare the sidecar SMILES with the toolchain FP32
  pilot output (`handdrawn.fp32.pilot300.json`) by exact string and by
  canonical SMILES; record the disagreements.

### 3.4 Latency

Record p50 and p95 over the 300 timed calls per model on the same machine,
after one separate warm-up request that pays session load and checksum time
(record that load time separately). Use the **nearest-rank** percentile on the
sorted latencies: index `ceil(p * n) - 1` for `p = 0.50` and `p = 0.95`
(`n = 300` → indices 149 and 284). Do not report the mean only.

**Measure the shipped build.** Latency is recorded on
`target/release/indigo-server`, the binary the app packages. A debug binary is
not representative: unoptimized image decode/resize dominates its timings, so
its numbers are not comparable to the toolchain or to the shipped app and are
kept only as a development note.

**What each number measures.** The sidecar value is a **full HTTP round trip**
timed by the runner: the `POST` with the image bytes until the response is
received, including the loopback HTTP hop, the sidecar's image decode,
resize/pad preprocessing, the ONNX Runtime call and the JSON response. It
excludes only the runner's file read (the timer starts after the body is
buffered) and reading the response body after the headers.

The classifier toolchain reference is the eval1000 FP16 per-image `latency_ms`
(n=1000, `cache_hits=0`; report p50 **49.20** / p95 **206.48** ms). It times
`make_onnx_classifier_predict_fn`: Pillow open + preprocess (grayscale, LANCZOS
resize, white pad) + the in-process ORT `sess.run`, with no HTTP, no Node and no
Rust. It is therefore a **lower bound** for an app request; the fair comparison
is "model + preprocess" against "model + preprocess + transport", and the gap is
stated explicitly rather than subtracted silently.

The toolchain's hand-drawn pilot report is served from its prediction cache
(`cache_hits = 300`, `n_measured = 0`; p50/p95 `null`), so it has **no fresh
OCSR latency**. Record the release sidecar p50/p95 as the app measurement and do
not invent a delta.

### 3.5 Acceptance

| Gate                                  | Reference                                      | Tolerance      | Required result        |
| ------------------------------------- | ---------------------------------------------- | -------------- | ---------------------- |
| Classifier binary accuracy (same IDs) | 0.7281 (166/228)                               | ≥ ref − 0.5 pp | **≥ 0.7231 (165/228)** |
| Classifier binary `n`                 | 228 non-reaction / 72 reactions                | exact          | 228 / 72, 300 decoded  |
| OCSR canonical match (comparable)     | 0.7192 (210/292)                               | ≥ ref − 1.0 pp | **≥ 0.7092 (208/292)** |
| OCSR exact match                      | 0.4033 (121/300)                               | none, record   | recorded               |
| OCSR valid / incomplete               | 0.9967 / 0.0033 (299/300, 1)                   | none, record   | recorded               |
| Artifact identity                     | hashes in §1                                   | exact          | all equal              |
| p50 / p95                             | classifier 49.20 / 206.48 ms in-process (§3.4) | none, record   | recorded               |
| Per-image agreement                   | reference per image                            | none, record   | disagreements listed   |

A result outside a gate opens an investigation (preprocessing drift, artifact
hash, decode path, threshold direction, conversion error). The pilot itself
does not change the threshold, the preprocessing or the model. The dossier's
≥70% eval floor is not re-litigated here.

### 3.6 Format conversion rule (TIFF → RGB PNG)

The app decodes only **PNG, JPEG and WebP** (`src-tauri/sidecar/Cargo.toml`,
`image` features `png`, `jpeg`, `webp`). The classifier corpus contains TIFF:
**652 of the 1000 eval images** and **197 of the 300 pilot images**. The
sidecar cannot read those bytes, so the pilot converts them before the run.

- Converter: the toolchain Pillow, `$TOOLCHAIN/.venv/bin/python`.
- Operation: open the first frame, `convert("RGB")`, save as PNG. No resize, no
  filter, no normalization, no inversion, no histogram equalization; the PNG
  carries the same RGB samples the toolchain benchmark reads from the TIFF.
- Location: `target/benchmarks/model-parity/<run-id>/converted/` (gitignored).
  Temporary files only; no converted image is committed.
- The run manifest records the original ID, the TIFF path and the converted
  PNG path. The classifier requests use the converted PNG.
- The app's supported formats are unchanged: a TIFF, GIF, BMP or PNM upload
  still returns `400`. Conversion is benchmark scaffolding, not product
  behaviour.

### 3.7 Reproducibility inputs and outputs

All commands are finalized in tasks `c`/`e`; the intended sequence is:

1. Verify the SHA-256 values in §1 and §2 (`sha256sum`).
2. Build and start the **release** sidecar with the local models
   (`CHEMISTRY_MODELS_DIR`) and a loadable ONNX Runtime (`ORT_DYLIB_PATH`);
   confirm `/v2/health` lists both model ids:

   ```bash
   cargo build --release -p indigo-server --bin indigo-server
   sha256sum target/release/indigo-server   # record hash + mtime
   ```

   The runner starts this binary (`--sidecar` defaults to
   `target/release/indigo-server`), so build it first as above; a debug binary
   is for functional smoke tests only and its latency is not reported.

3. Convert the 197 TIFF pilot images with the toolchain Pillow (§3.6).
4. Run the classifier pilot and the hand-drawn pilot through
   `scripts/model-parity.mjs` (added by task `c`; flags frozen with the script).
5. Write the raw outputs under `target/benchmarks/model-parity/<run-id>/`,
   fill §4, and re-run the parity unit tests.
6. `node scripts/harness.mjs` stays green.

The committed report is **this file**. Raw predictions, converted images and
logs stay under `target/benchmarks/` and are never committed.

## 4. Results

> Both gates pass. The raw per-image rows, converted images, sidecar log and
> `summary.json` stay under `target/benchmarks/model-parity/` and are not
> committed.

### 4.1 Run identity

| Field                | Value                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                 | `2026-11-18T02:27:34Z` (2026-11-17 local, UTC−05:00)                                                                                                                                  |
| Machine / CPU        | Intel Core i5-8365U @ 1.60 GHz, 4 cores / 8 threads, 15.8 GB RAM; Fedora 45, kernel `7.3.3-300.fc45.x86_64`                                                                           |
| Sidecar commit       | workspace `fb16451b14024b582dd5767c6f7d0a222a49fae0`; `cargo build --release -p indigo-server --bin indigo-server`                                                                    |
| Sidecar binary       | `target/release/indigo-server` (the shipped build) SHA-256 `b7b850c9534a734dfe28702dd8343d96e4bb645cecdd59e863a1188f6558263a`, 7,078,952 B, mtime `2026-11-18T02:26:52Z`              |
| ONNX Runtime version | `onnxruntime api 1.31.x (ort 2.0.0-rc.15)`, CPU provider, **one intra-op thread**; Indigo `1.51.0-dev.1-00000000-x86_64-linux-gnu-12.2.0`; sidecar `0.1.7`                            |
| RDKit version        | `2026.09.1`; Pillow `13.0.0` (toolchain virtualenv)                                                                                                                                   |
| Toolchain commit     | `c2265a6d83f3eb5a7ef0fd5df4741335627c5f20`                                                                                                                                            |
| Reference derivation | eval1000 FP16 `details[]` filtered to `splits.pilot`; reference file `c19cd03d…fcdc53`; per-ID predictions SHA-256 `d99c6f2069cb5c535aae2f7b1a3ca4dd15f3541e18640c18373c5b24121cabd3` |
| Run id / raw output  | `target/benchmarks/model-parity/2026-11-18T02-27-34-439Z/` (gitignored)                                                                                                               |
| Runner command       | `node scripts/model-parity.mjs --suite both --split pilot --sidecar target/release/indigo-server`                                                                                     |

The classifier reference was derived, not copied, with:

```bash
TOOLCHAIN=../decimer-onnx-toolchain node --input-type=module -e '
import { readFileSync } from "node:fs";
import { referenceFromEval, selectSplit } from "./scripts/lib/model-parity.mjs";
const t = process.env.TOOLCHAIN;
const frozen = JSON.parse(readFileSync(`${t}/data/manifests/frozen/classifier.frozen.json`, "utf8"));
const eval1000 = JSON.parse(readFileSync(`${t}/data/benchmark/eval-1000/classifier.e4-fp16.eval1000.json`, "utf8"));
const r = referenceFromEval(eval1000.details, selectSplit(frozen, "pilot"));
console.log(JSON.stringify(r.metrics), JSON.stringify(r.reactions));
'
# => {"tp":87,"fn":62,"fp":0,"tn":79,"total":228,"excluded":72,"accuracy":0.7280701754385965}
#    {"total":72,"predictedStructure":48,"predictedNoStructure":24}
```

The FP32 eval predictions restricted to the same IDs reproduce the same
aggregate and the same per-ID hash (`d99c6f20…21cabd3`), so the historical
`classifier.fp32.pilot300.json` is still not the baseline (§2.3). Two earlier
**debug** runs (`2026-11-18T00-56-23-652Z`, `2026-11-18T01-33-33-993Z`, binary
`9f014f74…4af0a2f`) produced the same 600 predictions; the release run
reproduced them **exactly**, including every classifier `score` and every OCSR
`status`/`got` value (600/600 rows compared), so the release build changes
latency only, never model behaviour. The debug runs are a development note, not
a representative result.

The raw `summary.json` records `repo.dirty: true`: the working tree carried the
uncommitted docs and scripts of this activity at run time. The sidecar source
was unchanged — the binary was built from the recorded commit `fb16451…` and its
SHA-256 is in the table above — so the dirty flag covers only documentation and
harness files, not anything under `src-tauri/`, and it does not affect the
measured rows.

### 4.2 Classifier (FP16)

| Metric                    | Reference                                     | Sidecar (release)                                     | Δ (pp)   |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------- | -------- |
| Binary accuracy           | 0.7281 (166/228)                              | **0.7281 (166/228)**                                  | 0.00     |
| Binary n                  | 228                                           | **228** (300 decoded, 72 excluded)                    | —        |
| TP / FN / FP / TN         | 87 / 62 / 0 / 79                              | **87 / 62 / 0 / 79**                                  | —        |
| Reactions (excluded)      | 72 (48 / 24)                                  | **72 (48 structure / 24 no-structure)**               | —        |
| p50 / p95 (ms)            | 49.20 / 206.48 (in-process predict, eval1000) | **124.4 / 425.9** (full round trip; warm-up 257.7 ms) | 2.5× p50 |
| Per-image agreement (300) | —                                             | **300/300 vs FP16** (and 300/300 vs FP32)             | —        |

**Gate: PASS** — accuracy 0.7281 ≥ 0.7231, n = 228 binary / 72 reactions, all
300 images decoded. There are **no** per-image disagreements against the FP16
reference; the raw output has the full rows.

**Latency comparison (release, same machine, sequential).** The two numbers
span different work (§3.4): the toolchain's 49.20/206.48 ms times Pillow
preprocess + in-process ORT inference on eval1000 (n=1000, no cache) with ORT's
default thread count; the sidecar's 124.4/425.9 ms is a full HTTP round trip
with the protocol's single intra-op thread. The p50 is **2.5×** the toolchain
(2.1× the re-measured in-process total) and the p95 is 2.1× (2.0× re-measured).
The protocol defines no escalation threshold, so the gap is recorded, not gated.
It is **not inference**: at p95, and in the sidecar's own time, the round trip
is preprocessing-dominated (327.3 of 425.9 ms), while at p50 the largest single
part of the 75 ms gap over the toolchain is the ≈38 ms HTTP/tensor/JSON
remainder (decode + Lanczos adds ≈16 ms and the single intra-op thread ≈13 ms):

| Component (same 300 pilot images, same machine)                                      | p50 / p95 (ms) |
| ------------------------------------------------------------------------------------ | -------------- |
| Sidecar full HTTP round trip (release, 1 intra-op thread)                            | 124.4 / 425.9  |
| Rust decode + `runtime_default` preprocess (`image` 0.25.10, release, same pipeline) | 61.2 / 327.3   |
| ORT inference on the resulting 224×224 input, 1 thread (toolchain venv ORT 1.26)     | 24.8 / 41.3    |
| Remainder: loopback HTTP hop, tensor construction, JSON, Node client                 | ≈38 / ≈57      |
| — for reference — Pillow preprocess, toolchain venv                                  | 44.9 / 192.9   |
| — for reference — ORT inference, toolchain default threads (ORT 1.26)                | 11.6 / 24.3    |
| — for reference — Pillow preprocess + ORT default threads (re-measured total)        | 59.4 / 209.4   |

A fixed-input check isolates the same effect: a synthetic 224×224 PNG round trip
is 48.1 ms p50 (mostly inference + HTTP floor), while a 2000×2000 PNG is
180.9 ms p50 — **+133 ms** from decode/resize alone. The classifier model is
small and inference is a minor share; the gap is the Rust preprocessing port
(full-resolution decode + Lanczos3, ~16 ms slower at p50 and ~134 ms slower at
p95 than Pillow on the same images) plus the deliberate single intra-op thread
(~13 ms p50) and the ≈38 / ≈57 ms transport floor. ORT versions differ between
the py-venv proxies (1.26) and the sidecar (1.31), so the split is indicative;
the totals are measured. Accuracy is unaffected.

### 4.3 Hand-drawn OCSR (FP32)

| Metric               | Reference                | Sidecar (release)                                        | Δ (pp) |
| -------------------- | ------------------------ | -------------------------------------------------------- | ------ |
| Canonical match      | 0.7192 (210/292)         | **0.7276 (211/290)**                                     | +0.84  |
| Comparable pairs     | 292                      | **290**                                                  | —      |
| Exact match (of 300) | 0.4033 (121/300)         | **0.4067 (122/300)**                                     | +0.33  |
| Valid / incomplete   | 299 / 1                  | **299 / 1**                                              | —      |
| p50 / p95 (ms)       | cached, no fresh latency | **1681.7 / 3557.0** (full round trip; warm-up 3990.2 ms) | —      |
| Per-image agreement  | —                        | exact **291/300**; canonical **285/290 (98.3%)**         | —      |

**Gate: PASS** — canonical 0.7276 ≥ 0.7092, all 300 rows answered `200` or
`422`, exact/valid recorded. The `422` row is `hdm::CDK_Depict_5_82`; it is
invalid, an exact failure and not comparable. It also dominates the tail: it
decoded to `max_len` in 37.3 s, while the 299 answered rows range
0.97–19.8 s (mean 1.96 s); the overall mean including the `422` is 2.08 s. The
toolchain pilot has no fresh OCSR latency (`cache_hits = 300`,
`n_measured = 0`, p50/p95 `null`), so the release p50/p95 is the app measurement
and no delta is claimed.

**Per-image disagreements (9 exact-string differences, raw rows in
`details.jsonl`):**

- **Canonical-equivalent (3):** `CDK_Depict_35_54`, `CDK_Depict_19_52`,
  `CDK_Depict_19_23` — different SMILES text, same RDKit molecule.
- **Canonical mismatch (3):** `CDK_Depict_20_4`, `CDK_Depict_47_152`,
  `CDK_Depict_2_54` — different atom/bond or stereochemistry assignment.
- **Not parseable on the sidecar side (2):** `CDK_Depict_47_38`,
  `CDK_Depict_9_74` — the reference parsed both; this is why the sidecar
  comparable count is 290 instead of 292.
- **Incomplete (1):** `CDK_Depict_5_82` (HTTP `422`).

The classifier is 300/300 against both FP16 and FP32 references; the OCSR
differences are stable across runs and are not caused by artifact hashes,
TIFF conversion (the hand-drawn set is PNG), the decode path or the threshold
direction. The remaining variance is consistent with the ported resampling
step (Pillow LANCZOS in the toolchain vs `image` Lanczos3 in the sidecar):
9/300 raw outputs differ from the toolchain, while the canonical gate is above
reference. This is a preprocessing-port observation, not a model-quality
regression.

### 4.4 Overall parity and deltas

| Check                                | Result                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact hashes equal (§1)           | **Yes.** Classifier `d5f5506b…af505a9`, encoder `996727a2…c78193f52`, decoder `cfff9788…c6bb6d68197`, vocab `62c84d90…fa3c7dd`; toolchain commit matches                                                                                                                                                    |
| Classifier gate                      | **PASS** — 0.7281 (166/228), 228 binary / 72 reactions, 300 decoded, 300/300 FP16 agreement                                                                                                                                                                                                                 |
| OCSR gate                            | **PASS** — 0.7276 canonical (211/290), 300 rows `200`/`422`, 299 valid / 1 incomplete                                                                                                                                                                                                                       |
| OCSR incomplete tail                 | **Investigated.** The one `422` (`hdm::CDK_Depict_5_82`) reached `max_len` in 37.3 s; the 299 answered rows took 0.97–19.8 s (mean 1.96 s). Parity is unaffected, but this is the top Phase D performance finding: verify the progress/cancel/timeout path and consider an earlier stop/length guard (§4.7) |
| Release build vs debug behaviour     | **Identical.** 600/600 rows match the accepted debug run, including every classifier score and OCSR answer; only latency differs (release is ~16× faster at classifier p50)                                                                                                                                 |
| Per-image disagreements investigated | **Yes.** Classifier 0/300; OCSR 9/300 exact differences (3 canonical-equivalent, 3 canonical mismatch, 2 unparseable, 1 incomplete)                                                                                                                                                                         |
| Latency                              | **Measured on the shipped release build.** Classifier 124.4 / 425.9 ms, OCSR 1681.7 / 3557.0 ms (full HTTP round trip, §3.4); the classifier gap vs the in-process toolchain reference is 2.5× p50, preprocessing-dominated at p95 / in the sidecar's own time (§4.2)                                       |
| Follow-up opened?                    | **No gate-triggered follow-up.** Thresholds/models stay unchanged; two Phase D performance findings (OCSR incomplete tail first, then classifier preprocessing) and an optional preprocessing-parity check are noted in §4.7                                                                                |

### 4.5 Threshold decision

**Retain the classifier threshold `0.000089` and the OCSR confidence gate
`0.901` (provisional/informational).** The classifier reproduces the FP16
reference exactly (300/300) and the OCSR canonical and exact rates are at or
above the FP32 reference. No threshold-related parity failure appeared, so
there is no measured delta that would justify recalibration. The `0.901` gate
is not applied by the single-image endpoint; the recorded confidence
(`min 0.7208`, `mean 0.9442`, `max 0.9959`) is diagnostic only. No per-image
tuning was performed.

### 4.6 Limitations

- Pilot subset: n=300 (classifier binary n=228; OCSR comparable n=290). Results
  are descriptive for parity, not a new eval1000 estimate.
- The classifier reference is **derived** from the eval1000 per-image file
  restricted to the current pilot IDs (§2.3); the old pilot file is stale and
  is not paired.
- Latency is one **release** run on a laptop that was also running desktop
  processes, nearest-rank p50/p95 over 300 timed calls after one warm-up; it is
  informational, not a gate. The toolchain comparison is not like-for-like
  (§3.4): the sidecar value is a full HTTP round trip including Rust decode and
  preprocessing, while the classifier reference is the toolchain's in-process
  Pillow + ORT predict. The measured split is in §4.2. The earlier debug runs
  (`2026-11-18T00-56-23-652Z`, `2026-11-18T01-33-33-993Z`; classifier
  1.86–2.03 s / 8.6–9.6 s, OCSR 3.7–4.2 s / 9.0–11.7 s) are a
  non-representative development note and are **not** the app result.
- The hand-drawn toolchain pilot is cached (`n_measured = 0`), so there is no
  fresh OCSR reference latency. The release p50/p95 stands alone; no delta is
  claimed.
- OCSR is 9/300 raw outputs away from exact toolchain parity (3 of them are
  canonical-equivalent); the gate passes and the differences are stable. The
  likely cause is the ported Lanczos resampler, not the model artifacts.
- The OCSR tail is carried by incomplete decodes, not by answered rows: the
  single `422` (`hdm::CDK_Depict_5_82`) decoded for 37.3 s to `max_len`, while
  the 299 answered rows range 0.97–19.8 s (mean 1.96 s) and the overall mean is
  2.08 s. p50/p95 hide this tail, so the app's progress/cancel/timeout path for
  an incomplete decode is the top Phase D performance follow-up (§4.7). It is a
  single-row tail, not a parity failure.
- TIFFs are converted to RGB PNG for the app (§3.6); pixel conversion is
  benchmark scaffolding and does not change the app's supported formats.
- The external dataset and toolchain are not tracked here; the pinned hashes
  and commit are the reproducibility contract.
- The classifier is binary and cannot distinguish one from several molecules;
  multi-molecule false negatives are a known model limitation, not a parity
  failure.

### 4.7 Prioritized next steps

1. **Record the parity pass and keep both thresholds unchanged**; proceed with
   the Phase D live functional review.
2. **Phase D performance finding (top, OCSR incomplete tail).** The one
   incomplete decode `hdm::CDK_Depict_5_82` took **37.3 s** to reach `max_len`
   (HTTP `422`), against 0.97–19.8 s (mean 1.96 s) for the 299 answered rows and
   2.08 s overall. Verify the app's progress/cancel/timeout path for an
   incomplete decode (the `/v2/imago` worker is bounded at 120 s; the direct
   endpoint is synchronous) and consider an earlier stop/length guard in a
   separate measured activity. This is the top Phase D performance finding after
   the parity pass; no production code, model or threshold changes here.
3. **Phase D performance finding (latency, classifier).** On the shipped
   release build the classifier round trip is 124.4 / 425.9 ms (p50/p95) against
   the toolchain's 49.20 / 206.48 ms in-process predict; the measured split
   (§4.2) puts the cost in decode + Lanczos preprocessing (~61 / 327 ms), not
   inference (~25 / 41 ms single-threaded). Candidate follow-ups, each needing
   its own measured activity: compare the Rust resampler against Pillow on the
   same pixels (shared with the optional B2 item below), and evaluate an intake
   downscale before the full-resolution composite. Do not change the model,
   threshold, thread count or `runtime_default` contract as part of this pilot.
   OCSR has no fresh toolchain latency, so its release 1681.7 / 3557.0 ms is
   recorded as the app measurement only.
4. **No gate failure to investigate.** If a future run drifts, use the
   documented order: artifact hash → format conversion → preprocessing →
   decode path → threshold direction.
5. **Extend to `eval1000` only if a broader estimate is needed**; keep the
   same-ID rule and the derived-reference method.
6. **Optional B2 preprocessing-parity follow-up:** compare the 512×512
   preprocessed tensors between the toolchain Pillow path and the sidecar's
   `image`-crate resampler to reduce the 9/300 per-image differences. Feed any
   confirmed model-quality gap (not parity) into the Phase D live-review
   backlog rather than into this pilot.

## 5. Tracking policy

Commit only:

- the parity harness and its pure unit tests (`scripts/model-parity.mjs`,
  `scripts/lib/model-parity.mjs`, `scripts/lib/model-parity.test.mjs`) plus the
  RDKit comparator (`scripts/lib/ocsr-match.py`), added by task `c`;
- this protocol/results document;
- the activity's documentation updates: `docs/ROADMAP.md` (Phase D status),
  `docs/testing.md` §6.4 (parity harness contract and test count),
  `docs/verification.md` §2 "Model parity pilot (Phase D)" (run checklist and
  result), `docs/CHECKPOINTS.md` C15 and `docs/architecture.md` (the Phase D
  benchmark pointer).

Do **not** commit the 166 MB classifier dataset, the 25 MB hand-drawn dataset,
the toolchain checkout, any `.onnx` weight, converted PNGs or raw per-image
predictions. Raw outputs live under `target/benchmarks/` (gitignored). The
report pins the toolchain commit, the frozen-manifest and label SHA-256 values,
the model SHA-256 values and the run identity, so the external inputs can be
re-fetched and checked without being stored here.

Attribution: classifier images from Zenodo 13378718 (record indicates MIT,
mixed origins — verify before redistribution); hand-drawn images from Zenodo
7617107 (CC-BY-4.0); models MIT (classifier) and CC-BY-4.0 (OCSR), per
`NOTICE`.
