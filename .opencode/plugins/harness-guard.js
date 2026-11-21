/**
 * harness-guard.js — OpenCode plugin for the two-stage harness.
 *
 * Copy to `.opencode/plugins/harness-guard.js`.
 *
 * What it enforces (mechanically, not by asking):
 *
 * 1. PLANNING is locked to foundation artifacts. Edits to source, tests or
 *    build output are rejected until `.harness/state.json` says `development`.
 * 2. While an activity batch is claimed, `activities.json`, `BACKLOG.md`,
 *    `progress/` and `.harness/` are read-only. Only the orchestrator writes
 *    them, and only between batches.
 * 3. Every file edited during a batch must be inside the union of the claimed
 *    activities' `touches`. Two parallel executors can never write the same
 *    path.
 * 4. An executor cannot start editing until the whole batch is claimed, so a
 *    batch of N independent activities cannot be executed serially.
 *
 * The plugin never replaces the harness: `node scripts/harness.mjs` remains the
 * source of truth for gates. This only guards the protocol around it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Paths the orchestrator owns; locked during a batch. */
const STATE_PATHS = ["activities.json", "BACKLOG.md", "progress/", ".harness/"];

/** Everything PLANNING may write. Anything else is source/test/build output. */
const PLANNING_ALLOWLIST = [
  "docs/",
  "BACKLOG.md",
  "AGENTS.md",
  "README.md",
  "opencode.json",
  ".gitignore",
  ".opencode/",
  ".harness/",
  "progress/",
  "scripts/",
  ".github/",
  // Tooling manifests and config: choosing the stack is part of PLANNING.
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "jsconfig.json",
  "biome.json",
  ".prettierrc",
  ".prettierignore",
  ".eslintrc",
  "eslint.config.js",
  "eslint.config.mjs",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "ruff.toml",
  "mypy.ini",
  "pytest.ini",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Makefile",
  "justfile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env.example",
];

const norm = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function matches(path, patterns) {
  const file = norm(path);
  return patterns.some((pattern) => {
    const prefix = norm(pattern);
    return file === prefix || file.startsWith(prefix);
  });
}

function touchesMatch(file, touches) {
  const target = norm(file);
  return (touches ?? []).some((pattern) => {
    const prefix = norm(pattern)
      .replace(/\/+$/, "")
      .replace(/\/\*\*$/, "")
      .replace(/\*+$/, "");
    if (!prefix) {
      return true;
    }
    return target === prefix || target.startsWith(`${prefix}/`);
  });
}

export const HarnessGuard = async ({ directory, worktree }) => {
  const root = resolve(worktree ?? directory ?? process.cwd());
  const statePath = join(root, ".harness", "state.json");
  const claimsDir = join(root, ".harness", "claims");

  const readStage = () => readJson(statePath, { stage: "planning" })?.stage ?? "planning";

  const readClaims = () => {
    if (!existsSync(claimsDir)) {
      return [];
    }
    const claims = [];
    for (const name of readdirSync(claimsDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const claim = readJson(join(claimsDir, name), null);
      if (claim?.activityId) {
        claims.push(claim);
      }
    }
    return claims;
  };

  const targetPath = (args) => {
    const raw = args?.filePath ?? args?.path ?? args?.file ?? args?.filename;
    if (!raw || typeof raw !== "string") {
      return null;
    }
    return isAbsolute(raw) ? relative(root, raw) : raw;
  };

  const guardPlanning = (file) => {
    if (matches(file, PLANNING_ALLOWLIST)) {
      return;
    }
    throw new Error(
      `[harness] stage=planning: "${norm(file)}" is outside the foundation. ` +
        "Code and tests are locked until the user approves `--start-dev`. " +
        "Allowed: docs/, BACKLOG.md, AGENTS.md, .opencode/, scripts/, progress/, " +
        "tooling manifests.",
    );
  };

  const guardBatch = (file, claims) => {
    const batch = claims[0].batch ?? [];
    const claimed = new Set(claims.map((claim) => claim.activityId));
    const missing = batch.filter((id) => !claimed.has(id));

    if (missing.length > 0) {
      throw new Error(
        `[harness] batch incomplete: ${missing.join(", ")} not claimed. ` +
          "Launch every activity of the batch in parallel (task-executor) before editing.",
      );
    }

    if (matches(file, STATE_PATHS)) {
      throw new Error(
        `[harness] "${norm(file)}" is orchestrator state and is read-only during ` +
          `a batch (${batch.join(", ")}). Close the batch first.`,
      );
    }

    const allowed = claims.flatMap((claim) => claim.touches ?? []);
    if (!touchesMatch(file, allowed)) {
      throw new Error(
        `[harness] "${norm(file)}" is outside the claimed scope. ` +
          `Allowed: ${allowed.join(", ")}. If the activity needs this path, ` +
          "stop and extend `touches` between batches.",
      );
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write" && input.tool !== "apply_patch") {
        return;
      }
      const file = targetPath(output.args);
      if (!file || norm(file).startsWith("..")) {
        return;
      }

      if (readStage() === "planning") {
        guardPlanning(file);
        return;
      }

      const claims = readClaims();
      if (claims.length > 0) {
        guardBatch(file, claims);
      }
    },
  };
};
