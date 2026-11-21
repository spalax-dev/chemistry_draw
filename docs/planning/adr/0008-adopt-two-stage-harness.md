# 0008 — Adopt the two-stage harness

- **Status:** accepted
- **Date:** 2026-11-21
- **Activity:** harness migration (pre-development)
- **Deciders:** Repository owner; OpenCode harness migration

## Context

The repository used a single-stage harness: typed tasks, task-scoped verification
levels, an agent reviewer, and no written foundation. That model had three costs:

- review was a full agent run that still did not carry the user's judgment;
- TDD was applied to requirements that were not understood yet, so a test could
  encode a guess;
- independent activities were executed serially, and the documentation lived
  outside the code.

The codebase already exists and is large: a Tauri host, a Rust sidecar with
native Indigo and ONNX, a patched Ketcher frontend, packaging scripts and measured
benchmarks. The foundation has to be reconstructed from that code, not invented.
Two lines are in flight (ADR 0007), and parked E1 prototypes exist on their own
branches.

## Decision

Adopt the two-stage harness.

1. **PLANNING** produces `docs/planning/**`, the C4 and sequence diagrams, the
   ADRs and a coarse `BACKLOG.md`. No code, no tests. An existing codebase still
   starts in planning so the foundation is written before new work.
2. **DEVELOPMENT** derives activities from the selected story only, schedules
   them in parallel batches by `dependsOn` + `touches`, documents first (ADR and
   docstrings), applies TDD inside the story, and closes only with recorded user
   approval.
3. A **documentation generator** is mandatory: `scripts/docsgen.sh` runs TypeDoc
   for the frontend and rustdoc for both Rust crates; generated output is build
   output, never source.
4. The **`harness-guard` plugin** enforces the planning lock, batch claims and
   write scope. State files are orchestrator-only.
5. A new engine (`scripts/harness.mjs`, `scripts/harness-lib.mjs`) replaces the
   v1 task-scoped scripts; `progress/history.md` is preserved and old activities
   are archived, not imported.

The migration runs on branch `harness/two-stage`, based on `develop` (the line
this foundation describes). It does not merge, rewrite git history or delete the
session history.

## Alternatives considered

| Alternative                                               | Why not                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Keep v1 and add planning docs                             | The old levels and reviewer survive; two workflows compete and the planner is still optional |
| Adopt the model only for new modules                      | The inconsistency becomes permanent and the old gates stay                                   |
| Pre-decompose the whole backlog during migration          | Repeats the failure mode the model exists to prevent: activities without an understood story |
| Rewrite the repository history to a clean two-stage start | Destroys the durable record and the two-line history; not necessary for the model            |
| Skip the documentation generator until later              | PLANNING cannot close without it, and retrofitting docblocks to a mature codebase is harder  |

## Consequences

- **Positive:** user-owned decisions, less review time, real parallelism from
  `--schedule`, and documentation that follows the code. The reconstructed
  foundation makes the implicit 1.x architecture reviewable.
- **Cost:** the foundation had to be reconstructed and approved before any new
  work; legacy docstring debt needs a visible baseline and a story, not a
  disabled rule; v1 aliases (`--for-task`, `harness:task`) must disappear from
  scripts and docs.
- **Follow-up:** burn down `docs/harness/docblock-baseline.txt`; keep
  `BACKLOG.md` coarse and let the orchestrator decompose only the selected story;
  do not convert the parked E1 prototypes into activities — they are US-07.

## Migration notes

- `progress/history.md` is preserved; old activities are archived, not imported.
- Reconstructed planning documents are labelled with their reconstruction date
  (2026-11-21).
- In-flight work is finished under the old harness or re-planned as a story; it is
  never converted automatically. The E1 branches remain parked and untouched.
- The two-line branch model (ADR 0007) still applies during and after the
  migration; this branch is based on `develop`.

## References

- `docs/planning/overview.md`, `docs/planning/architecture.md`,
  `docs/planning/contracts.md`.
- `BACKLOG.md` — the coarse stories.
- `scripts/harness.mjs`, `scripts/harness-lib.mjs`, `.opencode/plugins/`.
- Related ADRs: 0001 (record decisions), 0007 (two lines).
