# Verification

> How Chemistry Draw decides that work is correct. The harness is the executable
> source of truth; this document explains the policy.

---

## 0. The stage decides what can run

`.harness/state.json` holds the stage. It is one-way.

| Stage         | Exists for                               | Cannot do                          |
| ------------- | ---------------------------------------- | ---------------------------------- |
| `planning`    | foundation, contracts, diagrams, backlog | code, tests, build, implementation |
| `development` | stories -> activities -> tasks           | return to planning                 |

A development command in `planning` exits with `[BLOCKED]`. It is not silently
skipped: the agent must not believe it verified something it did not.

The plugin (`.opencode/plugins/harness-guard.js`) blocks source edits while in
planning, and blocks edits outside a claimed activity's `touches` during a
batch.

---

## 1. Planning gates

| Gate                 | Proves                                            |
| -------------------- | ------------------------------------------------- |
| `planning-structure` | `docs/planning/{adr,c4,sequences}` exist          |
| `backlog`            | `BACKLOG.md` parses; statuses valid; max 1 active |
| `planning-docs`      | foundation docs exist and are not placeholders    |
| `puml`               | every diagram has balanced `@startuml`/`@enduml`  |
| `docsgen-config`     | a documentation generator is configured           |

Running `--start-dev` re-runs them; a red foundation cannot enter development.
The foundation is the product: Tauri v2 host, React/Ketcher frontend, the
`indigo-server` sidecar, the `.ket` document model and the model-delivery path.

---

## 2. Development gates

| Gate        | Proves                                              | Step                                  |
| ----------- | --------------------------------------------------- | ------------------------------------- |
| `format`    | formatting is stable                                | all                                   |
| `lint`      | static rules pass                                   | all                                   |
| `type`      | TypeScript types and Rust crates compile            | iteration, activity, story            |
| `test`      | behavior is covered                                 | iteration (targeted), activity, story |
| `build`     | the frontend artifact builds                        | story                                 |
| `structure` | tree/naming/forbidden patterns hold                 | all                                   |
| `docs`      | harness docs exist and are not placeholders         | iteration, activity, story            |
| `docsgen`   | the documentation generator runs                    | activity, story                       |
| `docblocks` | optional extra docblock check                       | activity, story when enabled          |
| `touches`   | no changed file falls outside the batch's `touches` | activity                              |

There is no separate `contract` gate in the engine. Packaging and public
contract tests run in the `test` gate through `scripts/lib/*.test.mjs`.

Concrete commands behind the gates:

| Gate      | Command                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `format`  | `pnpm run format:check`, `cargo fmt --all --check`                                                                     |
| `lint`    | `pnpm run lint`, `cargo clippy --workspace --all-targets -- -D warnings`, `shellcheck --severity=warning scripts/*.sh` |
| `type`    | `pnpm run typecheck` (`tsc --noEmit`), `cargo check --workspace --all-targets`                                         |
| `test`    | `bash scripts/harness-test.sh full` (Vitest, `node:test`, sidecar cargo tests)                                         |
| `build`   | `pnpm build`                                                                                                           |
| `docsgen` | `bash scripts/docsgen.sh` (TypeDoc + rustdoc; alias `pnpm run docs:gen`)                                               |

Docblocks are enforced by the docblock policy first. Rust modules use `//!` and
public items use `///`; exported TypeScript symbols use JSDoc. Legacy files that
fail a new rule get a visible baseline and a backlog story, never a disabled
rule. The current check is `node scripts/check-docblocks.mjs`; the debt and its
burn-down live in `docs/harness/docstring-debt.md` and
`docs/harness/docblock-baseline.txt`.

---

## 3. Steps and commands

| Command                                      | Step      | Runs                                                                    |
| -------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `node scripts/harness.mjs --planning`        | planning  | planning gates                                                          |
| `node scripts/harness.mjs --fast`            | iteration | changed format/lint + structure                                         |
| `node scripts/harness.mjs`                   | iteration | changed format/lint + affected type + targeted tests + structure + docs |
| `node scripts/harness.mjs --activity ACT-xx` | activity  | iteration + docsgen + touches                                           |
| `node scripts/harness.mjs --story US-xxx`    | story     | all gates + build + full tests + docsgen + approval                     |
| `node scripts/harness.mjs --explain`         | —         | prints the gate set, runs nothing                                       |

Exit codes:

- `0` green.
- `1` failed.
- `3` story gates green but **user approval is missing**. This is the human
  boundary, not an error to bypass.

Packaging changes additionally need `task packages` and the payload checks in
`docs/planning/contracts.md`; Windows packaging is validated by the `windows`
CI job. Model-gated tests need `models/` and the ONNX Runtime dylib; they
self-skip with an explicit `[SKIP]` when those are absent.

---

## 4. The story boundary

1. All activities of the story are `done`.
2. The story is `- status: awaiting-approval` in `BACKLOG.md`.
3. `--story` runs the full gate. If it exits `3`, present the evidence and ask.
4. On approval: `--approve-story US-xxx --by <name>`, then `--story` again.
5. Mark `done`; archive to `progress/history.md`; clear `activities.json`; merge
   the branch to its target line.

An agent can never approve. There is no reviewer role to outsource it to.

---

## 5. Parallelism

`--schedule` turns `dependsOn` + `touches` into batches:

- A batch is a set of pending activities whose dependencies are done and whose
  `touches` do not overlap.
- Activities inside a batch run in parallel, one executor each.
- Batches run sequentially.

Rules:

- A batch of N requires N executors launched in one message.
- Each executor claims before editing (`--claim`). The plugin blocks edits until
  all N claims exist, so serial execution cannot silently pass.
- Activity verification is serial, after the executor returns.
- Missing `touches` means the activity runs alone.
- The branch model still applies: the batch names its base line and never mixes
  `main` and `develop` work.

---

## 6. Documentation as a system

- Planning docs are hand written and **stay editable** in development.
- In-code docblocks are the source of truth for what the code does.
- The generator (`bash scripts/docsgen.sh`) produces the readable docs; output
  under `docs/generated/` and `target/doc/` is build output and is never
  committed.
- A decision change writes an ADR and updates the affected planning doc or
  diagram in the same activity.

---

## 7. Costs and anti-patterns

- `--fast` is the edit loop. Do not run `--story` after every edit.
- At most two story-level runs per story: one for evidence, one to confirm after
  approval. A third needs a reason.
- Do not run gates while an executor is editing.
- Do not run `docsgen` on every save; activity and story close are enough.
- A false green is worse than a false red: when a gate is not configured, the
  harness says so; it does not pretend.

---

## 8. Acceptance for this harness

- [ ] `--planning` is green on the foundation.
- [ ] `--activity` in planning exits non-zero with `[BLOCKED]`.
- [ ] `--start-dev` without `--user-approved` fails.
- [ ] `--schedule` prints parallel batches for independent activities.
- [ ] `--claim` rejects an activity outside the current batch.
- [ ] `--activity` fails when a file outside `touches` changed.
- [ ] `--story` exits `3` without approval.
- [ ] `--story` passes after `--approve-story`.
- [ ] The plugin denies source edits in planning.
- [ ] The plugin denies edits until the batch is fully claimed.
- [ ] `node --test scripts/harness-lib.spec.mjs` is green in under 1 s.
