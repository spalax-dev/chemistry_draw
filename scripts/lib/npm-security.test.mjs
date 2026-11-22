// Contract tests for the npm security remediation (docs/TOOLCHAIN.md §3).
//
// The fixes live in `pnpm-workspace.yaml` (pnpm 12 reads its security overrides
// there), package.json (devDependency floors, audit scripts), the quality
// workflow and pnpm-lock.yaml. Nothing here installs anything: the tests read
// those files and assert the declared contract, so a reverted override or a
// stale resolved version fails the harness. The lock test asserts every
// overridden package resolves at or above its floor, plus vitest/vite/tinypool.
//
// The documented allowlist is intentionally NOT asserted as fixed: `elliptic`
// (low, dev) and `glob`/`minimatch` (moderate, build-only, not shipped) stay
// allowlisted in docs/TOOLCHAIN.md §3.2 until their expiry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml, parseAllDocuments } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");

const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8");
const pkg = () => JSON.parse(read("package.json"));

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

/** First version mentioned by a specifier, or null when it has none. */
function firstVersion(specifier) {
  return /(\d+)\.(\d+)\.(\d+)/.exec(String(specifier))?.[0] ?? null;
}

/** Assert a dependency specifier's floor is at least `floor`. */
function assertFloor(specifier, floor, label) {
  const version = firstVersion(specifier);
  assert.ok(version !== null, `${label} must declare a version, got ${JSON.stringify(specifier)}`);
  assert.ok(
    compareVersions(version, floor) >= 0,
    `${label} must be >= ${floor}, got ${JSON.stringify(specifier)}`,
  );
}

/**
 * Collect every version a package resolves to across all lockfile documents.
 * pnpm writes two YAML documents (the package-manager env plus the project
 * lockfile), so each `packages` map is read separately.
 */
function lockVersions(names) {
  const resolved = new Map(names.map((name) => [name, new Set()]));
  const keyPattern = /^(@[^@/]+\/[^@]+|[^@]+)@(.+)$/;

  for (const document of parseAllDocuments(read("pnpm-lock.yaml"))) {
    const packages = document.toJS()?.packages ?? {};
    for (const key of Object.keys(packages)) {
      const [, name, rawVersion] = keyPattern.exec(key) ?? [];
      if (!resolved.has(name)) continue;

      // Peer-dependency suffixes (`vitest@4.1.12(@types/node@24.0.0)`) are not
      // part of the resolved version.
      resolved.get(name).add(rawVersion.split("(")[0]);
    }
  }

  return resolved;
}

test("pnpm overrides pin the compromised transitive ranges", () => {
  const workspace = parseYaml(read("pnpm-workspace.yaml"));
  const overrides = workspace.overrides ?? {};

  assert.deepEqual(
    {
      "fast-uri": overrides["fast-uri"],
      postcss: overrides.postcss,
      nanoid: overrides.nanoid,
      "source-map-js": overrides["source-map-js"],
      browserslist: overrides.browserslist,
      qs: overrides.qs,
      pbkdf2: overrides.pbkdf2,
    },
    {
      "fast-uri": "^3.1.9",
      postcss: "^8.5.23",
      nanoid: "^3.3.18",
      "source-map-js": "^1.2.2",
      browserslist: "^4.28.7",
      qs: "^6.16.1",
      pbkdf2: "^3.1.7",
    },
  );
});

test("devDependencies meet the security floors", () => {
  const devDependencies = pkg().devDependencies ?? {};

  assertFloor(devDependencies.vitest, "4.1.12", "devDependencies.vitest");
  assertFloor(devDependencies.vite, "6.4.6", "devDependencies.vite");
  assert.equal(
    firstVersion(devDependencies["@types/node"])?.split(".")[0],
    "24",
    `devDependencies["@types/node"] must target major 24, got ${JSON.stringify(devDependencies["@types/node"])}`,
  );
  assert.ok(
    String(devDependencies.typescript).startsWith("~5.9"),
    `devDependencies.typescript must be ~5.9.x, got ${JSON.stringify(devDependencies.typescript)}`,
  );
});

test("react and react-dom stay on the validated 18.3.1 release", () => {
  const dependencies = pkg().dependencies ?? {};

  assert.equal(dependencies.react, "18.3.1", "dependencies.react must be exactly 18.3.1");
  assert.equal(
    dependencies["react-dom"],
    "18.3.1",
    "dependencies.react-dom must be exactly 18.3.1",
  );
});

test("package scripts expose the high-severity audit gates", () => {
  const scripts = pkg().scripts ?? {};

  assert.ok(
    String(scripts.audit).includes("--audit-level=high"),
    `scripts.audit must run pnpm audit --audit-level=high, got ${JSON.stringify(scripts.audit)}`,
  );
  assert.ok(
    String(scripts["audit:prod"]).includes("--prod"),
    `scripts["audit:prod"] must use --prod, got ${JSON.stringify(scripts["audit:prod"])}`,
  );
  assert.ok(
    String(scripts["audit:prod"]).includes("--audit-level=high"),
    `scripts["audit:prod"] must use --audit-level=high, got ${JSON.stringify(scripts["audit:prod"])}`,
  );
});

test("the quality workflow audits after installing dependencies", () => {
  const workflow = read(".github/workflows/quality.yml");

  const installIndex = workflow.search(/pnpm install --frozen-lockfile/);
  assert.ok(installIndex >= 0, "quality.yml must install dependencies with pnpm");

  const commands = new Map([
    ["pnpm run audit", /pnpm\s+run\s+audit\s*$/m],
    ["pnpm run audit:prod", /pnpm\s+run\s+audit:prod\s*$/m],
  ]);

  for (const [label, pattern] of commands) {
    const match = pattern.exec(workflow);
    assert.ok(match, `quality.yml must run \`${label}\``);
    assert.ok(
      match.index > installIndex,
      `\`${label}\` must run after \`pnpm install --frozen-lockfile\``,
    );
  }
});

test("the lockfile resolves the fixed versions", () => {
  const floors = new Map([
    ["fast-uri", "3.1.9"],
    ["postcss", "8.5.23"],
    ["nanoid", "3.3.18"],
    ["source-map-js", "1.2.2"],
    ["browserslist", "4.28.7"],
    ["qs", "6.16.1"],
    ["pbkdf2", "3.1.7"],
    ["vitest", "4.1.12"],
    ["vite", "6.4.6"],
    ["@types/node", "24.19.2"],
    ["tinypool", "2.1.2"],
  ]);
  const resolved = lockVersions([...floors.keys()]);

  // Vitest 4 removed tinypool from its graph, so the lockfile only has to
  // honour that floor if tinypool is actually resolved.
  const optional = new Set(["tinypool"]);

  for (const [name, floor] of floors) {
    const versions = [...resolved.get(name)];
    if (versions.length === 0) {
      assert.ok(optional.has(name), `pnpm-lock.yaml must resolve ${name}`);
      continue;
    }

    for (const version of versions) {
      assert.ok(
        compareVersions(version, floor) >= 0,
        `pnpm-lock.yaml resolves ${name}@${version}, expected >= ${floor}`,
      );
    }
  }
});
