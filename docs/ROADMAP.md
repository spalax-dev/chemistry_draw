# Chemistry Draw — Roadmap

> Living on the `develop` branch. Grounded in the current state of the repo (Nov 2026): Tauri v2 shell + `ketcher-react/core` 3.18.x (patched for `parametrizeUrl`; upstream fix tracked in [epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552)), and a local Rust sidecar exposing **Indigo, the B1 ONNX classifier gate and B2 OCSR recognition**. Phase A shipped Imago-free builds on Windows and Linux; B2 re-enables _Recognize Molecule_ through the local filter → OCSR → Indigo pipeline and its Ketcher-compatible job shim.

## Overview

| Phase  | Goal                                                   | Depends on               | Outcome                                                         |
| ------ | ------------------------------------------------------ | ------------------------ | --------------------------------------------------------------- |
| **A**  | Remove Imago dependency entirely                       | —                        | Smaller, simpler packages; Imago-free release on all platforms  |
| **B1** | Filter model: molecule present vs. not                 | A (recommended)          | ONNX foundation + classifier endpoint (in progress)             |
| **B2** | OCSR model: image → structure                          | B1                       | Local end-to-end image→molfile (replaces Imago recognition)     |
| **B3** | Remote model delivery from Hugging Face + first-run UX | B2                       | Lightweight installers; on-demand download + progress/setup UI  |
| **C**  | Update Ketcher + enable language selector              | Upstream Ketcher release | Drop local patch; ship Ketcher with i18n/language picker config |
| **D**  | Live local functional review                           | B2/B3 + C as available   | Real-use validation and a prioritized backlog for what’s next   |

> Recommended sequencing: **A → B1 → B2 → B3**, with **C** tracked in parallel and merged whenever the upstream fix ships; **D** runs after the filter + OCSR path is usable locally (and again after B3/C).

---

## A — Remove Imago (fix + release)

**Status: complete (2026-11-10).** Imago is removed end to end (code, routes,
worker, native libs, packaging, CI, docs); _Recognize Molecule_ is hidden until
Phase B. The deb/rpm/AppImage artifacts are rebuilt as part of activity 2
(`purge-imago-artifacts`): the builder image is rebuilt from the patched
`build-libs.sh`, packaging fails fast when forbidden native libs are present, and
the payloads are inspected for Imago/OpenCV leftovers. The measured before/after
package sizes are recorded below.

> Package sizes (before → after), measured on 2026-11-10 with `task packages`
> inside the rebuilt `chemistry-builder` image:
>
> | Artifact | 0.1.0 (Imago era) | 0.1.6 (Imago-free) | Δ bytes     | Δ MB   | Δ %     |
> | -------- | ----------------- | ------------------ | ----------- | ------ | ------- |
> | `.deb`   | 34,340,202        | 19,829,342         | −14,510,860 | −14.51 | −42.26% |
> | `.rpm`   | 34,345,311        | 19,829,798         | −14,515,513 | −14.52 | −42.26% |
> | AppImage | 21,645,816        | 16,955,896         | −4,689,920  | −4.69  | −21.67% |
>
> Each 0.1.6 payload bundles exactly the 21 libraries produced by the builder
> image (`/opt/chemistry/libs`) — `task libs` wipes the directory before copying,
> so nothing else can accumulate — with no `libjpeg*`, `libimago*` or OpenCV
> files.
>
> The 0.1.0 payloads also carried `imago-worker` (382,648 B), `libimago.so`
> (1,937,560 B) and three copies each of `libopencv_core`/`imgcodecs`/`imgproc`.
> The OpenCV libraries alone account for 11,920,920 B deduplicated (35,762,760 B
> as shipped); the full removed set — `imago-worker` + `libimago.so` + OpenCV —
> is 14,241,128 B deduplicated and 38,082,968 B as shipped. Caveat: the delta is
> **not purely Imago** — 0.1.0 → 0.1.6 also includes every other change since
> Oct 31.

**Objective:** eliminate the Imago runtime, worker, routes, build steps, and packaging footprint everywhere, then cut new, lighter builds with Imago artifacts purged.

**Scope / tasks (high level):**

1. **Inventory & removal (code):** remove `ffi::imago` integration (not just stubs), Imago routes (`/v2/imago/*`), `imago-worker` build/bundle, job/status handling, and frontend _Recognize Molecule_ wiring that targets Imago (or gate it behind the new pipeline later).
2. **Build & packaging:** drop Imago native libs from `task libs`/Docker outputs and from `src-tauri/lib/**` packaging; purge `imago-worker` from all bundles (Linux/Windows/AppImage/deb as applicable); verify no `.so`/DLL Imago artifacts remain.
3. **Docs & contracts:** update `docs/architecture.md`, `DEVELOPMENT.md`, `verification.md`, `CHECKPOINTS.md`, and `conventions.md` (e.g., `imago_ops`), and API behavior (`/v2/info` no longer advertises Imago). Remove/retire Imago-specific tests and smoke checks; add/keep smoke tests proving Imago is absent.
4. **Release:** version bump, changelog, green harness (`node scripts/harness.mjs`), produce fresh builds for all targets, and confirm package size reduction (record before/after).

**Definition of done:** no Imago code, binaries, routes, or docs references in shipped artifacts; all targets build green; _Recognize Molecule_ is hidden behind a clear UX state until Phase B (filter + OCSR) lands.  
**Risks/notes:** this temporarily removes image-recognition capability until B2 lands—call it out in the release notes.

---

## B — ML integration: filter + OCSR (3 stages)

**Objective:** replace Imago-based recognition with a two-model ML pipeline — a **filter model** (is there a chemical structure in this image?) and a single **OCSR model** (OCSR = Optical Chemical Structure Recognition, image → SMILES) — introduced incrementally and validated locally before adding remote model delivery. There is **no routing model**: the pipeline does not classify drawings vs. documents, and the OCSR stage does not switch models per input style.

### B1 — Filter model (molecule present vs. not)

**Goal:** given an input image, decide whether it contains a **chemical structure**; reject non-molecule images locally with a user-meaningful result before any OCSR work happens.

**Status: in progress (started 2026-11-11).** Activity 3 (`phase-b1-onnx-filter`) is complete: the ONNX Runtime foundation (`ort` 2.0.0-rc.15, CPU, one intra-op thread, lazy cached sessions, **dynamic runtime loading**), the gitignored `models/` layout with a checksummed manifest, the DECIMER image classifier with `runtime_default` preprocessing, and `POST /v2/filter/classify` (raw image, 10 MiB cap, 400/413/503) are in place. Activity 7 (`ship-onnx-runtime`) delivers the runtime shipment: pinned, SHA-256-verified ONNX Runtime **1.31.0** on Linux (builder image → `task libs`/packages) and Windows (`fetch-windows-libs.ps1`), symlink-preserving `cp -a` copies, host `ORT_DYLIB_PATH` resolution (debug `.ort/<platform>` override → bundled `lib/<platform>`; release bundled), and no link-time dependency. The payloads carry one real `libonnxruntime.so.1.31.0` plus its `.so.1`/`.so` symlinks and the measured size delta is recorded below. Still open: real-input calibration of the threshold, asserting the fixed classifier input names at load time (B3 hardening), and B2 (OCSR + UI wiring).

- Runtime decided: **ONNX Runtime** via `ort` 2.0.0-rc.15, CPU only, loaded dynamically (`load-dynamic` + `ORT_DYLIB_PATH`); no Python and no TensorFlow at runtime. B1 ships the pinned 1.31.0 native library; model weights stay download-only (B3).
- Package-size delta, measured with `task packages` inside the rebuilt `chemistry-builder` image (baseline: runtime-free 0.1.6). The delta is measured after restoring the symlink chain in the deb/rpm payloads; Tauri's resource copier dereferences symlinks, so `scripts/repack-native-payload.sh` repacks them with gzip payloads.

> | Artifact | 0.1.6 (no runtime) | Activity 7 (runtime shipped) | Δ bytes    | Δ MB   |
> | -------- | ------------------ | ---------------------------- | ---------- | ------ |
> | `.deb`   | 19,829,342         | 30,851,320                   | 11,021,978 | 11.022 |
> | `.rpm`   | 19,829,798         | 30,983,791                   | 11,153,993 | 11.154 |
> | AppImage | 16,955,896         | 27,515,384                   | 10,559,488 | 10.559 |
>
> The uncompressed payload grows by 29,345,384 B per Linux artifact (one real
> `libonnxruntime.so.1.31.0`); the `.so.1`/`.so` symlinks add no bytes. The
> compressed delta is smaller (compression + the runtime's 29 MB compress to
> ~11 MB). No model weights are bundled.

- I/O contract: raw image → `contains_molecule`, `category`, `score`, `threshold`, `logit` and a `model` id. Low score means structure (`score <= 0.000089`).
- Local evaluation: the frozen upstream evaluation (binary accuracy 0.7679, AUC 0.603, p50 49 ms / p95 206 ms on CPU) is recorded; a curated chemistry-draw set is still needed to re-calibrate the threshold on real inputs.
- **Known limitation:** binary only — 146 of 250 multi-molecule images (~58%) are classified `no-structure`, and no confidence gate applies.
- **DoD:** deterministic local inference, documented model/version/source, tests/eval passing on positives and negatives, no network dependency.

### B2 — OCSR model → SMILES

**Goal:** full local conversion pipeline: filter-approved image → **SMILES**.

**Status: in progress (started 2026-11-12).** Activity 8
(`phase-b2-ocsr-inference`) delivered the inference foundation: the single-model
decision, the manifest extension, the DECIMER preprocessing, the
encoder/decoder contract, greedy decoding and `POST /v2/ocsr/recognize`,
including the `422` incomplete case. Activity 9 (`phase-b2-recognize-e2e`)
implements the rest: the filter gate, OCSR confidence/incomplete gating,
SMILES → V2000 molfile through Indigo, Ketcher's compatible
`POST /v2/imago/uploads` + `GET /v2/imago/uploads/{id}` job protocol, and the
_Recognize Molecule_ UI with friendly failure dialogs. All activity 9 tasks are
done except the final review, which is pending.

- **Model selection (decided 2026-11-12):** one model, the DECIMER v2
  **hand-drawn FP32** export (`ocsr-handdrawn-fp32`, provenance
  `ocsr-handdrawn@zenodo:10781330`). The hand-drawn export scores **0.7300
  canonical (711/974)** on hand-drawn input and **0.694** on printed input,
  against **0.704** for the printed model; the printed model falls to **0.677**
  on hand-drawn input. Hand-drawn is therefore the better single-model
  compromise for a drawing app: it loses 1.0 pp on printed images instead of
  losing 5.3 pp on hand-drawn ones. **No router**, no per-style switch and no
  ensemble; a second stage would be a roadmap change.
- **Artifacts:** `encoder.onnx` 208,801,677 B (SHA-256
  `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52`),
  `decoder_step.onnx` 107,017,280 B (SHA-256
  `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197`) and
  `vocab.json` 5,316 B. The pair is ~316 MB (~301 MiB), licensed **CC-BY-4.0**
  (Zenodo record 10781330), downloaded locally and never bundled; B3 owns
  delivery. No native library is added, so package size does not change.
- **I/O contract:** `POST /v2/ocsr/recognize` takes a raw PNG/JPEG/WebP image
  (10 MiB cap) and returns `smiles`, `confidence`, `incomplete` and `model`;
  undecodable input is `400`, over-cap `413`, missing/invalid model or runtime
  `503`, and a decode that reaches `max_len` without `end_id` is `422` with an
  actionable message. Confidence is the mean chosen-token probability and the
  single-image endpoint does not gate on it.
- **Recognize compatibility flow (activity 9):** Ketcher's built-in control
  hardcodes `POST /v2/imago/uploads` + `GET /v2/imago/uploads/{id}`. The sidecar
  implements that protocol as a shim — same states, `metadata.mol_str` — with
  no Imago library or worker. The worker runs the filter gate (`no-structure`
  → FAILURE), OCSR (an `incomplete` decode or `confidence < 0.901` → FAILURE),
  then converts the SMILES to a V2000 molfile through Indigo. Jobs run in
  `spawn_blocking`, are in-memory and expire after 10 minutes; unknown ids are
  `404`. `/v2/info` advertises one synthetic `imago_versions` entry
  (`local-ocsr`) because Ketcher disables the control when the list is empty,
  and the `?version=` query is ignored.
- **Confidence threshold:** `confidence_threshold: 0.901` in the manifest is
  **provisional** — it is the in-domain hand-drawn measurement and has not been
  calibrated on real Chemistry Draw inputs. The compatibility pipeline enforces
  it; changing it requires a measured delta plus manifest and docs updates.
- **UI:** _Recognize Molecule_ is visible again. `App.tsx` drops the hidden
  button option and maps no-molecule, low-confidence/incomplete,
  unsupported-image and model-unavailable failures to friendly dialogs with a
  generic fallback; raw JSON never reaches the user.
- **Preprocessing:** `decimer_ocsr`, a separate pipeline from the classifier's
  `runtime_default` (white composite, contrast stretch, BGR2GRAY quirk,
  `Contrast(1.8)`, resize rules, border crop, central square, brightness 1.6,
  512×512 LANCZOS, ImageNet normalization). Tokenizer: skip pad/start/end and
  remap `!$^<>?£¢€§` → `1234567890`.
- **Known limits:** canonical accuracy 0.7300 on the hand-drawn evaluation;
  CPU latency p50 1115 ms / p95 2156 ms; a truncated decode is an error, never
  a partial SMILES. The filter's multi-molecule false negatives (146 of 250,
  ~58%) still apply, so "no molecule" is not proof that no structure exists.
  Session loading is lazy, so startup and health stay fast.
- **DoD:** Recognize Molecule takes a representative hand-drawn or printed image
  through filter → OCSR → molfile and inserts it into the editor; non-molecule
  images and low-confidence/incomplete decodes fail with clear states; missing
  models produce a setup dialog; harness + targeted tests green.

### B3 — Remote model download (Hugging Face) + first-run setup

**Goal:** keep distributables small by fetching the two model weight sets (filter + OCSR) on demand.

- **Model registry/manifest:** pin the **filter** and **OCSR** model IDs, revisions/checksums, sizes, and licenses; download from **Hugging Face** (or mirrored URLs) with integrity verification.
- **Storage & lifecycle:** versioned local cache, resume/retry, offline detection, and a path to update/rollback models.
- **UX:** first-run/setup window (and Settings entry) showing what will be downloaded (filter and OCSR separately), total size, progress, cancel/retry, and disk-space/errors; block recognition gracefully until both models are ready.
- **Privacy & ops:** make network behavior explicit (opt-in/notice as appropriate), log failures for support, and document firewall/offline behavior.
- **DoD:** clean install → guided download → working recognition; corrupted/partial downloads recover; packages no longer bundle heavy model weights.

**Cross-cutting B risks/notes:** model licenses & attribution; runtime footprint (Python/torch vs. lighter runtimes) and its impact on A’s “lighter builds”; GPU/CPU performance; filter false negatives (146 of 250 multi-molecule images classified `no-structure`) and OCSR accuracy on hand-drawn vs. printed input; nondeterminism/accuracy vs. Imago—capture baselines during D.

---

## C — Ketcher update (after upstream fix) + language selector

**Objective:** move to a Ketcher release that includes the `parametrizeUrl` fix and ship with the language selector enabled.

- **Track upstream:** monitor a published `ketcher-core`/`ketcher-react` version containing [epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552) (or equivalent). Periodically check (`pnpm info ketcher-core dist-tags`).
- **Upgrade & depatch:** bump `ketcher-core`/`ketcher-react`, delete `patches/ketcher-core@3.18.0.patch`, remove the `patchedDependencies` entry, and run the full harness plus Recognize/Indigo flows.
- **Language selector:** build/configure Ketcher with the i18n/language picker enabled; verify available locales, persistence (if any), and that it doesn’t regress the custom Indigo base URL wiring.
- **DoD:** no local Ketcher patch; green harness; language selector works in the packaged app.

**Dependency/risk:** blocked on upstream release timing; keep the workaround until a fixed version is verified. Treat as a parallel, merge-when-ready stream.

---

## D — Live local functional review

**Objective:** validate the real user experience and decide the next backlog with evidence.

- **Test matrix (real usage):** structure drawing/editing, Indigo operations (clean/aromatize/convert/layout as applicable), image recognition end-to-end (hand-drawn + printed), error states (no models, bad image, offline), and packaging smoke per target.
- **Compare quality:** spot-check OCSR results vs. expectations (and vs. former Imago behavior where relevant); note failure modes.
- **Non-functional:** startup time, recognition latency, memory/CPU, and installed/download size.
- **Output:** a written findings list → new activities/issues prioritized (bugs, UX gaps, model quality, performance, locales). Optionally repeat a short review after B3 and after C.
- **DoD:** reviewed scenarios documented, regressions filed, and a clear “what’s next” backlog agreed.

---

## Suggested immediate next step

Phase A is complete (Imago removed, lighter artifacts published) and **B1 is in
progress**: activity 7 ships the ONNX Runtime and its measured package-size delta
is recorded above, so what remains is model-gated tests and real-input threshold
calibration. **B2 is in progress**: activity 8 delivered the hand-drawn OCSR
model and `POST /v2/ocsr/recognize`; activity 9 implemented the filter gate, the
SMILES→molfile conversion, the Ketcher `imago/uploads` compatibility job and the
_Recognize Molecule_ UI, with `0.901` as a provisional confidence gate, and is in
review. B3 remote delivery and Phase C stay behind B2, with C merged whenever the
upstream Ketcher fix ships.
