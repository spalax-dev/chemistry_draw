#!/usr/bin/env node
/**
 * build_harness.mjs — create the local tracking structure.
 *
 * Chemistry Draw: two-stage harness bootstrap.
 *
 * Creates, only if missing:
 *   - .harness/state.json      (stage=planning; the one-way decision record)
 *   - activities.json          (empty plan; activities are derived per story)
 *   - BACKLOG.md               (user stories)
 *   - progress/current.md
 *   - progress/history.md
 *   - progress/explore/
 *   - docs/planning/{adr,c4,sequences}/
 *
 * It never creates planning docs, source code or tests. Those are the work.
 *
 * Run with: node scripts/build_harness.mjs [project_name] [description]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = process.argv[2] ?? basename(ROOT);
const description = process.argv[3] ?? "Project description";

const STATE = {
  project,
  description,
  stage: "planning",
  startedAt: null,
  approvedBy: null,
};

const BACKLOG_MD = `# Backlog

> User stories live here. Write them coarse: a want, the value behind it, and
> the acceptance bullets you already know. Open questions are expected.
>
> The orchestrator derives activities and tasks from a story **only after you
> pick it**. Do not pre-decompose the whole backlog.
>
> Status: \`pending\` | \`active\` | \`awaiting-approval\` | \`done\` | \`dropped\`
> Exactly one story may be \`active\` at a time.

---

## US-001 — Replace with your first story

- status: pending
- value: what the user gets from this
- acceptance:
  - a concrete observable outcome
  - another one, if you already know it
- open questions:
  - anything the agent must ask before starting

---

## How to add a story

1. Append a \`## US-00N — Title\` section.
2. Fill \`status\`, \`value\`, \`acceptance\` and \`open questions\`.
3. Do not write activities or tasks here; that is the orchestrator's job.
`;

const CURRENT_MD = `# Current Session

## Stage

- planning | development

## Story

- ID:
- Title:
- Status:

## Activity

- ID:
- Name:
- Depends on:
- Touches:

## Batch

- Batch:
- Claims:
- Parallel agents:

## Documentation step

- Decision recorded:
- ADR:
- Docstrings:

## Plan

## Notes

## Blockers

## Approval

- Requested at:
- Approved by:
`;

const HISTORY_MD = `# Session History

> Append-only durable record. Keep the live state in \`current.md\`.
> One entry per closed story and per stage transition.

---
`;

function ensure(path, content) {
  const relativePath = relative(ROOT, path);
  if (existsSync(path)) {
    console.log(`exists  ${relativePath}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  console.log(`created ${relativePath}`);
}

function ensureDir(path) {
  const relativePath = relative(ROOT, path);
  if (existsSync(path)) {
    console.log(`exists  ${relativePath}/`);
    return;
  }
  mkdirSync(path, { recursive: true });
  console.log(`created ${relativePath}/`);
}

console.log(`Initializing ${project} harness structure`);
ensure(join(ROOT, ".harness", "state.json"), `${JSON.stringify(STATE, null, 2)}\n`);
ensureDir(join(ROOT, ".harness", "claims"));
ensure(
  join(ROOT, "activities.json"),
  `${JSON.stringify({ project, description, activities: [] }, null, 2)}\n`,
);
ensure(join(ROOT, "BACKLOG.md"), BACKLOG_MD);
ensure(join(ROOT, "progress", "current.md"), CURRENT_MD);
ensure(join(ROOT, "progress", "history.md"), HISTORY_MD);
ensure(join(ROOT, "progress", "explore", ".gitkeep"), "");
ensureDir(join(ROOT, "docs", "planning", "adr"));
ensureDir(join(ROOT, "docs", "planning", "c4"));
ensureDir(join(ROOT, "docs", "planning", "sequences"));

console.log("");
console.log("Next:");
console.log("  1. Write docs/planning/* and BACKLOG.md (PLANNING stage).");
console.log("  2. node scripts/harness.mjs --planning");
console.log("  3. Ask the user, then: --start-dev --user-approved --by <name>");
console.log("  4. Pick a story, set it to `status: active`, then: --schedule");
