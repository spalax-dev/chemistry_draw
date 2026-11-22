import { describe, expect, it } from "vitest";

import { buildRecentRow, type RecentRowInput } from "./recentStructures";

/**
 * Recent structures rows (`docs/planning/contracts.md` §5,
 * `docs/architecture.md` §5.1). A row keeps its place even when the file is
 * unreadable, and a failure degrades to placeholders instead of a pass.
 */

const OLD_MTIME = new Date(2020, 0, 2, 12, 0).getTime();

function input(overrides: Partial<RecentRowInput> = {}): RecentRowInput {
  return {
    path: "/docs/benzene.ket",
    stat: { size: 1024, mtime: OLD_MTIME },
    text: "{}",
    checkResult: {},
    preview: "data:image/svg+xml;base64,abc",
    ...overrides,
  };
}

describe("buildRecentRow", () => {
  it("builds a normal .ket row from stat, check result and preview", () => {
    expect(buildRecentRow(input())).toEqual({
      path: "/docs/benzene.ket",
      name: "benzene",
      format: "KET",
      sizeLabel: "1 KB",
      modifiedLabel: "Jan 2, 2020",
      status: "valid",
      preview: "data:image/svg+xml;base64,abc",
    });
  });

  it("degrades to — labels, unknown status and no preview when stat is missing", () => {
    expect(buildRecentRow(input({ stat: null }))).toMatchObject({
      name: "benzene",
      format: "KET",
      sizeLabel: "—",
      modifiedLabel: "—",
      status: "unknown",
      preview: null,
    });
  });

  it("degrades when the text is unreadable", () => {
    expect(buildRecentRow(input({ text: null }))).toMatchObject({
      sizeLabel: "—",
      modifiedLabel: "—",
      status: "unknown",
      preview: null,
    });
  });

  it("maps a null check result to unknown while keeping the other facts", () => {
    expect(buildRecentRow(input({ checkResult: null }))).toMatchObject({
      sizeLabel: "1 KB",
      modifiedLabel: "Jan 2, 2020",
      status: "unknown",
      preview: "data:image/svg+xml;base64,abc",
    });
  });

  it("maps a non-empty check result without an error to warnings", () => {
    expect(buildRecentRow(input({ checkResult: { valence: ["bond"] } }))).toMatchObject({
      status: "warnings",
    });
  });

  it("maps a check result carrying an error to invalid", () => {
    expect(buildRecentRow(input({ checkResult: { error: "boom" } }))).toMatchObject({
      status: "invalid",
    });
  });

  it("derives name and format from a Windows path", () => {
    expect(buildRecentRow(input({ path: "C:\\Users\\me\\My Molecule.v2.ket" }))).toMatchObject({
      name: "My Molecule.v2",
      format: "KET",
    });
  });

  it("keeps a path without an extension as the name with an empty format", () => {
    expect(buildRecentRow(input({ path: "C:\\Users\\me\\README" }))).toMatchObject({
      name: "README",
      format: "",
    });
  });

  it("keeps the imported source format for a non-.ket file", () => {
    expect(buildRecentRow(input({ path: "/docs/benzene.mol" }))).toMatchObject({
      name: "benzene",
      format: "MOL",
    });
  });
});
