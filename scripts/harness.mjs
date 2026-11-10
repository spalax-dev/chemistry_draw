#!/usr/bin/env node
/**
 * Verification harness for the chemistry-draw project.
 *
 * Run with: node scripts/harness.mjs [options]
 *
 *   (default)         Full verification (all blocks).
 *   --fast            Iteration mode: skip frontend build, use `cargo check`
 *                     instead of Clippy, and skip sidecar tests.
 *   --skip-build      Skip block 8 (frontend build).
 *   --skip-clippy     Use `cargo check` instead of Clippy in block 10.
 *   --skip-tests      Skip block 11 (sidecar tests).
 *   --explain         Print the resolved mode and run the checks.
 *   --help            Show this help.
 *
 * Checks, in order:
 *  1. Environment (rustc/cargo, node/pnpm, Tauri plugin version parity)
 *  2. Base harness files exist (AGENTS.md, activities.json, progress/, docs/)
 *  3. Activity policy: run scripts/lib/activity-policy.test.mjs, then validate
 *     activities.json (phases docs → test → implement → review, statuses,
 *     agents, one in_progress at most)
 *  4. Native Indigo libraries are present (`task libs` generates them)
 *  5. TypeScript typecheck (`pnpm exec tsc --noEmit`)
 *  6. ESLint (`pnpm run lint`)
 *  7. Prettier formatting (`pnpm run format:check`)
 *  8. Frontend build (`pnpm build`) [skipped by --fast/--skip-build]
 *  9. Rust formatting (`cargo fmt --all --check`)
 * 10. Rust lint (`cargo clippy -- -D warnings`; `cargo check` with --fast/--skip-clippy)
 * 11. Sidecar tests (`cargo test -p indigo-server`) [skipped by --fast/--skip-tests]
 * 12. ShellCheck (shell scripts, warnings and above)
 * 13. Summary
 *
 * Exit code 0 only when every executed block passes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateActivities } from "./lib/activity-policy.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const LIB_DIR_NAME = IS_WINDOWS ? "windows-x86_64" : "linux-x86_64";
const LIB_DIR = path.join(PROJECT_ROOT, "src-tauri", "lib", LIB_DIR_NAME);

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const NC = "\x1b[0m";

let exitCode = 0;

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const HELP = hasFlag("--help");
const FAST = hasFlag("--fast");
const EXPLAIN = hasFlag("--explain");
const SKIP_BUILD = FAST || hasFlag("--skip-build");
const SKIP_CLIPPY = FAST || hasFlag("--skip-clippy");
const SKIP_TESTS = FAST || hasFlag("--skip-tests");

function printHelp() {
  console.log(`Usage: node scripts/harness.mjs [options]

  (default)         Full verification (all blocks).
  --fast            Iteration mode: skip frontend build, use cargo check
                    instead of Clippy, and skip sidecar tests.
  --skip-build      Skip block 8 (frontend build).
  --skip-clippy     Use cargo check instead of Clippy in block 10.
  --skip-tests      Skip block 11 (sidecar tests).
  --explain         Print the resolved mode and run the checks.
  --help            Show this help.`);
}

if (HELP) {
  printHelp();
  process.exit(0);
}

const ok = (msg) => console.log(`${GREEN}[OK]${NC}    ${msg}`);
const warn = (msg) => console.log(`${YELLOW}[WARN]${NC}  ${msg}`);
const fail = (msg) => {
  console.log(`${RED}[FAIL]${NC}  ${msg}`);
  exitCode = 1;
};

if (EXPLAIN || FAST || SKIP_BUILD || SKIP_CLIPPY || SKIP_TESTS) {
  const mode = [
    `fast=${FAST}`,
    `skipBuild=${SKIP_BUILD}`,
    `skipClippy=${SKIP_CLIPPY}`,
    `skipTests=${SKIP_TESTS}`,
  ].join(", ");
  console.log(`${YELLOW}[MODE]${NC}  ${mode}`);
}

/** Run a command in the project root with inherited stdio. */
function run(cmd, args, env) {
  return spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    // Windows resolves pnpm/node shims through cmd.exe.
    shell: IS_WINDOWS,
    env: env ?? process.env,
  });
}

/** Run a command and capture stdout/stderr. */
function capture(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    shell: IS_WINDOWS,
  });
}

/** Return the first line of a command's version output, or a placeholder. */
function versionOf(cmd, args) {
  const result = capture(cmd, args);
  const text = (result.stdout || result.stderr || "").trim();
  return text.split("\n")[0] || "(version unavailable)";
}

/**
 * Prepend a directory to PATH without creating a duplicate key.
 *
 * Windows environment blocks are case-insensitive, but a spread of
 * `process.env` can contain `Path`; assigning `env.PATH` would add a second
 * key and the child process might pick the wrong one. Set the existing key
 * and drop any case variants.
 */
function prependToPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  if (!key) {
    env.PATH = dir;
    return env;
  }
  env[key] = env[key] ? `${dir}${path.delimiter}${env[key]}` : dir;
  for (const other of Object.keys(env)) {
    if (other !== key && other.toUpperCase() === "PATH") delete env[other];
  }
  return env;
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

// Tauri refuses to bundle when a plugin crate and its npm package are on
// different major/minor versions (they communicate over the same IPC schema).
// The CLI only reports this at bundle time, so check it here instead.
const cargoLock = readFileSync(path.join(PROJECT_ROOT, "Cargo.lock"), "utf8");
const minor = (version) => version.split(".").slice(0, 2).join(".");

// The same rule applies to the core package (tauri crate vs @tauri-apps/api).
const apiManifest = path.join(PROJECT_ROOT, "node_modules", "@tauri-apps", "api", "package.json");
if (existsSync(apiManifest)) {
  const apiVersion = JSON.parse(readFileSync(apiManifest, "utf8")).version;
  const crate = cargoLock.match(/name = "tauri"\nversion = "([^"]+)"/);
  if (!crate) {
    warn(`tauri: not found in Cargo.lock (npm api ${apiVersion})`);
  } else if (minor(crate[1]) === minor(apiVersion)) {
    ok(`tauri ${crate[1]} / npm api ${apiVersion}`);
  } else {
    fail(
      `tauri version mismatch: crate ${crate[1]} vs npm api ${apiVersion} ` +
        "(align major.minor or the Tauri bundler will refuse)",
    );
  }
}

for (const plugin of ["log", "dialog", "fs", "opener", "shell"]) {
  const npmManifest = path.join(
    PROJECT_ROOT,
    "node_modules",
    "@tauri-apps",
    `plugin-${plugin}`,
    "package.json",
  );
  if (!existsSync(npmManifest)) continue;

  const npmVersion = JSON.parse(readFileSync(npmManifest, "utf8")).version;
  const crate = cargoLock.match(
    new RegExp(`name = "tauri-plugin-${plugin}"\\nversion = "([^"]+)"`),
  );
  if (!crate) {
    warn(`tauri-plugin-${plugin}: not found in Cargo.lock (npm ${npmVersion})`);
    continue;
  }

  const minor = (version) => version.split(".").slice(0, 2).join(".");
  if (minor(crate[1]) === minor(npmVersion)) {
    ok(`tauri-plugin-${plugin} ${crate[1]} / npm ${npmVersion}`);
  } else {
    fail(
      `tauri-plugin-${plugin} version mismatch: crate ${crate[1]} vs npm ${npmVersion} ` +
        "(align major.minor or the Tauri bundler will refuse)",
    );
  }
}

console.log("\n── 2. Base Harness Files ─────────────────────────────");

const baseFiles = [
  "AGENTS.md",
  "scripts/harness.mjs",
  "scripts/build-harness.mjs",
  "activities.json",
  "progress/current.md",
  "progress/history.md",
  "docs/architecture.md",
  "docs/conventions.md",
  "docs/verification.md",
  "docs/CHECKPOINTS.md",
  "docs/testing.md",
  "scripts/lib/activity-policy.mjs",
  "scripts/lib/activity-policy.test.mjs",
];

for (const file of baseFiles) {
  if (existsSync(path.join(PROJECT_ROOT, file))) {
    ok(`Exists ${file}`);
  } else {
    fail(`Missing base file: ${file}`);
  }
}

console.log("\n── 3. Activity Policy & activities.json ──────────────");

const policyTests = readdirSync(path.join(PROJECT_ROOT, "scripts", "lib"))
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => path.join("scripts", "lib", file));

if (run("node", ["--test", ...policyTests]).status === 0) {
  ok(`Activity and workflow policy tests pass (${policyTests.length} files)`);
} else {
  fail("Activity or workflow policy tests failed");
}

try {
  const data = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "activities.json"), "utf8"));
  const { errors, warnings } = validateActivities(data);

  for (const message of warnings) {
    warn(message);
  }
  for (const message of errors) {
    fail(message);
  }

  if (errors.length === 0) {
    const activities = Array.isArray(data) ? data : (data.activities ?? []);
    ok(`activities.json valid (${activities.length} activities)`);
  }
} catch (error) {
  fail(`activities.json invalid: ${error.message}`);
}

console.log("\n── 4. Native Libraries ───────────────────────────────");
// Linux: `task libs` builds Indigo in the Docker builder.
// Windows: `scripts/fetch-windows-libs.ps1` downloads Indigo 1.46.0 and
// generates the MSVC import libraries.

const requiredLibs = IS_WINDOWS
  ? [
      "indigo.dll",
      "indigo-renderer.dll",
      "msvcp140.dll",
      "vcruntime140.dll",
      "vcruntime140_1.dll",
      "indigo.lib",
      "indigo-renderer.lib",
    ]
  : ["libindigo.so", "libindigo-renderer.so"];
const libExtension = IS_WINDOWS ? ".dll" : ".so";
const missing = requiredLibs.filter((lib) => !existsSync(path.join(LIB_DIR, lib)));
let haveLibs = false;

if (missing.length > 0) {
  fail(
    `Missing native libraries in ${path.relative(PROJECT_ROOT, LIB_DIR)}: ` + missing.join(", "),
  );
  if (IS_WINDOWS) {
    warn("Run `pwsh scripts/fetch-windows-libs.ps1` from a VS x64 developer shell.");
  } else {
    warn("Run `task libs` (needs Docker) to generate them.");
  }
  warn("Blocks 10 and 11 will be skipped until they exist.");
} else {
  const count = readdirSync(LIB_DIR).filter((f) => f.endsWith(libExtension)).length;
  ok(`Native libraries present (${count} ${libExtension} files)`);
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

if (SKIP_BUILD) {
  warn("Skipped (--fast/--skip-build): frontend build not run");
} else if (run("pnpm", ["build"]).status === 0) {
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
} else if (SKIP_CLIPPY) {
  warn("Using cargo check (--fast/--skip-clippy); Clippy not run");
  if (run("cargo", ["check", "--workspace", "--all-targets"]).status === 0) {
    ok("cargo check passed");
  } else {
    fail("cargo check failed");
  }
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

if (SKIP_TESTS) {
  warn("Skipped (--fast/--skip-tests): sidecar tests not run");
} else if (haveLibs) {
  const env = { ...process.env };
  if (IS_WINDOWS) {
    // Windows resolves the bundled DLLs through PATH.
    prependToPath(env, LIB_DIR);
  } else {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${LIB_DIR}:${env.LD_LIBRARY_PATH}` : LIB_DIR;
  }

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

if (IS_WINDOWS) {
  warn("Skipped on Windows: the shell scripts are POSIX-only (CI runs ShellCheck on Linux)");
} else if (!commandExists("shellcheck")) {
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
