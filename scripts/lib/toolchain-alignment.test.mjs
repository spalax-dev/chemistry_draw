// Contract tests for the single toolchain source of truth (ADR 0012).
//
// `.nvmrc` pins Node and `packageManager` in package.json pins pnpm; every
// workflow, composite action and the builder image must consume those
// declarations instead of re-pinning a version. The tests parse the real YAML
// and files, never run a workflow or build an image.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_VERSION = "24.20.0";
const PNPM_VERSION = "12.21.0";

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function githubFiles(directory = ".github") {
  const entries = readdirSync(path.join(ROOT, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...githubFiles(relative));
    } else if (/\.ya?ml$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

// Depth-first walk over a parsed YAML tree so nested composite steps count.
function* walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}

const packageJson = JSON.parse(read("package.json"));

test(".nvmrc and packageManager are the single toolchain declarations", () => {
  assert.equal(read(".nvmrc").trim(), NODE_VERSION, ".nvmrc must pin Node 24.20.0");
  assert.equal(
    packageJson.packageManager,
    `pnpm@${PNPM_VERSION}`,
    "packageManager must pin pnpm 12.21.0",
  );
  assert.match(
    packageJson.engines?.node ?? "",
    /24\.20\.0/,
    "engines.node must cover the .nvmrc version",
  );
});

test("every .github file takes Node from .nvmrc, never a numeric version", () => {
  for (const file of githubFiles()) {
    const content = read(file);
    assert.doesNotMatch(
      content,
      /^\s*node-version\s*:\s*["']?\d/m,
      `${file} must not pin a numeric node-version; use node-version-file: .nvmrc`,
    );
  }
});

test("every Node setup in .github uses node-version-file: .nvmrc", () => {
  for (const file of githubFiles()) {
    const doc = parse(read(file));
    for (const node of walk(doc)) {
      if (typeof node.uses !== "string" || !node.uses.startsWith("actions/setup-node")) {
        continue;
      }
      assert.equal(
        node.with?.["node-version-file"],
        ".nvmrc",
        `${file} must set node-version-file: .nvmrc on ${node.uses}`,
      );
    }
  }
});

test("no pnpm/action-setup step pins a pnpm version other than 12.21.0", () => {
  for (const file of githubFiles()) {
    const doc = parse(read(file));
    for (const node of walk(doc)) {
      if (typeof node.uses !== "string" || !node.uses.startsWith("pnpm/action-setup")) {
        continue;
      }
      const version = node.with?.version;
      assert.ok(
        version === undefined || version === PNPM_VERSION,
        `${file} must omit the pnpm version (packageManager drives) or pin ${PNPM_VERSION}, got ${version}`,
      );
    }
  }
});

test("ci.yml triggers on main and develop for push and pull_request", () => {
  const ci = parse(read(".github/workflows/ci.yml"));
  for (const event of ["push", "pull_request"]) {
    const branches = ci.on?.[event]?.branches ?? [];
    assert.ok(branches.includes("main"), `ci.yml must trigger on ${event} for main`);
    assert.ok(branches.includes("develop"), `ci.yml must trigger on ${event} for develop`);
  }
});

test("scripts/Dockerfile installs Node 24 and exact pnpm 12.21.0", () => {
  const dockerfile = read("scripts/Dockerfile");
  assert.match(dockerfile, /setup_24\.x/, "the builder must install Node 24");
  assert.match(
    dockerfile,
    new RegExp(`pnpm@${PNPM_VERSION.replaceAll(".", "\\.")}`),
    "the builder must pin pnpm 12.21.0 exactly",
  );
  assert.doesNotMatch(
    dockerfile,
    /npm install -g pnpm(?!@12\.21\.0)/,
    "no unpinned `npm install -g pnpm`; the version must be explicit",
  );
});

test("the capability grants only the file-picker dialogs", () => {
  const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
  const permissions = capabilities.permissions ?? [];
  assert.ok(permissions.includes("dialog:allow-open"), "dialog:allow-open is required");
  assert.ok(permissions.includes("dialog:allow-save"), "dialog:allow-save is required");
  assert.ok(
    !permissions.includes("dialog:default"),
    "dialog:default bundles allow-message and must not be granted",
  );
  assert.ok(
    !permissions.includes("dialog:allow-message"),
    "native message dialogs are not part of the UI contract",
  );
});
