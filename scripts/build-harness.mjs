#!/usr/bin/env node
/**
 * Bootstrap the harness tracking structure for the chemistry-draw project.
 *
 * Run with: node scripts/build-harness.mjs [project_name] [description]
 *
 * Creates (only if missing):
 *  - activities.json
 *  - progress/current.md
 *  - progress/history.md
 *  - progress/explore/
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CURRENT_MD_TEMPLATE = `# Current Session

## Activity
- ID:
- Name:
- Type:
- Status:

## Tasks
- Current:
- Pending:

## Plan

## Notes

## Blockers

---
`;

const HISTORY_MD_TEMPLATE = `# Session History

> Append-only log of completed sessions/activities.

---
`;

function initProject(projectName, description) {
  console.log(`Initializing project structure: ${projectName}`);

  const progressDir = path.join(PROJECT_ROOT, "progress");
  mkdirSync(path.join(progressDir, "explore"), { recursive: true });

  const activitiesPath = path.join(PROJECT_ROOT, "activities.json");
  if (!existsSync(activitiesPath)) {
    const data = { project: projectName, description, activities: [] };
    writeFileSync(activitiesPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log("Created activities.json");
  } else {
    console.log("activities.json already exists");
  }

  const currentMd = path.join(progressDir, "current.md");
  if (!existsSync(currentMd)) {
    writeFileSync(currentMd, CURRENT_MD_TEMPLATE, "utf8");
    console.log("Created progress/current.md");
  } else {
    console.log("progress/current.md already exists");
  }

  const historyMd = path.join(progressDir, "history.md");
  if (!existsSync(historyMd)) {
    writeFileSync(historyMd, HISTORY_MD_TEMPLATE, "utf8");
    console.log("Created progress/history.md");
  } else {
    console.log("progress/history.md already exists");
  }

  console.log("Project initialization complete.");
}

const args = process.argv.slice(2);
const projectName = args[0] ?? "chemistry-draw";
const description = args[1] ?? "Tauri desktop wrapper of Ketcher with a native Indigo sidecar";

initProject(projectName, description);
