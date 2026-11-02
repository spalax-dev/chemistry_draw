# AGENTS.md — Chemistry Draw

> Agent navigation map. Read only what you need (progressive disclosure).

## Before start

1. `node scripts/harness.mjs` — must end green. If it fails, **STOP** and
   resolve the environment first.
2. If it reports missing files, run `node scripts/build-harness.mjs`.
3. Read `progress/current.md` (session state) and `activities.json` (pending
   activities/tasks).
4. Read `docs/architecture.md` before implementing and `docs/conventions.md`
   before writing code.
5. Delegate ONE task from ONE pending activity. **Never work directly — always
   delegate.**

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
| `src/`, `src-tauri/src/`                      | frontend / Tauri host     |
| `src-tauri/sidecar/`                          | Indigo/Imago HTTP sidecar |
| `scripts/`                                    | native libs + packaging   |

- All paths relative to repo root. No absolute paths, no `../`.

## Hard rules

- **One task at a time**; don't mix activities. Parallel tasks only within one
  activity.
- **No `done` without green harness** — `node scripts/harness.mjs` all green
  (includes typecheck, ESLint, Prettier, rustfmt, Clippy and ShellCheck).
- Document in `progress/current.md` **while** working, not after. Include plan +
  task breakdown.
- If unsure, check `docs/` before inventing. If a tool misbehaves, log it in
  `progress/current.md` and stop — no workarounds.
- Never commit `src-tauri/lib/`, `target/`, `dist/`, `dist-packages/` or any
  `.so` file.
- Native Indigo/Imago are generated with `task libs` (Docker). They are never
  vendored.

## Activities

- Types: `fix` (bug), `feat` (feature), `chore` (refactor/config/deps), `docs`.
- Schema (see `.opencode/agent/main-orchestrator.md`):
  `{id, type, name, title, description, acceptance[], tasks[], status}`.

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
