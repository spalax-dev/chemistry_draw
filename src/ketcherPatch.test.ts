import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Ketcher 3.21.0 still has the `parametrizeUrl` bug that treats the port in
 * `http://127.0.0.1:9321/v2/...` as a placeholder and substitutes `undefined`.
 * Upstream fixed it on `master` (`split(/(:[A-Za-z_]\w*)/)` plus a
 * `hasOwnProperty` lookup), but not in the 3.21.0 release, so
 * `patches/ketcher-core@3.21.0.patch` carries only those two `parametrizeUrl`
 * hunks (`remoteStructService.js` and `remoteStructService.modern.js`).
 *
 * The ReBond half-bond guard is no longer patched: 3.21.0 ships the upstream
 * fix (epam/ketcher#11165), so a ReBond hunk in the patch is a regression.
 *
 * This test pins the contract: the patch stays narrowed to one bug, the
 * installed dist keeps the fixed regex and guard, and executing the installed
 * function preserves the explicit port. Mutation checks: deleting either hunk,
 * restoring `:(\w+)`, or re-adding a ReBond hunk must fail.
 */
const REMOTE_STRUCT_FILES = ["remoteStructService.js", "remoteStructService.modern.js"] as const;
const REMOTE_STRUCT_DIR = "dist/infrastructure/services/struct";

const PATCH_URL = new URL("../patches/ketcher-core@3.21.0.patch", import.meta.url);

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
      .find((section) => section.startsWith(`a/${REMOTE_STRUCT_DIR}/${file} b/`)) ?? ""
  );
}

function installedRemoteStruct(file: string): string {
  return readFileSync(join(KETCHER_CORE_DIR, REMOTE_STRUCT_DIR, file), "utf8");
}

/** Source of `function parametrizeUrl` up to its matching closing brace. */
function parametrizeUrlSource(source: string): string {
  const start = source.indexOf("function parametrizeUrl(");
  if (start === -1) return "";

  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

/**
 * Executes the installed `parametrizeUrl`. The bundler does not export it, but
 * the function is self-contained, so evaluating its exact installed source is
 * the real thing — not a copy of the expected implementation.
 */
function runInstalledParametrizeUrl(
  file: string,
  url: string,
  params: Record<string, string>,
): string {
  const source = parametrizeUrlSource(installedRemoteStruct(file));
  expect(source, `${file} must contain parametrizeUrl`).not.toBe("");

  const fn = new Function(`return (${source})`)() as (
    value: string,
    values: Record<string, string>,
  ) => string;
  return fn(url, params);
}

describe("ketcher-core patch: narrow parametrizeUrl contract", () => {
  it("contains only the two parametrizeUrl hunks and no ReBond hunk", () => {
    const patch = readPatch();
    const sections = patch.split(/^diff --git /m).filter(Boolean);

    expect(sections).toHaveLength(REMOTE_STRUCT_FILES.length);
    expect(patch).not.toMatch(/rebond/i);
    expect(patch).not.toMatch(/halfBonds/);

    for (const file of REMOTE_STRUCT_FILES) {
      const section = patchSection(patch, file);

      expect(section, `missing patch hunk for ${file}`).not.toBe("");
      expect(section).toContain("function parametrizeUrl");
      // The removed buggy placeholder matcher and the added narrowed one.
      expect(section).toContain(":(\\w+)");
      expect(section).toContain(":([A-Za-z_]\\w*)");
      expect(section).toContain("hasOwnProperty.call(params, key)");
      // One hunk per file: the fix and nothing else.
      expect(section.match(/^@@/gm) ?? []).toHaveLength(1);
    }
  });

  it("installs the narrowed regex and own-property guard in both dist builds", () => {
    for (const file of REMOTE_STRUCT_FILES) {
      const body = parametrizeUrlSource(installedRemoteStruct(file));

      expect(body, `${file} must contain parametrizeUrl`).not.toBe("");
      expect(body).toContain(":([A-Za-z_]\\w*)");
      expect(body).toContain("hasOwnProperty.call(params, key)");
      // The 3.18/3.21 bug matched the digits after the colon and replaced them.
      expect(body).not.toContain(":(\\w+)");
    }
  });

  it("keeps the explicit port and substitutes only declared placeholders", () => {
    const url = "http://127.0.0.1:9321/v2/imago/uploads/:id";

    for (const file of REMOTE_STRUCT_FILES) {
      // The port is not a declared placeholder: it must survive untouched.
      expect(runInstalledParametrizeUrl(file, url, { id: "abc" })).toBe(
        "http://127.0.0.1:9321/v2/imago/uploads/abc",
      );

      // An undeclared `:id` stays literal instead of becoming `undefined`.
      expect(runInstalledParametrizeUrl(file, url, {})).toBe(url);
    }
  });
});
