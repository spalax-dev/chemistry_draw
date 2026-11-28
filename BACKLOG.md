# Backlog

> User stories live here. Write them coarse: a want, the value behind it, and the
> acceptance bullets you already know. Open questions are expected.
>
> The orchestrator derives activities and tasks from a story **only after you
> pick it**. Do not pre-decompose the whole backlog.
>
> Status: `pending` | `active` | `awaiting-approval` | `done` | `dropped`
> Exactly one story may be `active` at a time.
>
> **No story is active right now (2026-11-21).** These stories come from the open
> work in `docs/ROADMAP.md` Phase D and E, not from the old activity list. Every
> story targets the `develop` 1.x line unless it says otherwise. The 0.x line's
> own maintenance (E1 on `main`) is not a 1.x story; US-07 is the 1.x adoption of
> that upgrade.

---

## US-01 — Bring the backstage and file workflow into 1.x

- status: done
- value: Users of the 1.x line get the welcome/backstage experience from `main` (real templates, recent structures, project opens, a File menu and editor tabs) on top of the ML/B3 toolbar, instead of a bare editor.
- acceptance:
  - the backstage view, real templates, recent structures, project opens, File menu, tabs and close/discard flow work on the 1.x line
  - the custom Save, New, Export and Models entries coexist with the new UI without overlap or lost shortcuts
  - `.ket` save, Save As, Export, autosave and recovery contracts are unchanged
  - conflicts between `main`'s workflow and the 1.x recognition/model setup state are resolved deliberately, not by dropping either side
  - the affected planning docs and C4/sequence diagrams are updated
  - the 0.1.8 baseline from `main` (version files, backstage/file workflow,
    build layout, screenshots and release policy) is reconciled into 1.x
    without importing Imago product code; the launch version remains 1.0.0
- open questions:
  - is the backstage workflow required for the official launch, or can 1.x ship without it?
  - does this land before or after US-07 (Ketcher 3.21/Indigo 1.49), and should the backstage be ported onto 3.18 first?
  - which parts of the `main` work are UI-only and which depend on the E1 build?
  - this is the 1.x update from `main`; no 0.x release is re-cut by it.

## US-02 — Make performance measurable and gated

- status: pending
- value: The team can tell whether a change makes startup, drawing or recognition slower, instead of relying on one-off measurements.
- acceptance:
  - repeatable measurements exist for startup, drawing/Indigo operations, filter and OCSR latency (p50/p95), memory/CPU, and install/download size
  - the measurement reuses `scripts/model-parity.mjs` and the Phase D pilot where possible
  - a baseline is recorded and regression thresholds are defined
  - the thresholds run in a documented gate (CI or a recorded manual run) without making normal iteration slow
  - the numbers replace the ad-hoc latency findings in the docs
  - the first recognition's cold OCSR pair load is measured separately from warm
    inference (observed ~92 s on the 2026-11 close machine); if it dominates, a
    warm-up or session-reuse decision is recorded
- open questions:
  - which machine class defines the baseline, and how is hardware variance handled?
  - are thresholds enforced in CI (cost, flakiness) or checked before a release?
  - is recognition latency measured on first use (session load) or warm only?
  - should the OCSR pair preload at startup or on model install instead of on the
    first Recognize?

## US-03 — Refactor the frontend and ship the small UI fixes

- status: pending
- value: The 1.x codebase becomes easier to navigate and maintain, and the accumulated small UI fixes from `main` reach 1.x users.
- acceptance:
  - the `main` folder/code restructure is ported without changing the ML sidecar contracts or the B3 model flow
  - the ported performance work and small UI fixes are in place
  - the Phase D parity evidence and the recognition behaviour are unchanged, or the difference is measured and documented
  - commits use `refactor`/`perf`/`fix` as appropriate
  - `docs/planning/structure.md` describes the resulting tree
  - the full harness is green
- open questions:
  - which UI fixes are in scope, and which belong to the rebranding story?
  - does the restructure include moving `target/`/`dist/` under `build/` (the Phase 2 note in `docs/DEVELOPMENT.md`)?
  - is this a straight port from `main`, or a rewrite against the 1.x tree?

## US-04 — Validate Windows and Linux packages and add Playwright coverage

- status: pending
- value: A release is proven on the platforms users install, and the file workflow, backstage, model setup and recognition states get repeatable integration coverage.
- acceptance:
  - the packaged app is installed and exercised on Windows and on a Linux VM: first run, model download/verify/repair, drawing, Indigo operations, recognition success and failure, offline/errors, uninstall
  - Playwright integration tests cover the file workflow, backstage, Models dialog and recognition states
  - the heavier packaged checks stay manual or gated instead of slowing every run
  - findings are filed as stories or fixed, and the evidence is recorded
- open questions:
  - does Playwright drive the dev server, the packaged app, or both?
  - which runners are available for a Windows/Linux VM test, and at what cost?
  - which recognition states are stable enough for automated tests (real model vs. fixture)?

## US-05 — Rebrand the product before launch

- status: pending
- timing: **Part of 1.x.** Finish the functional product first; rebranding is the
  final step before the official launch. It is independent of model delivery: no
  model change is involved.
- value: The app ships with its final name, icon and identity instead of the provisional Chemistry Draw packaging.
- acceptance:
  - name, icon set, bundle identifiers, installer metadata, app-data path, docs/site and About sources use the final identity
  - if the app-data path changes, the autosave/packaging consequence is handled as a
    separate decision; there is no model-delivery change
  - the change is marked breaking in the commit and release notes
  - packaging for every target is rebuilt and smoke-tested
  - attribution for Ketcher and the models remains correct
- open questions:
  - what is the final name and bundle identifier?
  - does the app-data path change? If so, how are autosave snapshots handled?
  - start only after the functional product is complete; this is the final pre-launch step.

## US-06 — Improve logs and user feedback

- status: pending
- value: Support can diagnose a report from the logs and diagnostics, and users get consistent, actionable error and feedback copy.
- acceptance:
  - app and sidecar logs are structured and cover lifecycle, model state and recent errors
  - a support diagnostic view or export reports version, model state, runtime and recent errors
  - user-facing error/feedback copy is consistent with the Models dialog and recognition errors
  - no secrets, images or document content are logged
  - the log rotation and location stay documented
- open questions:
  - where do users send feedback, and is there an in-app channel?
  - what is the diagnostic export format and does it need redaction rules?
  - should logs be opt-in for sharing, or is manual attachment enough?

## US-07 — Adopt Ketcher 3.21 and Indigo 1.49 on 1.x

- status: awaiting-approval
- value: The 1.x line adopts stable Ketcher 3.21.0 and Indigo 1.49.0 with the narrowed `parametrizeUrl` patch (3.21.0 does **not** contain the upstream fix; the ReBond fix is upstream), plus the source-built multi-language `ketcher-react` tarball (committed) and its own ADR. Redo on `develop`; do not merge the parked main E1.
- acceptance:
  - `ketcher-core`/`ketcher-react` are exactly 3.21.0; `ketcher-react` comes from the committed vendor multi-language tarball; the 3.18 patch is replaced by a narrowed 3.21.0 `parametrizeUrl`-only patch (no ReBond hunk); the explicit Indigo port survives
  - Indigo is pinned to `indigo-1.49.0` on Linux and Windows and `/v2/info` reports 1.49.0 consistently
  - the language selector works in the packaged app and does not regress the sidecar API base wiring
  - the toolbar, dialog, option-store and recognition contracts still work on 3.21, or the adaptations are documented
  - the full harness, Recognize/Indigo flows and packaged smoke are green
- open questions:
  - the 3.21 stable release does not contain the `parametrizeUrl` fix; keep the narrowed patch until a stable 3.22 (ADR)
  - the vendor `ketcher-react` tarball becomes a sanctioned source build with an ADR
  - the parked `wip/e1-develop-based` prototype is reference only; redo the upgrade on `develop`

## US-08 — Calibrate the filter/OCSR thresholds with real inputs

- status: pending
- value: The classifier threshold (`0.000089`) and the OCSR confidence gate (`0.901`) are provisional; a measured calibration on real inputs replaces guesswork with evidence.
- acceptance:
  - a labelled dataset with provenance/licensing is recorded; positives and negatives are both represented
  - the classifier score distribution is measured and the threshold is chosen against a documented metric (not per-image tuning)
  - the OCSR confidence gate is measured against real outputs and either retained or changed with evidence
  - the chosen values are recorded in the manifest/catalog and docs; the frozen benchmark set stays separate from the calibration set
  - a repeatable script/command and the before/after table are recorded
- open questions:
  - where does the labelled set come from, and what licence allows it?
  - which metric decides the threshold (balanced accuracy, F1, false-negative cost)?
  - is the OCSR gate informational only, or should it reject low-confidence results?

## US-09 — Align the product docs and harness references

- status: pending
- value: Remove the v1 workflow references and stale statuses so the docs match the two-stage harness and the shipped product.
- acceptance:
  - `docs/DEVELOPMENT.md`, `docs/verification.md`, `docs/CHECKPOINTS.md` and `docs/conventions.md` stop referencing the deleted activity policy/reviewer and point to `docs/harness/`
  - the README `CONTRIBUTING` link points to `docs/CONTRIBUTING.md`
  - the ROADMAP B1/B2/B3 and architecture B3 status blocks match the completed work and clearly label the provisional/live numbers
  - no dead commands or old workflow names remain in the product docs
- open questions:
  - which product docs stay as product references and which move to `docs/harness/`?
  - should this land before US-01 so the 1.x docs are coherent?

## US-10 — Fix packaging and tooling drift

- status: pending
- value: The packaged frontend and the tested frontend use the same Node/toolchain, and the Tauri capability set matches the in-app dialog policy.
- acceptance:
  - the packaging Dockerfile uses the same supported Node major as CI/docs (22), or the difference is justified and tested
  - the unused `dialog:allow-message` capability is removed or its need is documented against the in-app dialog rule
  - the package/clean-install gates are green after the change
- open questions:
  - does the builder image need a Node pin bump, or only the Dockerfile install step?
  - is `dialog:allow-message` ever needed for a native flow?

## US-11 — Ship a self-contained, offline-first Linux AppImage

- status: pending
- target: **`main` (0.x).** Release packaging for the 0.x line; not a 1.x story.
  Only port it here if 1.x keeps the AppImage target.
- value: The 0.1.x/0.2.x AppImage runs on a machine that does not have WebKitGTK
  4.1 installed and survives starting without network, so it can be handed to
  reviewers — and eventually listed in an AppImage catalog — instead of staying a
  test-only artifact.
- context: an AppImage catalog test rejected `chemistry-draw_0.1.8_amd64.AppImage`.
  The binary links against the system `libwebkit2gtk-4.1.so.0` and glibc 2.36 and
  aborts during startup under firejail (`error while loading shared libraries`).
  The sidecar and the native Indigo/Imago libraries are already bundled
  (`scripts/bundle-libs.sh`); WebKitGTK and its dependency tree are not.
- acceptance:
  - the AppImage starts on a clean system without `libwebkit2gtk-4.1` installed,
    and no unresolved library remains in the AppDir
  - the glibc floor the AppImage requires is documented, and no symbol above it
    is required
  - the app shows its window (or a clear message) before contacting the sidecar,
    and a failed or unavailable sidecar does not terminate it
  - a sandboxed no-network start is verified, not assumed
  - the size increase and the update path from the previous release are recorded
  - the full harness is green
- open questions:
  - bundle the full WebKitGTK stack (large; drags in GLib/GIO network helpers) or
    require a documented distro floor?
  - can the local sidecar be reached when the sandbox has no network at all, or
    must startup be independent of it?
  - is a catalog listing actually wanted before 1.0, or is the AppImage only for
    reviewers until then?
  - is this worth doing on 0.x at all, or should it be solved once for 1.0?

---

## How to add a story

1. Append a `## US-00N — Title` section.
2. Fill `status`, `value`, `acceptance` and `open questions`.
3. Do not write activities or tasks here; that is the orchestrator's job.
4. Name the target line in `value` when it is not `develop`.
