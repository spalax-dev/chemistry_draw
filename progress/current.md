# Current Session

## Activity

- ID: 2
- Name: enforce-docs-test-implement
- Type: chore
- Status: in_progress

## Tasks

- Current: d — final review of the policy enforcement and docs
- Done: a, b, c
- Blocked: Activity 1 (Windows build) awaits a pushed commit and the Windows CI run

## Plan

1. **Docs first**
   - Updated `AGENTS.md`, `README.md`, `docs/testing.md`,
     `docs/conventions.md`, `docs/verification.md`, `docs/CHECKPOINTS.md`,
     `docs/DEVELOPMENT.md`, `docs/architecture.md` and all three agent role
     files.
   - Defined the task `phase` field and the mandatory order
     docs → test → implement → review, including the docs-only exception.

2. **Tests**
   - Added `scripts/lib/activity-policy.test.mjs` with phase-order, docs-only,
     agent-mapping, status-cardinality, sequential-status and negative cases.
   - RED was confirmed before the validator existed; the suite now has 29 tests.

3. **Implementation**
   - Added `scripts/lib/activity-policy.mjs` with `validateActivities`.
   - A task may be `done` or `in_progress` only after every earlier task is
     `done`, in addition to the non-decreasing phase check.
   - `scripts/harness.mjs` runs the policy tests and validator in block 3.
   - `package.json` exposes `pnpm run test:policy`.

4. **Review**
   - Reviewer requested targeted test/status/heading fixes; they are applied.
   - Final review is in progress.

## Notes

- The user requested docs → test → implement as a permanent rule.
- Activity 1 remains `blocked` until its Windows CI job runs; its task list
  declares docs/test/implement/review phases.
- Harness is green with two activities; 29 policy tests pass.
- No commit or push has been made.

## Blockers

- Activity 1: Windows CI needs a pushed commit.
- Activity 2: final review completion.
