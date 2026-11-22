// Contract tests for the Rust advisory audit and lockfile security floors
// (docs/TOOLCHAIN.md §3.1 and §3.1.2).
//
// Cargo.lock and the quality workflow are configuration the release depends on,
// so the tests read those files and assert the contract. Nothing here runs
// cargo: a reverted lockfile version or a missing CI audit step fails the
// harness, and the advisory gate itself stays `cargo audit`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8");

/** Compare two dotted versions numerically; a prerelease sorts below its release. */
function compareVersions(left, right) {
  const parse = (version) => {
    const [core, prerelease] = version.split("-", 2);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prerelease ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return Math.sign(a.prerelease.localeCompare(b.prerelease));
}

/**
 * Every version Cargo.lock resolves for `name`. Cargo.lock entries are
 * `[[package]]\nname = "x"\nversion = "y"`; a package may appear several times.
 */
function lockVersions(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = "([^"]+)"`,
    "g",
  );

  return [...read("Cargo.lock").matchAll(pattern)].map((match) => match[1]);
}

test("the local workspace packages keep their release version", () => {
  for (const name of ["chemistry-draw", "indigo-server"]) {
    const versions = lockVersions(name);
    assert.ok(versions.length > 0, `Cargo.lock must resolve ${name}`);
    assert.deepEqual(versions, ["0.1.8"], `Cargo.lock resolves ${name} at ${versions}`);
  }
});

test("every resolved Rust dependency meets its security floor", () => {
  const floors = new Map([
    ["anyhow", "1.0.104"],
    ["tokio", "1.54.1"],
    ["rustix", "1.1.6"],
    ["event-listener", "5.4.2"],
    ["async-executor", "1.14.1"],
    ["plist", "1.10.4"],
    ["quick-xml", "0.42.0"],
    ["url", "2.5.9"],
  ]);

  for (const [name, floor] of floors) {
    const versions = lockVersions(name);
    assert.ok(versions.length > 0, `Cargo.lock must resolve ${name}`);

    for (const version of versions) {
      assert.ok(
        compareVersions(version, floor) >= 0,
        `Cargo.lock resolves ${name} ${version}, expected >= ${floor}`,
      );
    }
  }
});

test("the quality workflow runs the Rust advisory audit", () => {
  const workflow = read(".github/workflows/quality.yml");

  assert.match(
    workflow,
    /taiki-e\/install-action@v\d+/,
    "quality.yml must install cargo-audit through taiki-e/install-action",
  );
  assert.match(workflow, /tool:\s*cargo-audit\b/, "the install action must request cargo-audit");
  assert.match(workflow, /\bcargo audit\b/, "quality.yml must run `cargo audit`");
});

test("the toolchain docs document the Rust advisory gate", () => {
  const docs = read("docs/TOOLCHAIN.md");

  assert.match(docs, /\bcargo audit\b/, "docs/TOOLCHAIN.md must document the cargo audit gate");
  assert.match(
    docs,
    /taiki-e\/install-action/,
    "docs/TOOLCHAIN.md must name taiki-e/install-action as the CI installer",
  );
});
