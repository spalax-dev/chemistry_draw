# 0007 — Maintain two repository lines

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code and git history on 2026-11-21)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

The repository does not have one product line. It has two:

- **`main` (0.x)** is what users run today. It carries the backstage welcome
  view, templates, recent structures, project opens, the File menu, editor tabs
  and the close/discard workflow. It is also where the Ketcher/Indigo/language
  upgrade (E1) belongs. At the time of writing it had 16 commits not on
  `develop`.
- **`develop` (1.x)** is the integration line for the next generation. It carries
  the Imago removal, the native Indigo sidecar with the B1 filter, B2 OCSR, B3
  model delivery, the NuGet runtime source and the Phase D parity work. It had 24
  commits not on `main`.

Both lines share the Tauri shell, the sidecar boundary and the document contract,
but they are not interchangeable: `main` has UI and file-workflow work `develop`
does not, and `develop` has ML and packaging work `main` does not. A naive merge
would either ship unfinished ML work as a 0.x patch or drop the backstage
workflow from 1.x.

## Decision

Maintain the two lines explicitly.

1. **Two roles.** `main` is the 0.x maintenance/support line; `develop` is the
   1.x integration line. Do not add ML/1.x work to `main`; do not treat `develop`
   as the 0.x support line.
2. **Branch from the target line** and merge back to the same line. A
   main-targeted change is never based on `develop`.
3. **No cross-merge** unless the user explicitly asks. Port an individual change
   with a cherry-pick and preserve each line's content.
4. **E1 is main-only.** The Ketcher/Indigo/language upgrade stays on `main` and is
   not merged into `develop`; the 1.x line adopts it as its own integration
   (US-07).
5. **Record the base branch** in the session/story state before starting.
6. The official launch will eventually **unify the lines**. That is a future
   decision with its own ADR: which line is the base, how the backstage/file
   workflow meets the ML toolbar, how users migrate and what happens to app-data
   are not decided here.

## Alternatives considered

| Alternative                                  | Why not                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Single trunk (`main`) for everything         | Forces unfinished 1.x ML work on 0.x users and blocks maintenance releases behind it            |
| Merge `develop` into `main` now              | Conflicts across the UI and ML surfaces, and the 1.x line is not release-ready (Phase D/E open) |
| Abandon `main` and support only `develop`    | Users on 0.x lose fixes and releases; the backstage/file workflow would have no maintained home |
| Publish 1.x as a separate product/repository | Duplicates packaging, CI and the shared shell; the eventual launch is meant to be one product   |
| Cherry-pick the entire ML stack into `main`  | Same as shipping 1.x early, with a larger conflict surface                                      |

## Consequences

- **Positive:** 0.x users keep receiving maintenance and the backstage workflow;
  the 1.x line can change the recognition stack without destabilising the support
  line; the rule makes porting deliberate instead of accidental.
- **Negative:** fixes can be needed twice; contributors must know which line they
  are on; the foundation, the backlog and the release gate must name the target
  line for every story; there is no single "current product" branch until launch.
- **Follow-up:** every story names its target line. US-01 performs the 1.x
  update from `main` (the 0.1.8 baseline, backstage/file workflow, layout and
  release policy) as a deliberate port under ADR 0009; it is not a background
  merge and it does not import Imago. The launch remains 1.0.0, and retiring the
  0.x line is still a separate launch decision. E1's parked work on
  `wip/e1-develop-based` and `phase-e1-ketcher-indigo` is not adopted until
  US-07, which redoes the upgrade on `develop`.

## References

- `AGENTS.md` and `docs/DEVELOPMENT.md` — branch model.
- `docs/ROADMAP.md` Phase E — ordering, the E1 line note and the release gate.
- `docs/RELEASING.md` — SemVer and line rules.
- `docs/planning/overview.md` §6 — the two lines.
- Related ADRs: 0005 (patch removal on upgrade), 0008 (harness migration).
