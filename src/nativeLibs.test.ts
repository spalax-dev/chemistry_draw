import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Platform font/PNG libraries must come from the host, never from the bundle:
 * shipping Debian's fontconfig 2.14 next to Fedora's fontconfig 2.18 config
 * makes every render log ~45 `Fontconfig warning` lines (each PNG render pays
 * for a cache/config mismatch it cannot resolve). These five families are the
 * ones Imago/Indigo drag in transitively, so the three places that decide what
 * gets copied into `src-tauri/lib/linux-x86_64` must each skip them.
 */
const HOST_LIB_FAMILIES = ["libfontconfig", "libfreetype", "libexpat", "libpng", "libbrotli"];

const LIBS_DIR_URL = new URL("../src-tauri/lib/linux-x86_64", import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/** Text between `case "$name" in` and its matching `esac`. */
function buildLibsSkipBlock(source: string): string {
  const opening = 'case "$name" in';
  const start = source.indexOf(opening);
  expect(start, `missing \`${opening}\` in scripts/build-libs.sh`).toBeGreaterThanOrEqual(0);

  const end = source.indexOf("esac", start + opening.length);
  expect(end, "unterminated `case` in scripts/build-libs.sh").toBeGreaterThan(start);

  return source.slice(start + opening.length, end);
}

/** Entries of the `SKIP_PATTERNS=( ... )` array. */
function bundleLibsSkipPatterns(source: string): string {
  const opening = "SKIP_PATTERNS=(";
  const start = source.indexOf(opening);
  expect(start, `missing \`${opening}\` in scripts/bundle-libs.sh`).toBeGreaterThanOrEqual(0);

  const end = source.indexOf("\n)", start + opening.length);
  expect(end, "unterminated SKIP_PATTERNS array in scripts/bundle-libs.sh").toBeGreaterThan(start);

  return source.slice(start + opening.length, end);
}

/** The `libs` task commands, joined, from Taskfile.yml. */
function libsTaskCommands(source: string): string {
  const taskfile = parse(source) as {
    tasks?: Record<string, { cmds?: Array<string | { cmd?: string }> }>;
  };

  const commands = taskfile.tasks?.libs?.cmds;
  expect(commands, "missing `libs:` task in Taskfile.yml").toBeTruthy();

  return (commands ?? [])
    .map((entry) => (typeof entry === "string" ? entry : (entry.cmd ?? "")))
    .join("\n");
}

describe("native library skip lists", () => {
  it("skips every host font/PNG family when collecting dependencies in build-libs.sh", () => {
    const block = buildLibsSkipBlock(readRepoFile("scripts/build-libs.sh"));

    for (const family of HOST_LIB_FAMILIES) {
      expect(block, `build-libs.sh does not skip ${family}`).toMatch(new RegExp(`\\b${family}`));
    }
  });

  it("has a SKIP_PATTERNS entry for every host font/PNG family in bundle-libs.sh", () => {
    const patterns = bundleLibsSkipPatterns(readRepoFile("scripts/bundle-libs.sh"));

    for (const family of HOST_LIB_FAMILIES) {
      expect(patterns, `bundle-libs.sh SKIP_PATTERNS lacks ${family}`).toMatch(
        new RegExp(`^\\s*\\^${family}`, "m"),
      );
    }
  });

  it("removes or excludes every host font/PNG family when copying libs in the Taskfile libs task", () => {
    const commands = libsTaskCommands(readRepoFile("Taskfile.yml"));

    expect(commands, "the libs task copies the builder libraries without filtering").toMatch(
      /rm\s+-f|rsync\s+.*--exclude/,
    );

    for (const family of HOST_LIB_FAMILIES) {
      expect(commands, `the libs task does not remove/exclude ${family}`).toContain(family);
    }
  });

  it.skipIf(!existsSync(LIBS_DIR_URL))(
    "does not bundle any host font/PNG family in src-tauri/lib/linux-x86_64",
    () => {
      const entries = readdirSync(LIBS_DIR_URL);

      for (const family of HOST_LIB_FAMILIES) {
        expect(
          entries.filter((entry) => entry.startsWith(`${family}.`) || entry.startsWith(family)),
          `bundled ${family} in src-tauri/lib/linux-x86_64`,
        ).toEqual([]);
      }
    },
  );
});
