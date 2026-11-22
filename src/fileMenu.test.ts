import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FILE_MENU_ITEMS, RECENT_SECTION_LABEL, type FileMenuId } from "./fileMenu";

/**
 * The File menu model and popup wiring (`docs/architecture.md` §5.1,
 * `docs/planning/contracts.md` §5): a fixed ordered list of document commands,
 * separate Open and Import entries, and the recent-documents section.
 */

describe("FILE_MENU_ITEMS", () => {
  it("lists the commands in the documented order", () => {
    expect(FILE_MENU_ITEMS.map((item) => item.id)).toEqual([
      "new",
      "open",
      "import",
      "save",
      "save-as",
      "export",
    ]);
  });

  it("uses the documented sentence-case labels", () => {
    expect(FILE_MENU_ITEMS.map((item) => item.label)).toEqual([
      "New",
      "Open…",
      "Import…",
      "Save",
      "Save As…",
      "Export…",
    ]);
  });

  it("keeps Open and Import as distinct entries", () => {
    const ids: FileMenuId[] = FILE_MENU_ITEMS.map((item) => item.id);

    expect(ids.filter((id) => id === "open")).toHaveLength(1);
    expect(ids.filter((id) => id === "import")).toHaveLength(1);
  });

  it("contains no duplicate ids", () => {
    const ids = FILE_MENU_ITEMS.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts the ellipsis only on the commands that open another dialog", () => {
    const withEllipsis = FILE_MENU_ITEMS.filter((item) => item.label.endsWith("…")).map(
      (item) => item.id,
    );

    expect(withEllipsis).toEqual(["open", "import", "save-as", "export"]);
  });

  it("carries a non-empty label for every item", () => {
    expect(FILE_MENU_ITEMS.every((item) => item.label.trim().length > 0)).toBe(true);
  });
});

describe("RECENT_SECTION_LABEL", () => {
  it("matches the documented section label", () => {
    expect(RECENT_SECTION_LABEL).toBe("Recent documents");
  });
});

/**
 * The popup is presentational: it renders the model and reports the chosen id
 * or path (`docs/planning/contracts.md` §5). There is no DOM renderer, so the
 * wiring is read from the source.
 */
const FILE_MENU_SOURCE = readFileSync(new URL("./ui/FileMenu.tsx", import.meta.url), "utf8");

describe("FileMenu wiring", () => {
  it("renders the fixed item list instead of a local command array", () => {
    expect(FILE_MENU_SOURCE).toMatch(
      /import\s*\{[^}]*\bFILE_MENU_ITEMS\b[^}]*\}\s*from\s*["']\.\.\/fileMenu["']/,
    );
    expect(FILE_MENU_SOURCE).toMatch(/FILE_MENU_ITEMS\.map\(/);
  });

  it("renders the recent section from the injected paths", () => {
    expect(FILE_MENU_SOURCE).toMatch(
      /import\s*\{[^}]*\bRECENT_SECTION_LABEL\b[^}]*\}\s*from\s*["']\.\.\/fileMenu["']/,
    );
    expect(FILE_MENU_SOURCE).toContain("RECENT_SECTION_LABEL");
    expect(FILE_MENU_SOURCE).toMatch(/recentName\(/);
    expect(FILE_MENU_SOURCE).toMatch(/onOpenRecent\(/);
  });

  it("reports a command through onAction instead of running it", () => {
    expect(FILE_MENU_SOURCE).toMatch(/onAction\(/);
    expect(FILE_MENU_SOURCE).not.toContain("setMolecule(");
  });
});
