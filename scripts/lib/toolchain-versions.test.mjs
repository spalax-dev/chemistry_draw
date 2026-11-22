// Contract tests for the 0.x toolchain pins (docs/TOOLCHAIN.md §1 and §3.3).
//
// The pins live in package.json, .nvmrc, scripts/Dockerfile and the GitHub
// workflows/composite actions. Nothing here runs a build: the tests read those
// files and assert the declared contract, so a stale Node/pnpm/action major
// fails the harness instead of only failing in CI.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8");

const NODE_FLOOR = ">=24.20.0 <25";
const NODE_PIN = "24.20.0";
const PNPM_PIN = "12.21.0";

/** Actions whose major the toolchain policy fixes, with the supported major. */
const ACTION_MAJORS = new Map([
  ["actions/checkout", 7],
  ["actions/setup-node", 7],
  ["actions/upload-artifact", 7],
  ["pnpm/action-setup", 6],
  ["docker/setup-buildx-action", 4],
  ["docker/build-push-action", 7],
  ["actions/cache", 6],
  ["googleapis/release-please-action", 5],
  ["softprops/action-gh-release", 3],
  ["Swatinem/rust-cache", 2],
]);

/** Actions pinned by branch/tag instead of a major, with the expected ref. */
const ACTION_BRANCH_REFS = new Map([["dtolnay/rust-toolchain", "stable"]]);

/** Every workflow and composite action file the policy covers. */
function githubYamlFiles() {
  const workflowsDir = path.join(ROOT, ".github", "workflows");
  const workflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);

  const actionsDir = path.join(ROOT, ".github", "actions");
  const actions = readdirSync(actionsDir)
    .map((name) => `.github/actions/${name}/action.yml`)
    .filter((file) => existsSync(path.join(ROOT, file)));

  return [...workflows, ...actions];
}

/**
 * Split a workflow/action into step-sized chunks so a `node-version` or
 * `version` input is matched inside the step that declares it.
 */
function stepChunks(text) {
  const chunks = [];
  let current = [];

  for (const line of text.split("\n")) {
    if (/^\s*- (?:name|uses):/.test(line)) {
      if (current.length > 0) chunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks;
}

test("package.json declares the Node 24 LTS range and the pinned pnpm", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.equal(pkg.engines?.node, NODE_FLOOR, `engines.node must be exactly "${NODE_FLOOR}"`);
  assert.ok(
    typeof pkg.engines?.pnpm === "string" &&
      /(?:^|\s)>=\s*12\.21\.0(?:\s|$)/.test(pkg.engines.pnpm),
    `engines.pnpm must require >=${PNPM_PIN}, got ${JSON.stringify(pkg.engines?.pnpm)}`,
  );
  assert.equal(
    pkg.packageManager,
    `pnpm@${PNPM_PIN}`,
    `packageManager must be exactly "pnpm@${PNPM_PIN}"`,
  );
});

test(".nvmrc pins the supported Node patch", () => {
  assert.ok(existsSync(path.join(ROOT, ".nvmrc")), "missing .nvmrc");

  assert.equal(read(".nvmrc").trim(), NODE_PIN, `.nvmrc must pin ${NODE_PIN}`);
});

test("scripts/Dockerfile stays on Debian 12 and installs Node 24 with Corepack", () => {
  const dockerfile = read("scripts/Dockerfile");

  assert.match(
    dockerfile,
    /^FROM\s+debian:12-slim\s*$/m,
    "the builder must keep the debian:12-slim (glibc 2.36) floor",
  );
  assert.ok(
    dockerfile.includes("setup_24.x"),
    "must install Node from the NodeSource setup_24.x repository",
  );
  assert.ok(
    dockerfile.indexOf("setup_24.x") > dockerfile.indexOf("build-libs.sh"),
    "the native-libs layer (build-libs.sh) must come before the Node layer",
  );
  assert.ok(
    !dockerfile.includes("setup_20.x"),
    "must not install Node from the end-of-life setup_20.x repository",
  );
  assert.ok(dockerfile.includes("corepack enable"), "must run `corepack enable`");
  assert.ok(
    dockerfile.includes(`corepack prepare pnpm@${PNPM_PIN} --activate`),
    `must run \`corepack prepare pnpm@${PNPM_PIN} --activate\``,
  );
  assert.ok(
    !/\bnpm\b/.test(dockerfile),
    "the builder image must never invoke npm; pnpm comes from Corepack",
  );
});

test("workflows and composite actions use the supported action versions", () => {
  const files = githubYamlFiles();
  assert.ok(files.length > 0, "expected workflow or composite action files");

  const problems = [];
  for (const file of files) {
    const text = read(file);
    const usesPattern = /uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g;

    for (const [, action, ref] of text.matchAll(usesPattern)) {
      const branchRef = ACTION_BRANCH_REFS.get(action);
      if (branchRef !== undefined) {
        if (ref !== branchRef) {
          problems.push(`${file}: ${action}@${ref} must be ${action}@${branchRef}`);
        }
        continue;
      }

      const expected = ACTION_MAJORS.get(action);
      if (expected === undefined) continue;

      const major = /^v(\d+)(?:[.\s]|$)/.exec(ref)?.[1];
      if (major === undefined) {
        problems.push(`${file}: ${action}@${ref} must pin a vN major (v${expected})`);
      } else if (Number(major) !== expected) {
        problems.push(`${file}: ${action}@${ref} must be ${action}@v${expected}`);
      }
    }
  }

  assert.deepEqual(problems, [], "stale GitHub Action majors:\n" + problems.join("\n"));
});

test("the Windows build loads the MSVC environment without a Node 20 action", () => {
  const action = read(".github/actions/windows-build/action.yml");

  assert.doesNotMatch(
    action,
    /uses:\s*ilammy\/msvc-dev-cmd/,
    "the Windows build must not use the Node 20 ilammy/msvc-dev-cmd action",
  );
  assert.match(
    action,
    /vcvars64\.bat/,
    "the Windows build must load vcvars64.bat for the MSVC x64 environment",
  );
  assert.match(
    action,
    /GITHUB_ENV/,
    "the Windows build must export the MSVC environment to later steps",
  );
  assert.match(action, /where\.exe dumpbin\.exe/, "the setup must verify dumpbin.exe");
  assert.match(action, /where\.exe lib\.exe/, "the setup must verify lib.exe");
});

test("every CI Node and pnpm setup uses Node 24 and pnpm 12.21.0", () => {
  const files = githubYamlFiles();
  const problems = [];
  let setupNodeSteps = 0;
  let pnpmSetupSteps = 0;

  for (const file of files) {
    for (const chunk of stepChunks(read(file))) {
      if (chunk.includes("actions/setup-node@")) {
        setupNodeSteps += 1;
        const version = /^\s*node-version:\s*(.+?)\s*$/m.exec(chunk)?.[1];
        if (!/^(?:["']?24(?:\.x)?["']?)$/.test(version ?? "")) {
          problems.push(`${file}: node-version is ${JSON.stringify(version)}, expected 24`);
        }
      }

      if (chunk.includes("pnpm/action-setup@")) {
        pnpmSetupSteps += 1;
        const version = /^\s*version:\s*(.+?)\s*$/m.exec(chunk)?.[1];
        if (!/^["']?12\.21\.0["']?$/.test(version ?? "")) {
          problems.push(
            `${file}: pnpm version is ${JSON.stringify(version)}, expected ${PNPM_PIN}`,
          );
        }
      }
    }
  }

  assert.ok(setupNodeSteps > 0, "expected at least one actions/setup-node step");
  assert.ok(pnpmSetupSteps > 0, "expected at least one pnpm/action-setup step");
  assert.deepEqual(problems, [], "CI toolchain drift:\n" + problems.join("\n"));
});

test("the policy test script runs every scripts/lib test file", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.ok(
    pkg.scripts?.["test:policy"]?.includes("scripts/lib/*.test.mjs"),
    'scripts["test:policy"] must run node --test scripts/lib/*.test.mjs',
  );
});
