# Harness Architecture

> How verification and work tracking are wired in Chemistry Draw. The product
> architecture is in `docs/planning/architecture.md`.

---

## 1. Two layers

| Layer        | Owns                                            | Lives in          |
| ------------ | ----------------------------------------------- | ----------------- |
| User stories | What the user wants, in the user's words        | `BACKLOG.md`      |
| Execution    | Activities and tasks for the **selected** story | `activities.json` |

Stories do not contain activities. Activities carry `storyId`; that is the only
relationship. A story selected today produces activities today.

---

## 2. Stages

`.harness/state.json` records the stage:

```json
{
  "project": "Chemistry Draw",
  "stage": "planning",
  "startedAt": null,
  "approvedBy": null
}
```

- `planning` → `development` only through `--start-dev --user-approved`.
- There is no way back. Planning documents remain editable.
- The stage is tracked in git: it is a project decision, not session noise.
- The branch model is separate from the stage: `main` carries 0.x support work
  and `develop` carries 1.x work; a story branches from its target line in the
  main checkout.

---

## 3. Files

| File                      | Role                           | Tracked |
| ------------------------- | ------------------------------ | ------- |
| `BACKLOG.md`              | User stories                   | yes     |
| `activities.json`         | Activities of the active story | no      |
| `.harness/state.json`     | Stage                          | yes     |
| `.harness/schedule.json`  | Computed batches               | no      |
| `.harness/claims/*.json`  | Active executor claims         | no      |
| `.harness/approvals.json` | Recorded user approvals        | no      |
| `progress/current.md`     | Live session                   | no      |
| `progress/history.md`     | Durable record                 | yes     |

Approvals are local cache; the durable proof is the entry in
`progress/history.md`.

---

## 4. Engine

`scripts/harness.mjs`:

- reads the stage;
- selects the gate set;
- runs independent gates with async `spawn` + `Promise.all`;
- computes batches from `dependsOn` + `touches`;
- validates the backlog and the activity plan;
- enforces the `touches` boundary with `git status`;
- refuses to pass a story without recorded approval.

`scripts/harness-lib.mjs` holds the pure logic: backlog parsing, plan
validation, scheduling, claim checks, mode resolution. It is covered by
`node --test scripts/harness-lib.spec.mjs`.

Project gate commands behind the engine:

| Gate       | Commands                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `format`   | `pnpm run format:check`; `cargo fmt --all --check`                                                                     |
| `lint`     | `pnpm run lint`; `cargo clippy --workspace --all-targets -- -D warnings`; `shellcheck --severity=warning scripts/*.sh` |
| `type`     | `pnpm run typecheck`                                                                                                   |
| `test`     | `bash scripts/harness-test.sh full`                                                                                    |
| `build`    | `pnpm build`                                                                                                           |
| `docsgen`  | `bash scripts/docsgen.sh`                                                                                              |
| `selfTest` | `node --test scripts/harness-lib.spec.mjs`                                                                             |

---

## 5. Plugin

`.opencode/plugins/harness-guard.js` is the mechanical guard:

1. In `planning`, source and test edits are rejected.
2. During a batch, `activities.json`, `BACKLOG.md`, `progress/` and `.harness/`
   are read-only.
3. An executor can only write inside the union of the claimed activities'
   `touches`.
4. Edits are blocked until every activity in the batch is claimed, which is what
   forces parallel execution.

The plugin does not replace the harness. It guards the protocol; the harness
proves the work.

---

## 6. Quality gates

Chemistry Draw has independent signal from:

- **Prettier + rustfmt** for formatting;
- **ESLint + Clippy + ShellCheck** for static rules and docblocks;
- **`tsc --noEmit`** for TypeScript types;
- **Vitest** for pure frontend helpers;
- **`cargo test -p indigo-server`** for sidecar and chemistry behavior;
- **`node --test scripts/lib/*.test.mjs`** for packaging and public contracts;
- **`pnpm build`** for the production frontend artifact;
- **`bash scripts/docsgen.sh`** for the generated documentation (TypeDoc and
  rustdoc; `pnpm run docs:gen` is the alias).

Some native and model paths are environment-gated: `task libs` must have
produced `src-tauri/lib/<platform>/`, and model-gated tests need `models/` plus
the ONNX Runtime dylib. A missing dependency prints `[SKIP]` with the missing
piece; it is never a silent pass.

Gate policy and commands: `docs/harness/verification.md`.
Workflow: `docs/harness/development.md`.

---

## 7. Layout

```text
AGENTS.md                         entry point and contract
BACKLOG.md                        user stories
.harness/state.json               stage (tracked)
.opencode/agent/                  orchestrator and executor roles
.opencode/plugins/harness-guard.js protocol enforcement
docs/planning/                    product foundation, C4, sequences, ADRs
docs/harness/                     how the harness works
scripts/harness.mjs               engine
scripts/harness-lib.mjs           pure scheduling/backlog logic
scripts/harness-lib.spec.mjs      engine logic tests
scripts/build_harness.mjs         bootstrap of local state
progress/current.md               live session (local)
progress/history.md               durable record (tracked)
progress/explore/                 research notes
docs/generated/                   generated documentation (ignored)
```

Project code lives in `src/`, `src-tauri/src/` and `src-tauri/sidecar/`;
generated artifacts live under `build/`, `target/`, `dist/`, `models/`,
`.ort/` and `src-tauri/lib/` and are never tracked.

---

## 8. Design rules

- The harness enforces the project's rules; it does not invent them.
- A gate exists only if a failure catches a bug the other gates miss.
- The fast path must be the easy path: `--fast` for editing, `--activity` and
  `--story` for closing.
- A false green is worse than a false red. A missing gate says `[SKIP]`; it
  never pretends to have run.
- Product behavior is documented in code and planning docs, not in harness
  docs.
