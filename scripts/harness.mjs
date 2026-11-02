#!/usr/bin/env node
/**
 * Verification harness for the chemistry-draw project.
 *
 * Run with: node scripts/harness.mjs
 *
 * Checks, in order:
 *  1. Environment (rustc/cargo, node/pnpm)
 *  2. Base harness files exist (AGENTS.md, activities.json, progress/, docs/)
 *  3. activities.json is valid (statuses, types, one in_progress at most)
 *  4. Native Indigo/Imago libraries are present (`task libs` generates them)
 *  5. TypeScript typecheck (`pnpm exec tsc --noEmit`)
 *  6. ESLint (`pnpm run lint`)
 *  7. Prettier formatting (`pnpm run format:check`)
 *  8. Frontend build (`pnpm build`)
 *  9. Rust formatting (`cargo fmt --all --check`)
 * 10. Rust lint (`cargo clippy -- -D warnings`)
 * 11. Sidecar tests (`cargo test -p indigo-server`)
 * 12. ShellCheck (shell scripts, warnings and above)
 * 13. Summary
 *
 * Exit code 0 only when every block passes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DIR = path.join(PROJECT_ROOT, "src-tauri", "lib", "linux-x86_64");

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const NC = "\x1b[0m";

let exitCode = 0;

const ok = (msg) => console.log(`${GREEN}[OK]${NC}    ${msg}`);
const warn = (msg) => console.log(`${YELLOW}[WARN]${NC}  ${msg}`);
const fail = (msg) => {
  console.log(`${RED}[FAIL]${NC}  ${msg}`);
  exitCode = 1;
};

/** Run a command in the project root with inherited stdio. */
function run(cmd, args, env) {
  return spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: env ?? process.env,
  });
}

/** Run a command and capture stdout/stderr. */
function capture(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** Return the first line of a command's version output, or a placeholder. */
function versionOf(cmd, args) {
  const result = capture(cmd, args);
  const text = (result.stdout || result.stderr || "").trim();
  return text.split("\n")[0] || "(version unavailable)";
}

function commandExists(cmd) {
  const result = capture(cmd, ["--version"]);
  return !result.error && result.status === 0;
}

console.log("── 1. Environment Check ─────────────────────────────");

for (const [binary, args] of [
  ["node", ["--version"]],
  ["pnpm", ["--version"]],
  ["cargo", ["--version"]],
  ["rustc", ["--version"]],
]) {
  if (!commandExists(binary)) {
    fail(`${binary} is not installed`);
    if (binary === "cargo" || binary === "rustc" || binary === "node") {
      process.exit(1);
    }
  } else {
    ok(`${binary} -> ${versionOf(binary, args)}`);
  }
}

if (!commandExists("task")) {
  warn("task is not installed (optional, but the documented workflows use it)");
}

console.log("\n── 2. Base Harness Files ─────────────────────────────");

const baseFiles = [
  "AGENTS.md",
  "activities.json",
  "progress/current.md",
  "progress/history.md",
  "docs/architecture.md",
  "docs/conventions.md",
  "docs/verification.md",
  "docs/CHECKPOINTS.md",
  "docs/testing.md",
];

for (const file of baseFiles) {
  if (existsSync(path.join(PROJECT_ROOT, file))) {
    ok(`Exists ${file}`);
  } else {
    fail(`Missing base file: ${file}`);
  }
}

console.log("\n── 3. Validating activities.json ─────────────────────");

try {
  const data = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "activities.json"), "utf8"));
  const activities = Array.isArray(data) ? data : (data.activities ?? []);
  const validStatuses = new Set(["pending", "in_progress", "done", "blocked"]);
  const validTypes = new Set(["fix", "feat", "chore", "docs"]);
  const validAgents = new Set(["implementer", "reviewer"]);

  const inProgress = activities.filter((a) => a.status === "in_progress");
  if (inProgress.length > 1) {
    fail(`Found ${inProgress.length} activities in in_progress (max 1)`);
  }

  let invalid = false;
  for (const activity of activities) {
    const id = activity.id ?? "?";
    if (!validStatuses.has(activity.status)) {
      fail(`Invalid status in activity ${id}: ${activity.status}`);
      invalid = true;
    }
    if (activity.type && !validTypes.has(activity.type)) {
      fail(
        `Invalid type in activity ${id}: ${activity.type} ` + "(must be fix, feat, chore or docs)",
      );
      invalid = true;
    }
    if (activity.status === "done" && activity.tasks?.some((t) => t.status !== "done")) {
      warn(`Activity ${id} is done but has tasks not done`);
    }
    if (
      activity.status === "in_progress" &&
      activity.tasks?.length &&
      !activity.tasks.some((t) => t.status === "in_progress")
    ) {
      warn(`Activity ${id} is in_progress but no task is in_progress`);
    }
    for (const task of activity.tasks ?? []) {
      if (!task.id || !task.description) {
        fail(`Task missing id or description in activity ${id}`);
        invalid = true;
      }
      if (task.status && !validStatuses.has(task.status)) {
        fail(`Invalid task status in activity ${id}: ${task.status}`);
        invalid = true;
      }
      if (task.agent && !validAgents.has(task.agent)) {
        fail(
          `Invalid task agent in activity ${id}: ${task.agent} ` +
            "(must be implementer or reviewer)",
        );
        invalid = true;
      }
    }
  }

  if (!invalid) {
    ok(`activities.json valid (${activities.length} activities)`);
  }
} catch (error) {
  fail(`activities.json invalid: ${error.message}`);
}

console.log("\n── 4. Native Libraries ───────────────────────────────");
// Indigo/Imago are linked at build time and loaded at run time. They are not
// vendored: `task libs` builds them in the Docker builder.

const requiredLibs = ["libindigo.so", "libindigo-renderer.so", "libimago.so"];
const missing = requiredLibs.filter((lib) => !existsSync(path.join(LIB_DIR, lib)));
let haveLibs = false;

if (missing.length > 0) {
  fail(
    `Missing native libraries in ${path.relative(PROJECT_ROOT, LIB_DIR)}: ` + missing.join(", "),
  );
  warn("Run `task libs` (needs Docker) to generate them.");
  warn("Blocks 7 and 9 will be skipped until they exist.");
} else {
  const count = readdirSync(LIB_DIR).filter((f) => f.includes(".so")).length;
  ok(`Native libraries present (${count} files)`);
  haveLibs = true;
}

console.log("\n── 5. TypeScript Typecheck ───────────────────────────");

if (run("pnpm", ["exec", "tsc", "--noEmit"]).status === 0) {
  ok("TypeScript clean");
} else {
  fail("TypeScript errors found");
}

console.log("\n── 6. ESLint ─────────────────────────────────────────");

if (run("pnpm", ["run", "lint"]).status === 0) {
  ok("ESLint clean");
} else {
  fail("ESLint errors found");
}

console.log("\n── 7. Prettier ───────────────────────────────────────");

if (run("pnpm", ["run", "format:check"]).status === 0) {
  ok("Prettier formatting clean");
} else {
  fail("Formatting drift (run `pnpm run format`)");
}

console.log("\n── 8. Frontend Build ─────────────────────────────────");

if (run("pnpm", ["build"]).status === 0) {
  ok("Frontend build succeeded");
} else {
  fail("Frontend build failed");
}

console.log("\n── 9. Rust Formatting ────────────────────────────────");

if (capture("cargo", ["fmt", "--version"]).status !== 0) {
  warn("rustfmt is not installed (run `rustup component add rustfmt`)");
} else if (run("cargo", ["fmt", "--all", "--check"]).status === 0) {
  ok("Rust formatting clean");
} else {
  fail("Rust formatting drift (run `cargo fmt --all`)");
}

console.log("\n── 10. Rust Lint ──────────────────────────────────────");

if (!haveLibs) {
  warn("Skipped: native libraries are missing");
} else if (capture("cargo", ["clippy", "--version"]).status !== 0) {
  warn("clippy is not installed (run `rustup component add clippy`)");
  warn("Falling back to `cargo check`");
  if (run("cargo", ["check", "--workspace", "--all-targets"]).status === 0) {
    ok("cargo check passed");
  } else {
    fail("cargo check failed");
  }
} else if (
  run("cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]).status === 0
) {
  ok("Clippy clean");
} else {
  fail("Clippy warnings/errors found");
}

console.log("\n── 11. Sidecar Tests ─────────────────────────────────");

if (haveLibs) {
  const env = { ...process.env };
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${LIB_DIR}:${env.LD_LIBRARY_PATH}` : LIB_DIR;

  if (run("cargo", ["test", "-p", "indigo-server"], env).status === 0) {
    ok("All sidecar tests pass");
  } else {
    fail("Some sidecar tests are broken");
  }
} else {
  warn("Skipped: native libraries are missing");
}

console.log("\n── 12. ShellCheck ────────────────────────────────────");

const shellScripts = readdirSync(path.join(PROJECT_ROOT, "scripts"))
  .filter((file) => file.endsWith(".sh"))
  .map((file) => path.join("scripts", file));

if (!commandExists("shellcheck")) {
  warn("shellcheck is not installed (optional; CI installs it)");
} else if (run("shellcheck", ["--severity=warning", ...shellScripts]).status === 0) {
  ok(`ShellCheck clean (${shellScripts.length} scripts)`);
} else {
  fail("ShellCheck warnings found");
}

console.log("\n── 13. Summary ───────────────────────────────────────");

if (exitCode === 0) {
  ok("Environment ready. You can start working.");
} else {
  fail("Environment NOT ready. Resolve errors before advancing.");
}

process.exit(exitCode);
