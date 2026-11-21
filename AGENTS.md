# AGENTS.md — Chemistry Draw

> Agent navigation map. Read only what you need (progressive disclosure).

## Workflow order (mandatory): docs → test → implement → review

Every activity declares tasks with a `phase` field and executes them in this
order. `node scripts/harness.mjs` rejects activities missing a phase or with
phases out of order.

1. **docs** — update the documentation first (`README.md`, `docs/`): it defines
   the contract before code exists.
2. **test** — add the failing test and confirm RED.
3. **implement** — minimal code to make it pass, confirm GREEN, then refactor.
4. **review** — the reviewer verifies docs, test, implementation and the green
   harness.

Docs-only activities (`type: "docs"`) may run just `docs` → `review`; they must
not contain `test` or `implement` tasks.

## Before start

1. `node scripts/harness.mjs` — must end green. If it fails, **STOP** and
   resolve the environment first.
2. If it reports missing files, run `node scripts/build-harness.mjs` — it
   recreates the tracking files (`activities.json`, `progress/`), not docs.
   Missing docs are restored from git.
3. Read `progress/current.md` (session state) and `activities.json` (pending
   activities/tasks).
4. Read `docs/architecture.md` before implementing and `docs/conventions.md`
   before writing code.
5. Delegate ONE task from ONE pending activity. **Never work directly — always
   delegate.**

## Branch model (mandatory)

Chemistry Draw has two maintained lines; choose the target line before creating
any branch or worktree:

- **`main` — 0.x maintenance/support.** The line users run today: bug fixes,
  maintenance upgrades (including the Ketcher/Indigo/language E1) and releases.
  Do not add the ML/1.x work to `main`.
- **`develop` — 1.x integration.** Imago removal, ONNX/models/OCSR, NuGet and
  the 1.x path. It is not the 0.x support line.

Rules:

- Create the activity's branch/worktree from the **target line**: `main` for a
  0.x maintenance activity, `develop` for 1.x. **Never** base a main-targeted
  activity on `develop`.
- Merge the activity back to the same line. Do not cross-merge
  `main`/`develop` unless the user explicitly asks; port an individual fix with
  a cherry-pick and preserve each line's content.
- Record the base branch in `progress/current.md` and the activity before
  starting.
- Reference: the build-layout activity was based on `main`, merged to `main`,
  then ported to `develop`. E1 is main-only; it is not merged into `develop`.

## Repo map

| Path                                          | When read                 |
| --------------------------------------------- | ------------------------- |
| `activities.json`, `progress/current.md`      | always, at start          |
| `progress/history.md`                         | need past context         |
| `docs/architecture.md`                        | before implement          |
| `docs/conventions.md`                         | before write code         |
| `docs/testing.md`                             | before writing tests      |
| `docs/verification.md`, `docs/CHECKPOINTS.md` | before declaring done     |
| `scripts/harness.mjs`                         | verification gate         |
| `scripts/lib/activity-policy.mjs`             | activity/phase validator  |
| `scripts/lib/activity-policy.test.mjs`        | phase-policy tests        |
| `src/`, `src-tauri/src/`                      | frontend / Tauri host     |
| `src-tauri/sidecar/`                          | Indigo/Imago HTTP sidecar |
| `scripts/`                                    | native libs + packaging   |

- All paths relative to repo root. No absolute paths, no `../`.

## Hard rules

- **docs → test → implement → review** — no implementation before its failing
  test, and no test before its docs. The harness enforces the task phases
  (`scripts/lib/activity-policy.mjs`).
- **One task at a time**; don't mix activities. Tasks execute sequentially; only
  one task may be `in_progress`, and no later task may start before every
  earlier task is `done`.
- **No `done` without green harness** — `node scripts/harness.mjs` all green
  (includes typecheck, ESLint, Prettier, rustfmt, Clippy and ShellCheck).
- Document in `progress/current.md` **while** working, not after. Include plan +
  task breakdown.
- If unsure, check `docs/` before inventing. If a tool misbehaves, log it in
  `progress/current.md` and stop — no workarounds.
- Never commit `src-tauri/lib/`, `target/`, `dist/`, `build/` or any
  `.so` file.
- **Documents are `.ket`**: Save/Save As write `.ket` only; Export is the sole
  route to Molfile, SMILES, InChI, SVG and PNG and never changes the document
  path or format.
- **Documents live in tabs**: one Ketcher instance, tab state in `src/tabs.ts`,
  per-tab snapshots under `recovery/tabs/`, restored silently on launch.
- Native Indigo/Imago are generated with `task libs` (Docker). They are never
  vendored.

## Activities

- Types: `fix` (bug), `feat` (feature), `chore` (refactor/config/deps), `docs`.
- Schema (see `.opencode/agent/main-orchestrator.md`):
  `{id, type, name, title, description, acceptance[], tasks[], status}`.
- Each task is `{id, phase, description, status, agent}`, where `phase` is
  `docs | test | implement | review`. The policy validator enforces the phase
  order and the agent mapping (`review` → `reviewer`, the rest →
  `implementer`).

## Delegation

| Agent                     | Use for                         |
| ------------------------- | ------------------------------- |
| `task-executor`           | implementation                  |
| `implementation-reviewer` | validate before done            |
| explore                   | fast codebase search (subagent) |
| general                   | multi-step research (subagent)  |

Flow: open `activities.json` → pick a `pending` task → delegate → set task
`in_progress` → annotate `progress/current.md` (activity, task, start time).

## Session close

1. Harness all green.
2. Mark task/activity `done` in `activities.json` (activity only when all tasks
   are done).
3. Move the summary from `progress/current.md` to the end of
   `progress/history.md`, then reset `current.md` to the template
   (`node scripts/build-harness.mjs` does not overwrite it — restore it by
   hand or from `scripts/build-harness.mjs`'s template).
4. No temp files, debug prints, or context-less TODOs.
5. If all activities are done, ask the user whether to clean the session (clear
   `activities.json`, reset `current.md`).

## Greeting

```
| > Hello, I am the main orchestrator for Chemistry Draw.
We currently have X pending activity(ies).
What would you like to do today? (new feature / bug fix / improvement or refactor)
```

Replace X with the pending count from `activities.json`.
