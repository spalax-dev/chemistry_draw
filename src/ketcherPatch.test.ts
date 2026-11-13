import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Ketcher 3.18 crashes in `ReBond.getSelectionPoints` when a bond points at a
 * half-bond that no longer exists in the struct: the lookup returns `undefined`
 * and `.p` throws. Upstream fixed it in epam/ketcher#11165, and we vendor that
 * guard through `patches/ketcher-core@3.18.0.patch` (both dist builds, because
 * the bundler picks `rebond.modern.js` while the legacy build uses
 * `rebond.js`).
 *
 * This test pins the contract so the patch cannot silently regress: every
 * rebond hunk carries the sentinel, the installed package reflects it, and the
 * older `parametrizeUrl` fix stays in the same cumulative patch.
 */
const SENTINEL = "chemistry-draw: guard missing half-bonds (epam/ketcher#11165)";
const REBOND_FILES = ["rebond.js", "rebond.modern.js"];
const REMOTE_STRUCT_FILES = ["remoteStructService.js", "remoteStructService.modern.js"];

const PATCH_URL = new URL("../patches/ketcher-core@3.18.0.patch", import.meta.url);

const require = createRequire(import.meta.url);
const KETCHER_CORE_DIR = dirname(require.resolve("ketcher-core/package.json"));

function readPatch(): string {
  return readFileSync(PATCH_URL, "utf8");
}

/** Returns the `diff --git` section that patches `file`, or "" when absent. */
function patchSection(patch: string, file: string): string {
  return (
    patch
      .split(/^diff --git /m)
      .find((section) => section.startsWith(`a/dist/application/render/restruct/${file} b/`)) ?? ""
  );
}

function installedRebond(file: string): string {
  return readFileSync(join(KETCHER_CORE_DIR, "dist/application/render/restruct", file), "utf8");
}

/** Source of `getSelectionPoints`, from its key up to the next method key. */
function getSelectionPointsBody(source: string): string {
  const start = source.indexOf("getSelectionPoints");
  if (start === -1) return "";
  const nextKey = source.indexOf("key:", start + "getSelectionPoints".length);
  return source.slice(start, nextKey === -1 ? undefined : nextKey);
}

describe("ketcher-core patch: rebond half-bond guard", () => {
  it("marks both rebond dist hunks with the guard sentinel", () => {
    const patch = readPatch();

    expect(patch.split(SENTINEL).length - 1).toBeGreaterThanOrEqual(REBOND_FILES.length);

    for (const file of REBOND_FILES) {
      expect(patchSection(patch, file)).toContain(SENTINEL);
    }
  });

  it("installs a guarded getSelectionPoints in both dist builds", () => {
    for (const file of REBOND_FILES) {
      const body = getSelectionPointsBody(installedRebond(file));

      // Guarded lookups return early instead of dereferencing a missing half-bond.
      expect(body).toContain(SENTINEL);
      expect(body).toContain("return [];");
      expect(body).not.toMatch(/halfBonds\.get\(bond(?:\$1)?\.hb[12]\)\.p/);
    }
  });

  it("keeps the existing parametrizeUrl hunk in the cumulative patch", () => {
    const patch = readPatch();

    expect(patch.match(/function parametrizeUrl/g)).toHaveLength(REMOTE_STRUCT_FILES.length);

    for (const file of REMOTE_STRUCT_FILES) {
      const section = patch.split(/^diff --git /m).find((part) => part.includes(`/${file} b/`));

      expect(section).toContain("hasOwnProperty.call(params, key)");
    }
  });
});
