# AGENTS.md — Chemistry Draw

> Agent navigation map. Read only what you need (progressive disclosure).
> Two stages, one direction: **PLANNING → DEVELOPMENT**.

## Before start

1. `node scripts/harness.mjs --stage` — prints the stage. Do not guess it.
2. Run the current stage checks:
   - `planning` → `node scripts/harness.mjs --planning`
   - `development` → `node scripts/harness.mjs --fast`
3. If anything is red, **STOP** and resolve the environment. A red environment
   is not a starting point.
4. Read `progress/current.md` and `BACKLOG.md`.
5. In `development`, read `activities.json` and run
   `node scripts/harness.mjs --schedule`.
6. Before creating a branch, choose its target line (see the branch model).

## Branch model (mandatory)

Chemistry Draw has two maintained lines. Choose the target line before creating
any branch or writing any code:

- **`main` — 0.x maintenance/support.** The line users run today: bug fixes,
  maintenance upgrades (including the Ketcher/Indigo/language E1) and releases.
  Do not add the ML/1.x work to `main`.
- **`develop` — 1.x integration.** Imago removal, ONNX/models/OCSR, NuGet and
  the 1.x path. It is not the 0.x support line.

Rules:

- Create the story/activity branch from the **target line**: `main` for a 0.x
  maintenance story, `develop` for 1.x. **Never** base a main-targeted story on
  `develop`.
- Work in the **main checkout**. Do not create git worktrees.
- Record the base branch in `progress/current.md` before starting. The
  orchestrator records it in the story plan; executors never write state.
- Merge the story back to the same line only after the user approves it. Do not
  cross-merge `main`/`develop` unless the user explicitly asks; port an
  individual fix with a cherry-pick and preserve each line's content.
- E1 is `main`-only: do not merge it into `develop`. The build-layout story was
  based on `main`, merged to `main`, then ported to `develop`.

## Repo map

| Path                             | When read                                    |
| -------------------------------- | -------------------------------------------- |
| `BACKLOG.md`                     | always; user stories                         |
| `.harness/state.json`            | always; the current stage                    |
| `docs/planning/overview.md`      | understand the product                       |
| `docs/planning/architecture.md`  | before any design decision                   |
| `docs/planning/stack.md`         | technology choices                           |
| `docs/planning/contracts.md`     | before touching an interface                 |
| `docs/planning/structure.md`     | before creating files/folders                |
| `docs/planning/c4/*.puml`        | system context, containers                   |
| `docs/planning/sequences/*.puml` | flows you are about to change                |
| `docs/planning/adr/`             | decisions already taken                      |
| `docs/harness/development.md`    | stage and story workflow                     |
| `docs/harness/verification.md`   | gates and commands                           |
| `docs/harness/testing.md`        | before writing tests                         |
| `docs/harness/structure.md`      | where harness files live                     |
| `docs/harness/git-tracking.md`   | tracked vs ignored                           |
| `activities.json`                | the selected story's plan                    |
| `progress/current.md`            | live session state                           |
| `progress/history.md`            | past context                                 |
| `scripts/harness.mjs`            | verification engine                          |
| `scripts/harness-lib.mjs`        | scheduling and backlog logic                 |
| `.opencode/agent/`               | role definitions                             |
| `.opencode/plugins/`             | protocol enforcement                         |
| `README.md`, `docs/ROADMAP.md`   | product overview and release backlog         |
| `docs/benchmarks/`               | model-parity reports                         |
| `docs/commit-policy.md`          | commit types and release semantics           |
| `src/`                           | React 18 + Ketcher frontend                  |
| `src-tauri/src/`                 | Tauri host: lifecycle, commands, logging     |
| `src-tauri/sidecar/`             | `indigo-server`: axum, Indigo FFI, ONNX      |
| `src-tauri/lib/<platform>/`      | generated native libs (ignored)              |
| `models/`, `.ort/`               | downloaded models and ONNX Runtime (ignored) |
| `scripts/`                       | harness, packaging, native-lib tooling       |
| `patches/`                       | Ketcher patches applied at install           |
| `Taskfile.yml`                   | project-owned task commands                  |
| `build/`                         | generated packages and benchmark output      |

All paths are relative to the repo root. No absolute paths, no `../`.

## Stack

- **Tauri v2 desktop shell + React 18/TypeScript/Vite frontend + Ketcher 3.18**
- **Rust sidecar** (`indigo-server`, axum) with native Indigo and ONNX Runtime
  1.31.0 (dynamic, CPU)
- Package manager: **pnpm** (`pnpm-lock.yaml`); Rust builds with **cargo**
- Harness: `node scripts/harness.mjs`
- Tests: `pnpm test` (Vitest), `cargo test -p indigo-server`, and
  `node --test scripts/lib/*.test.mjs` (contract tests)
- Build: `pnpm build` (frontend); sidecar/release packaging with
  `task build-sidecar`, `task packages` and `pnpm tauri build`
- Documentation generator: `bash scripts/docsgen.sh` (alias `pnpm run docs:gen`;
  TypeDoc for TypeScript, rustdoc for the Rust crates)
- Local run: `task run`; native libs: `task libs` (Docker)

## Hard rules

1. **The stage is exclusive and one-way.** PLANNING defines the foundation;
   DEVELOPMENT builds it. You cannot return to PLANNING. Planning artifacts stay
   editable in development.
2. **PLANNING touches no code and no tests.** No source edits, no test files, no
   build. The harness and the plugin block them.
3. **One story at a time.** Pick it from `BACKLOG.md`, set it to `active`, and
   derive activities for that story only.
4. **Activities are derived, never pre-generated.** If the user has not selected
   a story, there are no activities for it.
5. **Every activity starts with `DOCUMENT`.** Decisions go to an ADR and the
   affected planning doc/diagram; new public surface gets docstrings in the code.
   No markdown feature docs at this stage.
6. **TDD applies to the story, not the repository.** The tests activity precedes
   the implementation activity. Do not demand a test for every line.
7. **Parallel batches are mandatory.** If `--schedule` prints a batch of N
   activities, launch N `task-executor` subagents in ONE message.
8. **The user approves the story.** No agent can mark a story `done` on its own.
9. **State files are orchestrator-only.** Executors never write
   `activities.json`, `BACKLOG.md` or `progress/`.
10. **Document in `progress/current.md` while working**, not after.
11. **Respect the branch model.** Branch from the target line in the main
    checkout; no worktrees, no cross-merges.
12. **Never commit generated artifacts**: `src-tauri/lib/`, `target/`, `dist/`,
    `build/`, `models/`, `.ort/`, `docs/generated/` or any `.so`/DLL. Native
    Indigo is generated with `task libs` (Docker); ONNX Runtime is fetched with
    `scripts/fetch-onnxruntime.sh`; models are downloaded at runtime. None are
    vendored.
13. **Documents are `.ket`.** Save/Save As write `.ket` only. Export is the sole
    route to Molfile, SMILES, InChI, SVG and PNG and never changes the document
    path or format.
14. **No silent gate skips.** A gate that fails must be fixed; legacy debt gets
    a visible baseline plus a backlog story, never a disabled rule.
15. **No secrets, no generated docs, no session state in git.** Commit types
    follow `docs/commit-policy.md`; internal harness work is `chore`/`docs`.

## PLANNING

Allowed: `docs/planning/**`, `BACKLOG.md`, `AGENTS.md`, `.opencode/**`,
`scripts/**`, `progress/**`, tooling manifests (`package.json`, lockfiles,
formatter/linter config) and `.env.example`.

Produce or refine:

- `docs/planning/overview.md` — what the product is, for whom, and what is out.
- `docs/planning/architecture.md` — C4 context/container narrative and layers.
- `docs/planning/stack.md` — technologies and why; one ADR per real decision.
- `docs/planning/structure.md` — where code will live.
- `docs/planning/contracts.md` — contracts between applications/services.
- `docs/planning/c4/context.puml`, `container.puml`, `component.puml`.
- `docs/planning/sequences/*.puml` — the flows that matter.
- `BACKLOG.md` — coarse user stories, in the user's words.

Planning is done when `node scripts/harness.mjs --planning` is green **and** the
user says so. Then, and only then:

```bash
node scripts/harness.mjs --start-dev --user-approved --by <name>
```

Never run `--start-dev` on your own initiative. Ask first.

## DEVELOPMENT

### 1. Select and plan the story

1. Choose the story's target line (`main` or `develop`) with the user, then
   create its branch from that line in the main checkout.
2. Take the story the user picks; set `- status: active` in `BACKLOG.md`.
3. Resolve its `open questions` with the user **before** decomposing.
4. Write the activities in `activities.json`:
   - `storyId` is the only link to the story.
   - `dependsOn` is the real technical order (`[]` = independent).
   - `touches` lists every path prefix the activity may write.
   - The first task of every activity is its documentation task.
5. Show the decomposition to the user (ids, names, dependencies, touches, base
   branch). Wait for the OK. Nothing runs yet.
6. `node scripts/harness.mjs --schedule` → batches.

### 2. Execute one batch

1. Read the first batch. If it has N activities, launch N executors **in one
   message**.
2. Each executor claims first: `node scripts/harness.mjs --claim ACT-xx`.
   The plugin blocks edits until the whole batch is claimed.
3. Each executor runs its tasks in order: document, test, implement.
4. When an executor returns, verify:
   `node scripts/harness.mjs --activity ACT-xx`. Verification is serial, never
   while another executor is still editing.
5. Mark the activity and its tasks `done`, then `--schedule` again.

### 3. Close the story

1. All activities done. `node scripts/harness.mjs --story US-xxx`.
2. If it exits `3`, the gates are green but the user has not approved. Present
   the evidence (files, tests, docs output, ADRs, package checks) and ask.
3. On approval: `node scripts/harness.mjs --approve-story US-xxx --by <name>`,
   then `node scripts/harness.mjs --story US-xxx` again.
4. Mark the story `done`, archive the evidence to `progress/history.md`, reset
   `activities.json` for the next story.
5. Merge the branch back to its target line. Never cross-merge `main` and
   `develop`.

## Verification commands

| Command                               | Step     | Cost                   |
| ------------------------------------- | -------- | ---------------------- |
| `node scripts/harness.mjs --stage`    | inspect  | instant                |
| `node scripts/harness.mjs --planning` | planning | planning gates         |
| `node scripts/harness.mjs --fast`     | iterate  | seconds                |
| `node scripts/harness.mjs --changed`  | iterate  | changed files + tests  |
| `node scripts/harness.mjs --activity` | close    | targeted + docsgen     |
| `node scripts/harness.mjs --story`    | close    | full + build + docsgen |
| `node scripts/harness.mjs --schedule` | plan     | instant                |
| `node scripts/harness.mjs --explain`  | inspect  | instant                |

Rules:

- Do not run `--story` after every edit. It is the closing gate.
- Do not edit while a gate runs.
- A batch is closed only when every activity in it is verified.
- A `3` exit from `--story` is not a failure; it is the user approval boundary.

## User approval protocol

- **Story plan**: show the derived activities, their `touches` and the base
  branch; wait for OK.
- **Story close**: show the diff summary, the tests that prove the behavior, the
  ADRs written, the generated docs and the packaging checks when applicable;
  wait for the verdict.
- If the user rejects, adjust and ask again. Never mark `done` in advance.
- Record the approval with `--approve-story` and in `progress/history.md`.
- Merge to the target line only after approval.

## Session close

1. `node scripts/harness.mjs --story US-xxx` is green and approved.
2. Story `done` in `BACKLOG.md`; `activities.json` cleared for the next story.
3. Summary appended to `progress/history.md`; `current.md` reset.
4. Branch merged back to its target line; no worktree left behind.
5. No temp files, debug prints or context-less TODOs.
6. Ask the user which story to take next.

## Greeting

```text
| > Hello, I am the main orchestrator for Chemistry Draw.
We are in the <planning|development> stage. There are X pending stories.
What would you like to do today?
```
