# Harness Structure

> Where every harness file lives, what belongs in each folder, and how to add
> one. Product code layout is in `docs/planning/structure.md`.

---

## 1. Tree

```text
AGENTS.md                          entry point and contract
BACKLOG.md                         user stories (tracked)
activities.json                    activities of the active story (local)
.harness/state.json                stage (tracked)
.harness/schedule.json             computed batches (local)
.harness/claims/                   active executor claims (local)
.harness/approvals.json            recorded user approvals (local)
.opencode/agent/                   orchestrator and executor roles
.opencode/plugins/                 harness-guard protocol enforcement
docs/planning/                     product foundation (tracked)
docs/harness/                      harness contract and policy (tracked)
scripts/harness.mjs                engine
scripts/harness-lib.mjs            pure scheduling/backlog logic
scripts/harness-lib.spec.mjs       engine logic tests
scripts/build_harness.mjs          local-state bootstrap
progress/current.md                live session (local)
progress/history.md                durable record (tracked)
progress/explore/                  research notes
docs/generated/                    generated documentation (ignored)
```

| Path                           | Holds                                              |
| ------------------------------ | -------------------------------------------------- |
| `AGENTS.md`                    | Entry point and hard rules                         |
| `BACKLOG.md`                   | User stories                                       |
| `activities.json`              | Activities of the active story (local)             |
| `.harness/state.json`          | Stage (tracked)                                    |
| `.harness/schedule.json`       | Computed batches (local)                           |
| `.harness/claims/`             | Active executor claims (local)                     |
| `.harness/approvals.json`      | Recorded user approvals (local)                    |
| `.opencode/agent/`             | Orchestrator and executor roles                    |
| `.opencode/plugins/`           | `harness-guard.js` protocol enforcement            |
| `docs/planning/`               | Foundation: overview, architecture, stack, C4, ADR |
| `docs/harness/`                | How verification and the harness work              |
| `scripts/harness.mjs`          | Engine                                             |
| `scripts/harness-lib.mjs`      | Pure scheduling/backlog logic                      |
| `scripts/harness-lib.spec.mjs` | Engine logic tests                                 |
| `scripts/build_harness.mjs`    | Bootstrap of local state                           |
| `progress/current.md`          | Live session (local)                               |
| `progress/history.md`          | Durable record (tracked)                           |
| `progress/explore/`            | Research notes                                     |
| `docs/generated/`              | Generated documentation site (ignored)             |

Product code lives in `src/`, `src-tauri/src/` and `src-tauri/sidecar/`; its
tree is documented in `docs/planning/structure.md`. Generated output lives under
`build/`, `target/`, `dist/`, `models/`, `.ort/` and `src-tauri/lib/`.

---

## 2. Dependency direction

```text
BACKLOG.md  ->  activities.json  ->  schedule  ->  executors  ->  gates
                     ^                                  |
                     |                                  v
              user approval  <--  progress/history.md  <-  progress/current.md
```

- `BACKLOG.md` is user-owned.
- `activities.json` is derived from one story and is orchestrator-owned.
- The schedule is computed, never hand written.
- Executors only write inside their `touches`.
- Gates prove the result; the user approves it.

---

## 3. Adding a file

| File kind             | Home                                   | Rule                                      |
| --------------------- | -------------------------------------- | ----------------------------------------- |
| Harness command       | `scripts/harness.mjs`                  | Add the flag to `printHelp` and the tests |
| Pure logic            | `scripts/harness-lib.mjs`              | Unit test in the spec file first          |
| Orchestrator behavior | `.opencode/agent/main-orchestrator.md` | Keep state ownership and branch rules     |
| Executor behavior     | `.opencode/agent/task-executor.md`     | Keep the document/test/implement loop     |
| Planning artifact     | `docs/planning/`                       | Stories stay in `BACKLOG.md`              |
| Decision              | `docs/planning/adr/`                   | One decision, indexed                     |
| Harness policy        | `docs/harness/`                        | Keep this file true                       |

If a file does not fit, the structure is wrong, not the folder.

---

## 4. Forbidden

- A hand-written feature spec next to the code (docstrings are the source).
- Generated docs edited by hand or committed.
- State files written by an executor.
- A second harness entry point.
- A batch executed serially.
- A story closed without recorded approval.
- A git worktree, or a branch based on the wrong support line.
- Vendored native libraries, ONNX Runtime, or model weights.

---

## 5. Definition of done

- [ ] The file lives in its documented home.
- [ ] The engine change has a unit test.
- [ ] The docs that describe the tree are still true.
- [ ] `node --test scripts/harness-lib.spec.mjs` is green.
