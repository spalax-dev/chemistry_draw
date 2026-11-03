# Session History

> Append-only log of completed sessions/activities.

---

## 2026-11-03 — Activity 2: docs → test → implement enforcement

- Added `scripts/lib/activity-policy.mjs` and 32 policy tests; harness block 3
  runs them and validates `activities.json`.
- Documented the mandatory docs → test → implement → review order, the
  `phase` field, the docs-only exception and strict sequential status in
  `AGENTS.md`, `README.md`, `docs/` and all agent prompts.
- `node scripts/harness.mjs` green; Linux sidecar 87 tests pass.
- Activity 1 (Windows build) remains blocked on its Windows CI run.
