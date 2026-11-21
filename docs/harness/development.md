# Development Workflow

> Two exclusive stages, one direction: PLANNING → DEVELOPMENT.
> Inside development, work moves story by story.

---

## 1. PLANNING

**Purpose:** decide the foundation. No implementation.

Produce:

1. `docs/planning/overview.md` — product, users, goals, non-goals.
2. `docs/planning/architecture.md` — context, containers, layers.
3. `docs/planning/stack.md` + ADRs — technologies and why.
4. `docs/planning/structure.md` — where code will live.
5. `docs/planning/contracts.md` — contracts between applications.
6. `docs/planning/c4/*.puml` — context, container, component.
7. `docs/planning/sequences/*.puml` — the flows that matter.
8. `BACKLOG.md` — coarse user stories in the user's words.

Rules:

- No source edits, no tests, no build. The plugin blocks them.
- Do not pre-decompose the backlog. Activities appear only for the story the
  user selects.
- Ask for decisions; do not invent the product.
- The foundation describes the real system: Tauri v2 host, React/Ketcher
  frontend, `indigo-server` sidecar (axum + Indigo FFI + ONNX), native Indigo
  generated with `task libs`, ONNX Runtime from NuGet, models downloaded at
  runtime, and `.ket` as the only saved document format.
- A story may be vague. Ambiguity belongs in `open questions`.

Done when `node scripts/harness.mjs --planning` is green **and** the user
approves:

```bash
node scripts/harness.mjs --start-dev --user-approved --by <name>
```

This is one-way. There is no "re-plan" phase.

---

## 2. DEVELOPMENT

### 2.1 Select the story and its branch

1. The user picks a story and its target line:
   - `main` for 0.x maintenance, bug fixes and releases;
   - `develop` for 1.x integration and ML work.
2. Create the story branch from that line **in the main checkout**. Do not use
   `git worktree`; do not base a `main` story on `develop`.
3. Set exactly one `- status: active` in `BACKLOG.md`.
4. Resolve `open questions` with the user before decomposing.
5. Derive activities for **that story only**.
6. Record the base branch in `progress/current.md`.

### 2.2 Decompose into activities

An activity is a cohesive set of interrelated tasks, usually one technical
layer. Example for _"As a user I want to save the document as `.ket`"_:

| Activity       | Tasks                                                   |
| -------------- | ------------------------------------------------------- |
| contract       | document model, save/export rules, title/dirty contract |
| tests          | save routing, close guard, recovery decisions (RED)     |
| implementation | document state, Tauri dialog/FS wiring, toolbar actions |
| integration    | recovery/autosave, docsgen, manual GUI checklist        |

Rules:

- `storyId` links the activity to its story.
- `dependsOn` is the real order; `[]` means independent.
- `touches` is mandatory: every path prefix the activity may write.
- Every activity's first task is its documentation task.
- The tests activity precedes the implementation activity.
- The plan names its base line and branch; paths owned by the other line stay
  out of `touches`.

Show the plan to the user (ids, names, dependencies, touches, base branch) and
wait for the OK.

### 2.3 Schedule

```bash
node scripts/harness.mjs --schedule
```

The harness builds batches from `dependsOn` and `touches`:

- a batch = independent activities with disjoint `touches`;
- batches are sequential;
- a batch of N runs with N executors **in one message**.

### 2.4 Execute an activity

Each executor, inside its `touches`:

```text
1. DOCUMENT   decision -> ADR + planning doc/diagram
              public surface -> docstrings in the code
2. TEST       tests for this activity; confirm RED
3. IMPLEMENT  minimal code; confirm GREEN
4. VERIFY     node scripts/harness.mjs --activity ACT-xx
```

The documentation step is not "write a markdown feature doc". It is:

- the decision record, when the activity decides something;
- the docstrings, always;
- the planning documents and diagrams, when the decision changes them.

### 2.5 Close the story

1. Every activity `done`.
2. Story `- status: awaiting-approval`.
3. `node scripts/harness.mjs --story US-xxx`.
4. Exit `3` → present evidence → ask the user.
5. `--approve-story US-xxx --by <name>` → `--story` again.
6. Mark `done`, archive to `progress/history.md`, clear `activities.json`.
7. Merge the branch to its target line; never cross-merge `main`/`develop`.

---

## 3. Why this order

| Choice                             | Reason                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| Foundation before code             | It is cheaper to change a diagram than a schema            |
| Stories before activities          | The user's want is stable; the technical plan is not       |
| Activities derived just-in-time    | 50 stories do not need 80 activities on day one            |
| Documentation first in an activity | Decisions and docstrings are cheapest before the code      |
| Tests before implementation        | The test defines "done" for that activity                  |
| Parallel independent layers        | Sidecar contract and frontend shell do not need each other |
| User approves the story            | A human verdict beats an agent reviewing itself            |

---

## 4. Exceptions

- **Bug fixes** may start with the failing regression test, then document the
  cause, then fix.
- **Refactors** may already have docs and tests; update only what went stale.
- **Spikes** live in `progress/explore/`; they become a story only when they
  produce a decision.
- **Model-gated work** may self-skip inference tests when `models/` or the ONNX
  Runtime dylib is absent; the skip is reported, never hidden.

---

## 5. Declaring done

- The activity is green with `--activity` and stayed inside `touches`.
- The story is green with `--story` and approved by the user.
- The docs, diagrams and ADRs describe the current behavior.
- `progress/current.md` tells the next agent where things stand.
- The branch is merged to its target line; no worktree, generated artifact or
  session state is left behind.
