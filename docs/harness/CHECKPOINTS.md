# CHECKPOINTS — Final State Evaluation

> Judge the destination, not the path. A human or an agent should be able to
> decide whether the project is healthy from these boxes.

## C1 — Stage is coherent

- [ ] `.harness/state.json` has `planning` or `development`.
- [ ] If `development`: `startedAt` and `approvedBy` are set.
- [ ] No command was used to return to planning.
- [ ] Planning artifacts exist and are not placeholders.
- [ ] The story names its target line (`main` or `develop`); no worktree exists.

## C2 — The work registry is honest

- [ ] `BACKLOG.md` parses; statuses are valid.
- [ ] At most one story is `active` and one is `awaiting-approval`.
- [ ] Every activity has a `storyId` that exists in the backlog.
- [ ] `dependsOn` has no cycles and no cross-story edges.
- [ ] Every activity has `touches` and at least one task.
- [ ] The first task of every activity is its documentation task.
- [ ] No activity exists for a story that was never selected.

## C3 — Execution respected the protocol

- [ ] Every activity was claimed before editing.
- [ ] A batch of N ran with N executors in one message.
- [ ] No file outside the batch's `touches` changed (the plugin enforces the
      individual activity's scope at edit time).
- [ ] Activity verification ran after the executor returned, not concurrently.
- [ ] State files were written only by the orchestrator, between batches.
- [ ] The branch was created from the target line in the main checkout; no
      `main` work was based on `develop`.

## C4 — Documentation is real

- [ ] Every exported symbol has a docstring (Rust `///`/`//!`, TS JSDoc).
- [ ] The documentation generator runs: `bash scripts/docsgen.sh`.
- [ ] Generated output (`docs/generated/`, `target/doc/`) is not edited or
      committed.
- [ ] Every decision taken has an ADR, indexed and numbered.
- [ ] `docs/planning/architecture.md` and the C4/sequence diagrams match
      reality.
- [ ] `docs/planning/contracts.md` matches the contract tests.

## C5 — Verification is honest

- [ ] `node scripts/harness.mjs --fast` is green.
- [ ] The story gate was run once for evidence and once after approval.
- [ ] `pnpm test` (Vitest), `cargo test -p indigo-server` and
      `node --test scripts/lib/*.test.mjs` ran the tests they claim to run.
- [ ] The frontend production build (`pnpm build`) succeeds.
- [ ] No gate was skipped silently; skipped gates printed `[SKIP]` with the
      missing dependency.
- [ ] `node --test scripts/harness-lib.spec.mjs` is green.
- [ ] Packaging changes ran `task packages` and the payload checks; no
      `.so`/DLL, model weight or `libstdc++` leaked into the payload.

## C6 — Closure is real

- [ ] The story is `done` only with a recorded user approval.
- [ ] `progress/history.md` has the story entry with the approval.
- [ ] `activities.json` is cleared or holds the next story's plan.
- [ ] The branch was merged back to its target line; no cross-merge and no
      worktree left behind.
- [ ] No secrets, credentials, generated output, native libs, models or session
      state are tracked.
- [ ] No suspicious untracked files.

---

**How to use this file:** go through C1–C6. Any empty box blocks closure. An
agent may prepare the evidence; only the user checks the approval boxes.
