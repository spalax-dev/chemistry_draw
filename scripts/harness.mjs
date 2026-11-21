#!/usr/bin/env node
/**
 * harness.mjs — two-stage verification harness.
 *
 * STACK: Tauri v2 (React/Vite) + native Indigo/ONNX Rust sidecar.
 *
 * Stages (`.harness/state.json`) are exclusive and one-way:
 *
 *   PLANNING     docs/planning/**, BACKLOG.md. No code, no tests.
 *   DEVELOPMENT  stories -> activities -> tasks. Code, tests, docs generator.
 *
 * Placeholder map (example values are already substituted so the file runs):
 *   {{STACK}}           -> CONFIG.stack
 *   {{PACKAGE_MANAGER}} -> commands inside CONFIG.gates
 *   {{FORMAT_CMD}}      -> CONFIG.gates.format.full
 *   {{LINT_CMD}}        -> CONFIG.gates.lint.full
 *   {{TYPE_CMD}}        -> CONFIG.gates.type.full
 *   {{BUILD_CMD}}       -> CONFIG.gates.build.full
 *   {{TEST_CMD}}        -> CONFIG.gates.test.full
 *   {{TARGET_TEST_CMD}} -> CONFIG.specs.command
 *   {{CONTRACT_CMD}}    -> CONFIG.gates.contract
 *   {{DOCSGEN_CMD}}    -> CONFIG.gates.docsgen
 *   {{PLANNING_DOCS}}   -> CONFIG.planning.docs
 *   {{CODE_ROOTS}}      -> CONFIG.codeRoots
 *   {{TEST_ROOTS}}      -> CONFIG.testRoots
 *   {{IGNORE_DIRS}}     -> CONFIG.structure.ignoreDirs
 *
 * Commands:
 *   (default)                  stage-aware: planning gates | iteration gates
 *   --stage                    print stage, backlog and schedule summary
 *   --planning                 planning gate set (planning stage only)
 *   --start-dev                PLANNING -> DEVELOPMENT (needs --user-approved)
 *   --schedule [US-x]          compute batches, write .harness/schedule.json
 *   --claim ACT-x              register an executor claim for the current batch
 *   --activity ACT-x           activity gates + touches diff check
 *   --story US-x               story gates (full) + approval check
 *   --approve-story US-x       record the user's approval (needs --by <name>)
 *   --fast                     changed format/lint + structure
 *   --changed                  iteration gates from the working tree
 *   --explain                  print the gate set, run nothing
 *
 * Exit codes: 0 green, 1 failed, 3 green but awaiting user approval.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeStory,
  claimErrors,
  describeMode,
  findStory,
  modeForStep,
  normalizeActivities,
  parseBacklog,
  pathMatchesTouches,
  planBatches,
  storyActivities,
  storyIsComplete,
  validateActivities,
  STATE_PATHS,
} from "./harness-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_DIR = join(ROOT, ".harness");
const STATE_PATH = join(HARNESS_DIR, "state.json");
const SCHEDULE_PATH = join(HARNESS_DIR, "schedule.json");
const APPROVALS_PATH = join(HARNESS_DIR, "approvals.json");
const CLAIMS_DIR = join(HARNESS_DIR, "claims");
const LAST_STORY_PATH = join(HARNESS_DIR, "last-story.json");

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Replace this block. Keep the shape; set an optional gate to null to skip it.
const CONFIG = {
  stack: "Tauri v2 (React + Vite) + native Indigo/ONNX Rust sidecar",

  // Changed files under these roots are code and select the targeted path.
  codeRoots: ["src/", "src-tauri/src/", "src-tauri/sidecar/src/", "scripts/"],

  // Only files under these roots are searched for sibling specs.
  testRoots: ["src/", "scripts/lib/", "src-tauri/sidecar/src/"],

  // GATE: planning-docs — foundation documents and minimum word counts.
  planning: {
    stories: "BACKLOG.md",
    docs: [
      { path: "docs/planning/overview.md", minWords: 80 },
      { path: "docs/planning/architecture.md", minWords: 120 },
      { path: "docs/planning/stack.md", minWords: 80 },
      { path: "docs/planning/structure.md", minWords: 80 },
      { path: "docs/planning/contracts.md", minWords: 60 },
      { path: "docs/planning/adr/README.md", minWords: 30 },
      { path: "docs/planning/c4/context.puml", minWords: 8 },
      { path: "docs/planning/c4/container.puml", minWords: 8 },
      { path: "docs/planning/c4/component.puml", minWords: 8 },
      // Sequence diagrams are enforced by the puml gate + requiredDirs; this
      // project has no login flow, so no single sequence file is hardcoded.
    ],
    requiredDirs: [
      "docs/planning",
      "docs/planning/adr",
      "docs/planning/c4",
      "docs/planning/sequences",
    ],
  },

  // GATE: structure — tree rules for this repository.
  structure: {
    ignoreDirs: [
      "node_modules",
      ".git",
      ".harness",
      "dist",
      "build",
      "out",
      "coverage",
      "target",
      ".ort",
      "models",
      ".pnpm-store",
      "src-tauri/target",
      "src-tauri/lib",
      "src-tauri/gen",
      "public",
      "patches",
    ],
    requiredDirs: [
      "src",
      "src-tauri/src",
      "src-tauri/sidecar/src",
      "scripts",
      "docs/planning",
      "docs/harness",
    ],
    // { dir, extensions, pattern, message }
    forbidden: [
      {
        dir: "src",
        extensions: [".ts", ".tsx"],
        pattern: /\b(?:describe|it|test)\.only\s*\(/,
        message: "focused test (.only); remove it before closing the activity",
      },
      {
        dir: "src",
        extensions: [".ts", ".tsx"],
        pattern: /@ts-ignore\b/,
        message: "@ts-ignore; use @ts-expect-error with a reason",
      },
      {
        dir: "scripts",
        extensions: [".mjs", ".js", ".ts"],
        pattern: /\b(?:describe|it|test)\.only\s*\(/,
        message: "focused test (.only); remove it before closing the activity",
      },
      {
        dir: "src-tauri/sidecar/src",
        extensions: [".rs"],
        pattern: /\bdbg!\(/,
        message: "dbg! macro; remove it before closing the activity",
      },
    ],
    // { dir, extensions, limit, exclude }
    maxLines: [
      { dir: "src", extensions: [".ts", ".tsx"], limit: 1200, exclude: [/\.test\./] },
      { dir: "src-tauri/src", extensions: [".rs"], limit: 400 },
      { dir: "src-tauri/sidecar/src/service", extensions: [".rs"], limit: 1300 },
    ],
  },

  // Development docs (the harness contract itself).
  docs: [
    { path: "AGENTS.md", minWords: 60 },
    { path: "docs/harness/verification.md", minWords: 80 },
    { path: "docs/harness/structure.md", minWords: 60 },
    { path: "docs/harness/testing.md", minWords: 60 },
  ],

  // GATE: test — sibling spec discovery and targeted command.
  specs: {
    // Vitest/node:test sibling specs plus the sidecar integration suite.
    pattern:
      /(?:\.(?:spec|test)\.(?:[cm]?[jt]sx?)$)|(?:^src-tauri\/sidecar\/src\/tests\/[^/]+\.rs$)/,
    candidates(file) {
      if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
        const base = file.replace(/\.(?:[cm]?[jt]sx?)$/, "");
        return [
          ".spec.ts",
          ".spec.tsx",
          ".spec.js",
          ".spec.jsx",
          ".test.ts",
          ".test.tsx",
          ".test.js",
          ".test.jsx",
        ].map((suffix) => `${base}${suffix}`);
      }
      if (
        file.endsWith(".rs") &&
        file.startsWith("src-tauri/sidecar/src/") &&
        !file.startsWith("src-tauri/sidecar/src/tests/")
      ) {
        return [`src-tauri/sidecar/src/tests/${basename(file, ".rs")}.rs`];
      }
      return [];
    },
    command(specs) {
      return [["bash", "scripts/harness-test.sh", "targeted", ...specs]];
    },
    fallback: [["bash", "scripts/harness-test.sh", "full"]],
  },

  // GATE: format / lint / type / build / test / contract / docsgen.
  gates: {
    format: {
      full: [
        ["pnpm", "run", "format:check"],
        ["cargo", "fmt", "--all", "--check"],
      ],
      changed: (files) => {
        const commands = [];
        const prettierFiles = files.filter((file) => !file.endsWith(".rs"));
        if (prettierFiles.length > 0) {
          commands.push([
            "pnpm",
            "exec",
            "prettier",
            "--check",
            "--ignore-unknown",
            ...prettierFiles,
          ]);
        }
        if (files.some((file) => file.endsWith(".rs"))) {
          commands.push(["cargo", "fmt", "--all", "--check"]);
        }
        return commands;
      },
    },
    lint: {
      full: [
        ["pnpm", "run", "lint"],
        ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ],
      filter: (file) => /\.(?:[cm]?[jt]sx?)$/.test(file),
      changed: (files) => {
        const commands = [];
        const lintFiles = files.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
        if (lintFiles.length > 0) {
          commands.push(["pnpm", "exec", "eslint", ...lintFiles, "--max-warnings", "0"]);
        }
        if (files.some((file) => file.endsWith(".rs"))) {
          commands.push([
            "cargo",
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
          ]);
        }
        if (files.some((file) => file.endsWith(".sh"))) {
          commands.push([
            "shellcheck",
            "--severity=warning",
            ...files.filter((file) => file.endsWith(".sh")),
          ]);
        }
        return commands;
      },
    },
    type: {
      full: [
        ["pnpm", "run", "typecheck"],
        ["cargo", "check", "--workspace", "--all-targets"],
      ],
      affected: (files) => {
        const commands = [];
        if (files.some((file) => file.startsWith("src/"))) {
          commands.push(["pnpm", "run", "typecheck"]);
        }
        if (files.some((file) => file.startsWith("src-tauri/"))) {
          commands.push(["cargo", "check", "--workspace", "--all-targets"]);
        }
        return commands.length > 0 ? commands : null;
      },
    },
    build: {
      full: [["pnpm", "run", "build"]],
    },
    test: {
      // Vitest + node:test contract suites + sidecar cargo tests, with the
      // native lib/ model / ONNX Runtime environment set by the wrapper.
      full: [["bash", "scripts/harness-test.sh", "full"]],
    },
    // GATE: contract [OPTIONAL] — no schema/API contract gate in this repo.
    contract: null,
    // GATE: docsgen [REQUIRED] — created by the planning/docsgen activity.
    docsgen: [["bash", "scripts/docsgen.sh"]],
    // GATE: docblocks — fails only on new/changed symbols; legacy debt is
    // baselined in docs/harness/docblock-baseline.txt.
    docblocks: [["node", "scripts/check-docblocks.mjs"]],
  },

  // Pure-logic self-test; cheap enough to run on every step.
  selfTest: ["node", "--test", "scripts/harness-lib.spec.mjs"],
};

// ─── CLI ────────────────────────────────────────────────────────────────────
const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const GREY = "\x1b[0;90m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

const argv = process.argv.slice(2);
let exitCode = 0;
let changedFilesCache = null;

function ok(message) {
  console.log(`${GREEN}[OK]${NC}    ${message}`);
}
function warn(message) {
  console.log(`${YELLOW}[WARN]${NC}  ${message}`);
}
function skip(message) {
  console.log(`${GREY}[SKIP]${NC}  ${message}`);
}
function fail(message) {
  console.log(`${RED}[FAIL]${NC}  ${message}`);
  exitCode = 1;
}
function info(message) {
  console.log(`${CYAN}[INFO]${NC}  ${message}`);
}

function hasFlag(flag) {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function argvValue(flag) {
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return null;
}

const HELP = hasFlag("--help");
const STAGE = hasFlag("--stage");
const PLANNING = hasFlag("--planning");
const START_DEV = hasFlag("--start-dev");
const USER_APPROVED = hasFlag("--user-approved");
const SCHEDULE = hasFlag("--schedule");
const SCHEDULE_STORY = argvValue("--schedule");
const CLAIM = argvValue("--claim");
const ACTIVITY = argvValue("--activity");
const STORY = argvValue("--story");
const APPROVE_STORY = argvValue("--approve-story");
const BY = argvValue("--by");
const FAST = hasFlag("--fast");
const CHANGED = hasFlag("--changed");
const EXPLAIN = hasFlag("--explain");

const KNOWN_FLAGS = new Set([
  "--help",
  "--stage",
  "--planning",
  "--start-dev",
  "--user-approved",
  "--schedule",
  "--claim",
  "--activity",
  "--story",
  "--approve-story",
  "--by",
  "--fast",
  "--changed",
  "--explain",
]);

function printHelp() {
  console.log(`Usage: node scripts/harness.mjs [command]

  (default)                 Stage-aware: planning gates | iteration gates
  --stage                   Print stage, backlog and schedule summary
  --planning                Planning gates (planning stage only)
  --start-dev               PLANNING -> DEVELOPMENT (requires --user-approved)
  --schedule [US-x]         Compute batches and write .harness/schedule.json
  --claim ACT-x             Register an executor claim for the current batch
  --activity ACT-x          Activity gates + touches diff check
  --story US-x              Story gates (full) + approval check
  --approve-story US-x      Record user approval (requires --by <name>)
  --fast                    Changed format/lint + structure
  --changed                 Iteration gates from the working tree
  --explain                 Print the gate set and run nothing
  --help                    Show this help

The stage is exclusive and one-way. Development cannot return to planning.`);
}

if (HELP) {
  printHelp();
  process.exit(0);
}

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (!arg.startsWith("--")) {
    continue;
  }
  const name = arg.split("=")[0];
  if (!KNOWN_FLAGS.has(name)) {
    warn(`Unknown flag ${name} ignored.`);
  }
  if (KNOWN_FLAGS.has(name) && !arg.includes("=")) {
    const takesValue = [
      "--schedule",
      "--claim",
      "--activity",
      "--story",
      "--approve-story",
      "--by",
    ].includes(name);
    if (takesValue && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      index += 1;
    }
  }
}

// ─── Async process runner ───────────────────────────────────────────────────
function run(cmd, args, { cwd = ROOT, env = process.env, timeout = 15 * 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolvePromise({ code, signal, stdout, stderr });
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code ?? 1, signal));
  });
}

async function runCommands(commands) {
  let last = { code: 0, stdout: "", stderr: "" };
  for (const [cmd, ...args] of commands) {
    last = await run(cmd, args);
    if (last.code !== 0) {
      return last;
    }
  }
  return last;
}

function printFailure(result) {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (!text) {
    return;
  }
  console.log(text.split("\n").slice(-200).join("\n"));
}

async function executeGate(label, commands) {
  if (!commands || commands.length === 0) {
    return { label, skipped: true };
  }
  const result = await runCommands(commands);
  return { label, ok: result.code === 0, result };
}

async function runGates(entries) {
  const results = await Promise.all(
    entries.map(([label, commands]) => executeGate(label, commands)),
  );
  for (const result of results) {
    if (result.skipped) {
      skip(`${result.label}: not configured`);
    } else if (result.ok) {
      ok(result.label);
    } else {
      fail(result.label);
      printFailure(result.result);
    }
  }
}

// ─── State, backlog, activities ─────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { stage: "planning", missing: true };
  }
  const data = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  if (!["planning", "development"].includes(data.stage)) {
    throw new Error(`invalid stage "${data.stage}" in .harness/state.json`);
  }
  return data;
}

function saveState(state) {
  mkdirSync(HARNESS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function loadBacklog() {
  const path = join(ROOT, CONFIG.planning.stories);
  if (!existsSync(path)) {
    throw new Error(`${CONFIG.planning.stories} is missing`);
  }
  return parseBacklog(readFileSync(path, "utf-8"));
}

function loadActivities() {
  const path = join(ROOT, "activities.json");
  if (!existsSync(path)) {
    warn("activities.json missing; create it from assets/activities.schema.json.");
    return [];
  }
  return normalizeActivities(JSON.parse(readFileSync(path, "utf-8")));
}

function loadApprovals() {
  if (!existsSync(APPROVALS_PATH)) {
    return { stories: {} };
  }
  try {
    return JSON.parse(readFileSync(APPROVALS_PATH, "utf-8"));
  } catch {
    return { stories: {} };
  }
}

function appendHistory(lines) {
  const path = join(ROOT, "progress", "history.md");
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, "# Session History\n\n---\n", "utf-8");
  }
  appendFileSync(path, `\n${lines.trim()}\n`, "utf-8");
}

function requireDevelopment(context) {
  if (stage !== "development") {
    fail(
      `${context} is blocked: stage=${stage}. Only PLANNING gates run until ` +
        "the user approves `--start-dev`.",
    );
    process.exit(1);
  }
}

function validatePlan(activities, stories) {
  const errors = validateActivities(activities, stories);
  for (const error of errors) {
    fail(`activities.json: ${error}`);
  }
  if (errors.length === 0) {
    ok(`activities.json valid (${activities.length} activities)`);
  }
  return errors.length === 0;
}

const stageState = (() => {
  try {
    return loadState();
  } catch (error) {
    fail(error.message);
    process.exit(1);
  }
})();
const stage = stageState.stage;
if (stageState.missing) {
  warn("No .harness/state.json; assuming PLANNING. Run scripts/build_harness.mjs.");
}

// ─── Planning gates ─────────────────────────────────────────────────────────
function walkFiles(dir, extensions, out = []) {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (CONFIG.structure.ignoreDirs.includes(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, extensions, out);
    } else if (extensions.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function countWords(source) {
  return source.trim().split(/\s+/).filter(Boolean).length;
}

function runBacklogGate() {
  let backlog;
  try {
    backlog = loadBacklog();
  } catch (error) {
    fail(`backlog: ${error.message}`);
    return null;
  }
  for (const error of backlog.errors) {
    fail(`backlog: ${error}`);
  }
  if (backlog.stories.length === 0) {
    fail("backlog: no user stories (add at least one ## US-001 heading)");
  }
  const active = backlog.stories.filter((story) => story.status === "active");
  if (active.length > 1) {
    fail(`backlog: ${active.length} active stories (max 1)`);
  }
  const awaiting = backlog.stories.filter((story) => story.status === "awaiting-approval");
  if (awaiting.length > 1) {
    fail(`backlog: ${awaiting.length} stories await approval (max 1)`);
  }
  if (backlog.errors.length === 0 && backlog.stories.length > 0) {
    ok(`backlog (${backlog.stories.length} stories)`);
  }
  return backlog;
}

function runPlanningDocs() {
  let docsOk = true;
  for (const doc of CONFIG.planning.docs) {
    const path = join(ROOT, doc.path);
    if (!existsSync(path)) {
      fail(`planning docs: missing ${doc.path}`);
      docsOk = false;
      continue;
    }
    const words = countWords(readFileSync(path, "utf-8"));
    if (words < (doc.minWords ?? 50)) {
      fail(`planning docs: ${doc.path} looks like a placeholder (${words} words)`);
      docsOk = false;
    }
  }
  if (docsOk) {
    ok(`planning docs (${CONFIG.planning.docs.length} files)`);
  }
}

function runPlanningStructure() {
  let structureOk = true;
  for (const dir of CONFIG.planning.requiredDirs) {
    if (!existsSync(join(ROOT, dir))) {
      fail(`planning structure: missing ${dir}`);
      structureOk = false;
    }
  }
  if (structureOk) {
    ok("planning structure");
  }
}

function runPuml() {
  const files = walkFiles(join(ROOT, "docs", "planning"), [".puml", ".plantuml"]);
  if (files.length === 0) {
    fail("puml: no diagrams under docs/planning (C4 and sequences are required)");
    return;
  }
  let pumlOk = true;
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const start = (source.match(/@startuml/g) ?? []).length;
    const end = (source.match(/@enduml/g) ?? []).length;
    if (start === 0 || start !== end) {
      fail(`puml: ${relative(ROOT, file)} has unbalanced @startuml/@enduml (${start}/${end})`);
      pumlOk = false;
    }
    if (/@startuml\s*\n\s*@enduml/.test(source)) {
      fail(`puml: ${relative(ROOT, file)} is empty`);
      pumlOk = false;
    }
  }
  if (pumlOk) {
    ok(`puml (${files.length} diagrams)`);
  }
}

function runDocsgenConfig() {
  if (!CONFIG.gates.docsgen || CONFIG.gates.docsgen.length === 0) {
    fail(
      "docsgen: no documentation generator configured. Choose one (TypeDoc, " +
        "Sphinx, rustdoc, godoc, Dokka, Doxygen) and set CONFIG.gates.docsgen " +
        "before leaving PLANNING.",
    );
    return;
  }
  ok("docsgen: generator configured");
}

async function runPlanningGates() {
  info("stage=planning — foundation only; code, tests and gates are locked.");
  runPlanningStructure();
  runBacklogGate();
  runPlanningDocs();
  runPuml();
  runDocsgenConfig();
  if (CONFIG.selfTest && existsSync(join(ROOT, CONFIG.selfTest[1] ?? ""))) {
    await runGates([["harness self-test", [CONFIG.selfTest]]]);
  }
}

// ─── Change detection ───────────────────────────────────────────────────────
async function gitFileList(args) {
  const result = await run("git", args);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

async function getChangedFiles({ includeLastCommit = false } = {}) {
  const files = new Set();
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    for (const file of await gitFileList(args)) {
      files.add(file);
    }
  }
  if (files.size === 0 && includeLastCommit) {
    for (const file of await gitFileList(["diff", "--name-only", "HEAD~1"])) {
      files.add(file);
    }
  }
  return [...files].sort();
}

async function changedFilesForRun(includeLastCommit = false) {
  if (changedFilesCache) {
    return changedFilesCache;
  }
  changedFilesCache = await getChangedFiles({ includeLastCommit });
  return changedFilesCache;
}

function isStatePath(file) {
  return STATE_PATHS.some((prefix) => file === prefix || file.startsWith(prefix));
}

function runTouchesCheck(allowedTouches, label, files) {
  const offenders = files.filter(
    (file) => !isStatePath(file) && !pathMatchesTouches(file, allowedTouches),
  );
  if (offenders.length > 0) {
    fail(`touches: ${label} changed files outside the batch scope:\n  ` + offenders.join("\n  "));
  } else {
    ok(`touches (${label} stayed inside ${allowedTouches.join(", ")})`);
  }
}

// ─── Gate assembly ──────────────────────────────────────────────────────────
async function fileCheckEntries(mode) {
  const entries = [];
  if (mode.format === "skip" && mode.lint === "skip") {
    skip("format/lint: skipped");
    return entries;
  }
  if (mode.format === "all") {
    entries.push(["format", CONFIG.gates.format.full]);
  }
  if (mode.lint === "all") {
    entries.push(["lint", CONFIG.gates.lint.full]);
  }
  if (mode.format === "changed" || mode.lint === "changed") {
    const files = (await changedFilesForRun(mode.step === "activity")).filter((file) =>
      existsSync(join(ROOT, file)),
    );
    if (files.length === 0) {
      skip("format/lint: no changed files");
      return entries;
    }
    if (mode.format === "changed") {
      entries.push(["format (changed)", CONFIG.gates.format.changed(files)]);
    }
    if (mode.lint === "changed") {
      const lintFiles = files.filter((file) => CONFIG.gates.lint.filter?.(file) ?? true);
      if (lintFiles.length === 0) {
        skip("lint: no lintable changed files");
      } else {
        entries.push(["lint (changed)", CONFIG.gates.lint.changed(lintFiles)]);
      }
    }
  }
  return entries;
}

async function typeEntry(mode) {
  if (mode.type === "skip") {
    skip("type: skipped");
    return null;
  }
  if (mode.type === "all") {
    return ["type", CONFIG.gates.type.full];
  }
  const files = await changedFilesForRun(mode.step === "activity");
  const commands = CONFIG.gates.type.affected(files);
  if (!commands) {
    skip("type: no affected package");
    return null;
  }
  return ["type (affected)", commands];
}

async function testEntry(mode) {
  if (mode.test === "skip") {
    skip("test: skipped");
    return null;
  }
  if (mode.test === "all") {
    return ["test", CONFIG.gates.test.full];
  }
  const files = await changedFilesForRun(mode.step === "activity");
  if (files.length === 0) {
    warn("test: no changed files; using fallback");
    return ["test (fallback)", CONFIG.specs.fallback];
  }
  const specs = new Set();
  const unmapped = [];
  for (const file of files) {
    if (!CONFIG.testRoots.some((root) => file.startsWith(root))) {
      continue;
    }
    if (CONFIG.specs.pattern.test(file)) {
      if (existsSync(join(ROOT, file))) {
        specs.add(file);
      }
      continue;
    }
    const candidate = CONFIG.specs.candidates(file).find((item) => existsSync(join(ROOT, item)));
    if (candidate) {
      specs.add(candidate);
    } else {
      unmapped.push(file);
    }
  }
  if (unmapped.length > 0 || specs.size === 0) {
    warn(
      unmapped.length > 0
        ? `test: no sibling spec for ${unmapped.join(", ")}; using fallback`
        : "test: no targeted spec matched; using fallback",
    );
    return ["test (fallback)", CONFIG.specs.fallback];
  }
  return ["test (targeted)", CONFIG.specs.command([...specs].sort())];
}

function runStructure() {
  const rules = CONFIG.structure;
  if (
    rules.requiredDirs.length === 0 &&
    rules.forbidden.length === 0 &&
    rules.maxLines.length === 0
  ) {
    ok("structure: no project-specific rules configured");
    return;
  }
  let structureOk = true;
  for (const dir of rules.requiredDirs) {
    if (!existsSync(join(ROOT, dir))) {
      fail(`structure: missing required directory ${dir}`);
      structureOk = false;
    }
  }
  for (const rule of rules.forbidden) {
    for (const file of walkFiles(join(ROOT, rule.dir), rule.extensions)) {
      if (rule.pattern.test(readFileSync(file, "utf-8"))) {
        fail(`structure: ${relative(ROOT, file)} violates ${rule.message}`);
        structureOk = false;
      }
    }
  }
  for (const rule of rules.maxLines) {
    for (const file of walkFiles(join(ROOT, rule.dir), rule.extensions)) {
      if (rule.exclude?.some((pattern) => pattern.test(file))) {
        continue;
      }
      const lines = readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line.trim() && !/^\s*(\/\/|#|\/\*)/.test(line)).length;
      if (lines > rule.limit) {
        fail(`structure: ${relative(ROOT, file)} has ${lines} code lines (limit ${rule.limit})`);
        structureOk = false;
      }
    }
  }
  if (structureOk) {
    ok("structure");
  }
}

function runDocsGate() {
  if (CONFIG.docs.length === 0) {
    skip("docs: no required docs configured");
    return;
  }
  let docsOk = true;
  for (const doc of CONFIG.docs) {
    const path = join(ROOT, doc.path);
    if (!existsSync(path)) {
      fail(`docs: missing ${doc.path}`);
      docsOk = false;
      continue;
    }
    const words = countWords(readFileSync(path, "utf-8"));
    if (words < (doc.minWords ?? 50)) {
      fail(`docs: ${doc.path} looks like a placeholder (${words} words)`);
      docsOk = false;
    }
  }
  if (docsOk) {
    ok(`docs (${CONFIG.docs.length} files)`);
  }
}

async function runDocsgen() {
  if (!CONFIG.gates.docsgen || CONFIG.gates.docsgen.length === 0) {
    fail("docsgen: not configured; the documentation system is mandatory");
    return;
  }
  await runGates([["docsgen", CONFIG.gates.docsgen]]);
}

async function runDevGates(mode) {
  if (CONFIG.selfTest && existsSync(join(ROOT, CONFIG.selfTest[1] ?? ""))) {
    await runGates([["harness self-test", [CONFIG.selfTest]]]);
  }

  const phase1 = await fileCheckEntries(mode);
  const type = await typeEntry(mode);
  if (type) {
    phase1.push(type);
  }
  if (phase1.length > 0) {
    await runGates(phase1);
  }

  if (mode.structure !== "skip") {
    runStructure();
  }
  if (mode.docs !== "skip") {
    runDocsGate();
  }

  const heavy = [];
  const test = await testEntry(mode);
  if (test) {
    heavy.push(test);
  }
  if (mode.build !== "skip") {
    heavy.push(["build", CONFIG.gates.build.full]);
  }
  if (heavy.length > 0) {
    await runGates(heavy);
  }

  if (mode.contract !== "skip" && CONFIG.gates.contract) {
    await runGates([["contract", CONFIG.gates.contract]]);
  } else if (mode.contract !== "skip") {
    skip("contract: not configured");
  }

  if (mode.docsgen === "yes") {
    await runDocsgen();
  }

  if (CONFIG.gates.docblocks) {
    await runGates([["docblocks", CONFIG.gates.docblocks]]);
  }
}

// ─── Story and activity commands ────────────────────────────────────────────
function resolveStory(ref) {
  const backlog = loadBacklog();
  for (const error of backlog.errors) {
    fail(`backlog: ${error}`);
  }
  const story = ref ? findStory(backlog.stories, ref) : activeStory(backlog.stories);
  if (!story) {
    fail(
      ref
        ? `story ${ref} not found in ${CONFIG.planning.stories}`
        : "no active story; set one story to `- status: active`",
    );
    process.exit(1);
  }
  return { story, backlog };
}

function writeSchedule(story, batches, blocked) {
  mkdirSync(HARNESS_DIR, { recursive: true });
  const payload = {
    storyId: story.id,
    generatedAt: new Date().toISOString(),
    batches: batches.map((batch) => batch.map((activity) => activity.id)),
    blocked,
  };
  writeFileSync(SCHEDULE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload;
}

function printSchedule(payload) {
  if (payload.batches.length === 0) {
    info("no pending batches: the story is complete");
  }
  payload.batches.forEach((batch, index) => {
    const label = batch.length > 1 ? "parallel" : "serial  ";
    console.log(`batch ${index + 1}  ${label}  ${batch.join(" | ")}`);
  });
  for (const item of payload.blocked ?? []) {
    warn(`${item.id} is blocked; missing: ${item.missing.join(", ") || "unknown"}`);
  }
  if (payload.batches[0]?.length > 1) {
    info(
      `batch 1 has ${payload.batches[0].length} independent activities: launch ` +
        `${payload.batches[0].length} task-executor subagents in ONE message.`,
    );
  }
}

function writeClaim(activity, batch) {
  mkdirSync(CLAIMS_DIR, { recursive: true });
  const payload = {
    activityId: activity.id,
    storyId: activity.storyId,
    batch: batch.map((item) => item.id),
    batchSize: batch.length,
    touches: activity.touches,
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(CLAIMS_DIR, `${activity.id}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
}

function readClaims() {
  if (!existsSync(CLAIMS_DIR)) {
    return [];
  }
  const claims = [];
  for (const name of readdirSync(CLAIMS_DIR)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const claim = JSON.parse(readFileSync(join(CLAIMS_DIR, name), "utf-8"));
      if (claim?.activityId) {
        claims.push(claim);
      }
    } catch {
      warn(`ignoring unreadable claim ${name}`);
    }
  }
  return claims;
}

function clearClaims() {
  if (!existsSync(CLAIMS_DIR)) {
    return;
  }
  for (const name of readdirSync(CLAIMS_DIR)) {
    if (name.endsWith(".json")) {
      unlinkSync(join(CLAIMS_DIR, name));
    }
  }
}

function releaseClaim(activityId) {
  const path = join(CLAIMS_DIR, `${activityId}.json`);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

async function commandStage() {
  console.log(`stage: ${stage}`);
  try {
    const { stories } = loadBacklog();
    const counts = {};
    for (const story of stories) {
      counts[story.status] = (counts[story.status] ?? 0) + 1;
    }
    console.log(
      `stories: ${stories.length} (${
        Object.entries(counts)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ") || "none"
      })`,
    );
    const active = activeStory(stories);
    console.log(`active story: ${active ? `${active.id} — ${active.title}` : "none"}`);
  } catch (error) {
    warn(`backlog: ${error.message}`);
  }

  if (stage === "development") {
    try {
      const activities = loadActivities();
      const active = activeStory(loadBacklog().stories);
      if (active) {
        const { batches, blocked } = planBatches(activities, active.id);
        console.log(
          `next batch: ${batches[0]?.map((activity) => activity.id).join(", ") || "none"}`,
        );
        if (blocked.length > 0) {
          console.log(`blocked: ${blocked.map((item) => item.id).join(", ")}`);
        }
      }
      const claims = readClaims().filter((claim) => claim.activityId);
      console.log(`claims: ${claims.map((claim) => claim.activityId).join(", ") || "none"}`);
    } catch (error) {
      warn(`activities: ${error.message}`);
    }
  }
}

async function commandSchedule() {
  requireDevelopment("--schedule");
  const { story } = resolveStory(SCHEDULE_STORY);
  if (story.status !== "active") {
    fail(`story ${story.id} is ${story.status}; only an active story is scheduled`);
    process.exit(1);
  }
  const activities = loadActivities();
  const { stories } = loadBacklog();
  validatePlan(activities, stories);
  const { batches, blocked } = planBatches(activities, story.id);
  clearClaims();
  const payload = writeSchedule(story, batches, blocked);
  printSchedule(payload);
  if (exitCode !== 0) {
    process.exit(1);
  }
}

async function commandClaim() {
  requireDevelopment("--claim");
  if (!CLAIM) {
    fail("--claim requires an activity id (example: --claim ACT-01)");
    process.exit(1);
  }
  const { story } = resolveStory(null);
  const activities = loadActivities();
  const { stories } = loadBacklog();
  validatePlan(activities, stories);
  const activity = activities.find((item) => item.id === CLAIM);
  if (!activity) {
    fail(`activity ${CLAIM} not found`);
    process.exit(1);
  }
  if (activity.storyId !== story.id) {
    fail(`activity ${CLAIM} belongs to ${activity.storyId}, not the active story ${story.id}`);
    process.exit(1);
  }
  const { batches } = planBatches(activities, story.id);
  const batch = batches.find((items) => items.some((item) => item.id === CLAIM));
  const schedule = { batches };
  const errors = claimErrors(activity, activities, schedule);
  if (errors.length > 0) {
    for (const error of errors) {
      fail(error);
    }
    process.exit(1);
  }
  writeClaim(activity, batch);
  const batchKey = batch.map((item) => item.id).join(",");
  const claims = readClaims().filter((claim) => (claim.batch ?? []).join(",") === batchKey);
  ok(
    `claimed ${CLAIM} — batch ${batch.map((item) => item.id).join(", ")} ` +
      `(${claims.length}/${batch.length} claimed)`,
  );
  if (claims.length < batch.length) {
    info(
      `batch incomplete: launch the remaining ${batch.length - claims.length} ` +
        "task-executor subagent(s) before editing; the plugin blocks edits until " +
        "the whole batch is claimed.",
    );
  }
}

async function commandApproveStory() {
  requireDevelopment("--approve-story");
  if (!APPROVE_STORY) {
    fail("--approve-story requires a story id (example: --approve-story US-001)");
    process.exit(1);
  }
  if (!BY) {
    fail("--approve-story requires --by <name> (record who approved)");
    process.exit(1);
  }
  const { story } = resolveStory(APPROVE_STORY);
  if (story.status !== "awaiting-approval") {
    fail(
      `story ${story.id} is ${story.status}; set "- status: awaiting-approval" ` +
        "in BACKLOG.md after the agent presents the evidence, then ask the user.",
    );
    process.exit(1);
  }
  const approvals = loadApprovals();
  approvals.stories[story.id] = { by: BY, at: new Date().toISOString() };
  mkdirSync(HARNESS_DIR, { recursive: true });
  writeFileSync(APPROVALS_PATH, `${JSON.stringify(approvals, null, 2)}\n`, "utf-8");
  appendHistory(
    `## ${story.id} — ${story.title}\n\n- approved by: ${BY} at ${new Date().toISOString()}\n`,
  );
  ok(`recorded user approval for ${story.id} (by ${BY})`);
  info("run `--story " + story.id + "` to confirm the full gate before marking it done.");
}

async function commandActivity() {
  requireDevelopment("--activity");
  if (!ACTIVITY) {
    fail("--activity requires an activity id (example: --activity ACT-01)");
    process.exit(1);
  }
  const { story } = resolveStory(null);
  const activities = loadActivities();
  const { stories } = loadBacklog();
  validatePlan(activities, stories);
  const activity = activities.find((item) => item.id === ACTIVITY);
  if (!activity) {
    fail(`activity ${ACTIVITY} not found`);
    process.exit(1);
  }
  if (activity.storyId !== story.id) {
    fail(`${ACTIVITY} belongs to ${activity.storyId}, not the active story ${story.id}`);
    process.exit(1);
  }
  if (!readClaims().some((claim) => claim.activityId === ACTIVITY)) {
    warn(`${ACTIVITY} was not claimed with --claim; the plugin cannot verify the batch`);
  }
  const claim = readClaims().find((item) => item.activityId === ACTIVITY);
  const batchIds = claim?.batch?.length ? claim.batch : [ACTIVITY];
  const allowedTouches = batchIds
    .map((id) => activities.find((item) => item.id === id)?.touches ?? [])
    .flat();
  info(`activity ${ACTIVITY} — ${activity.name}`);
  const mode = modeForStep("activity");
  if (EXPLAIN) {
    console.log(`checks: ${describeMode(mode)}`);
    return;
  }
  await runDevGates(mode);
  runTouchesCheck(
    allowedTouches,
    `${ACTIVITY} (batch ${batchIds.join(", ")})`,
    await getChangedFiles(),
  );
  if (exitCode === 0) {
    releaseClaim(ACTIVITY);
    ok(`activity ${ACTIVITY} is green; mark its tasks and the activity done`);
    info("verify the remaining batch members, then run --schedule again");
  }
  process.exit(exitCode);
}

async function commandStory() {
  requireDevelopment("--story");
  if (!STORY) {
    fail("--story requires a story id (example: --story US-001)");
    process.exit(1);
  }
  const { story } = resolveStory(STORY);
  const activities = loadActivities();
  const { stories } = loadBacklog();
  validatePlan(activities, stories);

  if (story.status !== "awaiting-approval" && story.status !== "active") {
    fail(`story ${story.id} is ${story.status}; it cannot be closed`);
    process.exit(1);
  }
  const scoped = storyActivities(activities, story.id);
  if (scoped.length === 0) {
    fail(`story ${story.id} has no activities`);
    process.exit(1);
  }
  const pending = scoped.filter((activity) => activity.status !== "done");
  if (pending.length > 0) {
    fail(
      `story ${story.id} still has open activities: ` +
        pending.map((activity) => `${activity.id} (${activity.status})`).join(", "),
    );
    process.exit(1);
  }
  if (!storyIsComplete(activities, story.id)) {
    fail(`story ${story.id} is not complete`);
    process.exit(1);
  }

  const approval = loadApprovals().stories[story.id];
  info(`story ${story.id} — ${story.title}`);
  const mode = modeForStep("story");
  if (EXPLAIN) {
    console.log(`checks: ${describeMode(mode)}`);
    return;
  }
  await runDevGates(mode);

  if (exitCode !== 0) {
    process.exit(1);
  }
  if (!approval) {
    console.log(
      `${YELLOW}[WAITING]${NC} gates are green. User approval is required: ` +
        "present the evidence, ask the user, then run " +
        `\`--approve-story ${story.id} --by <name>\`.`,
    );
    process.exit(3);
  }
  ok(
    `story ${story.id} is green and approved by ${approval.by} ` +
      `(${approval.at}); mark it done in BACKLOG.md`,
  );
  writeFileSync(
    LAST_STORY_PATH,
    `${JSON.stringify({ storyId: story.id, at: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
  process.exit(0);
}

async function commandStartDev() {
  if (stage === "development") {
    fail("already in development; the transition is one-way and cannot repeat");
    process.exit(1);
  }
  if (!USER_APPROVED) {
    fail(
      "--start-dev requires --user-approved. Ask the user first: development " +
        "locks out PLANNING, and implementation/tests become the focus.",
    );
    process.exit(1);
  }
  await runPlanningGates();
  if (exitCode !== 0) {
    fail("planning gates must be green before entering development");
    process.exit(1);
  }
  const now = new Date().toISOString();
  saveState({
    stage: "development",
    startedAt: now,
    approvedBy: BY ?? "user",
    previousStage: "planning",
  });
  appendHistory(
    `## PLANNING -> DEVELOPMENT\n\n- at: ${now}\n- approved by: ${BY ?? "user"}\n- planning is closed: it cannot be re-entered.\n`,
  );
  ok("stage=development. Planning artifacts stay editable, but the stage does not.");
  info("next: pick a story, set it to `status: active`, then run --schedule");
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (STAGE) {
    await commandStage();
    process.exit(exitCode);
  }

  if (START_DEV) {
    await commandStartDev();
    process.exit(exitCode);
  }

  if (stage === "planning") {
    const devCommands = SCHEDULE || CLAIM || ACTIVITY || STORY || APPROVE_STORY || FAST || CHANGED;
    if (devCommands) {
      fail(
        "[BLOCKED] development commands are not available in stage=planning. " +
          "Finish the foundation, ask the user, then run " +
          "--start-dev --user-approved.",
      );
      process.exit(1);
    }
    if (EXPLAIN) {
      console.log("stage=planning");
      console.log(
        "checks: planning-structure, backlog, planning-docs, puml, docsgen-config, harness self-test",
      );
      process.exit(0);
    }
    await runPlanningGates();
    if (exitCode === 0) {
      info(
        "planning is not the end state: ask the user for approval, then run " +
          "`--start-dev --user-approved --by <name>`.",
      );
    }
    process.exit(exitCode);
  }

  // stage === development
  if (PLANNING) {
    fail(
      "[BLOCKED] development cannot return to planning. Edit docs/planning/** " +
        "in place if a decision changes; the stage stays development.",
    );
    process.exit(1);
  }

  if (SCHEDULE) {
    await commandSchedule();
    process.exit(exitCode);
  }
  if (CLAIM) {
    await commandClaim();
    process.exit(exitCode);
  }
  if (APPROVE_STORY) {
    await commandApproveStory();
    process.exit(exitCode);
  }
  if (ACTIVITY) {
    await commandActivity();
    return;
  }
  if (STORY) {
    await commandStory();
    return;
  }

  const mode = FAST ? modeForStep("fast") : modeForStep("iteration");
  if (EXPLAIN) {
    console.log(`stage=development, step=${mode.step}`);
    console.log(`checks: ${describeMode(mode)}`);
    process.exit(0);
  }
  info(`stage=development, step=${mode.step}`);
  await runDevGates(mode);
  if (exitCode === 0) {
    ok("green. Iterate with --fast; close an activity with --activity ACT-x.");
  } else {
    fail("red. Fix the code or the gate before advancing.");
  }
  process.exit(exitCode);
}

main().catch((error) => {
  fail(error.stack ?? error.message);
  process.exit(1);
});
