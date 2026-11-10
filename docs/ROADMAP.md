# Chemistry Draw — Roadmap

> Living on the `develop` branch. Grounded in the current state of the repo (Nov 2026): Tauri v2 shell + `ketcher-react/core` 3.18.x (patched for `parametrizeUrl`; upstream fix tracked in [epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552)), and a local Rust sidecar exposing **Indigo only**. Windows and Linux both ship Indigo-only builds; _Recognize Molecule_ is hidden until Phase B (DECIMER) lands.

## Overview

| Phase  | Goal                                                     | Depends on               | Outcome                                                         |
| ------ | -------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| **A**  | Remove Imago dependency entirely                         | —                        | Smaller, simpler packages; Imago-free release on all platforms  |
| **B1** | ML router: drawing vs. document                          | A (recommended)          | Local model, validated on sample images                         |
| **B2** | DECIMER pipeline: classifier + handdraw/printed → SMILES | B1                       | Local end-to-end image→SMILES (replaces Imago recognition)      |
| **B3** | Remote model delivery from Hugging Face + first-run UX   | B2                       | Lightweight installers; on-demand download + progress/setup UI  |
| **C**  | Update Ketcher + enable language selector                | Upstream Ketcher release | Drop local patch; ship Ketcher with i18n/language picker config |
| **D**  | Live local functional review                             | B2/B3 + C as available   | Real-use validation and a prioritized backlog for what’s next   |

> Recommended sequencing: **A → B1 → B2 → B3**, with **C** tracked in parallel and merged whenever the upstream fix ships; **D** runs after the DECIMER path is usable locally (and again after B3/C).

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

**Definition of done:** no Imago code, binaries, routes, or docs references in shipped artifacts; all targets build green; _Recognize Molecule_ is hidden behind a clear UX state until Phase B (DECIMER) lands.  
**Risks/notes:** this temporarily removes image-recognition capability until B2 lands—call it out in the release notes.

---

## B — DECIMER ML integration (3 stages)

**Objective:** replace Imago-based recognition with a DECIMER-based ML pipeline, introduced incrementally and validated locally before adding remote model delivery.

### B1 — Router model (drawing vs. document)

**Goal:** given an input image, classify whether it is a **chemical drawing/structure** or a **document/other**; run locally and prove accuracy on a small curated test set.

- Select/integrate the router model and define its runtime (Python sidecar/process, ONNX, or other—pick one and document it).
- Define the I/O contract (image in → label + confidence).
- Add local evaluation: sample set, metrics/thresholds, and a repeatable test script.
- **DoD:** deterministic local inference, documented model/version/source, tests/eval passing, no network dependency.

### B2 — DECIMER classifier + handdraw/printed → SMILES

**Goal:** full local conversion pipeline.

- **DECIMER classifier (pre-filter):** runs before/with routing to determine whether a molecule is present; reject/short-circuit non-molecule images with a user-meaningful result.
- **Core OCSR:** integrate **DECIMER handdrawn** and **DECIMER printed** models to produce **SMILES** from the image (choose model based on router/classifier or an ensemble rule; document the decision).
- Wire into the app flow that previously used Imago (sidecar endpoint or equivalent internal service), returning SMILES/structure compatible with Ketcher.
- Local-only for now; include error handling, timeouts, and basic performance notes.
- **DoD:** image → (presence/routing) → SMILES works locally for representative hand-drawn and printed cases; harness + targeted tests green; UX shows clear success/failure states.

### B3 — Remote model download (Hugging Face) + first-run setup

**Goal:** keep distributables small by fetching large model weights on demand.

- **Model registry/manifest:** pin model IDs, revisions/checksums, sizes, and licenses; download from **Hugging Face** (or mirrored URLs) with integrity verification.
- **Storage & lifecycle:** versioned local cache, resume/retry, offline detection, and a path to update/rollback models.
- **UX:** first-run/setup window (and Settings entry) showing what will be downloaded, total size, progress, cancel/retry, and disk-space/errors; block recognition gracefully until required models are ready.
- **Privacy & ops:** make network behavior explicit (opt-in/notice as appropriate), log failures for support, and document firewall/offline behavior.
- **DoD:** clean install → guided download → working recognition; corrupted/partial downloads recover; packages no longer bundle heavy model weights.

**Cross-cutting B risks/notes:** model licenses & attribution; runtime footprint (Python/torch vs. lighter runtimes) and its impact on A’s “lighter builds”; GPU/CPU performance; nondeterminism/accuracy vs. Imago—capture baselines during D.

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
- **Compare quality:** spot-check DECIMER results vs. expectations (and vs. former Imago behavior where relevant); note failure modes.
- **Non-functional:** startup time, recognition latency, memory/CPU, and installed/download size.
- **Output:** a written findings list → new activities/issues prioritized (bugs, UX gaps, model quality, performance, locales). Optionally repeat a short review after B3 and after C.
- **DoD:** reviewed scenarios documented, regressions filed, and a clear “what’s next” backlog agreed.

---

## Suggested immediate next step

Start with **Phase A (Imago removal)** as a focused, shippable milestone: the product decision for _Recognize Molecule_ is settled (hidden with a clear UX state until Phase B), then execute A as `docs → test → implement → review` tasks tracked in `activities.json`, and cut the lighter Imago-free release. In parallel, spike **B1** model/runtime selection so B2 has a settled foundation.
