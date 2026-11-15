import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FILE_MENU_ITEMS, RECENT_SECTION_LABEL, type FileMenuId } from "./fileMenu";

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

    expect(ids).toContain("open");
    expect(ids).toContain("import");
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
 * `FileMenu.tsx` has no DOM test runner, so the trigger markup is read from the
 * source (`docs/conventions.md` §6.5, "Trigger icon"). The trigger is the first
 * `<button>` in the file; the popup renders after it.
 */
const FILE_MENU_SOURCE = readFileSync(new URL("./ui/FileMenu.tsx", import.meta.url), "utf8");

function triggerSource(): string {
  const start = FILE_MENU_SOURCE.indexOf("<button");
  const end = FILE_MENU_SOURCE.indexOf("</button>", start);

  expect(start, "trigger button").toBeGreaterThan(-1);
  expect(end, "trigger button closing tag").toBeGreaterThan(start);
  return FILE_MENU_SOURCE.slice(start, end + "</button>".length);
}

describe("FileMenu trigger icon", () => {
  it("renders an inline SVG icon before the File label", () => {
    const trigger = triggerSource();

    expect(trigger).toContain("<svg");
    expect(trigger.indexOf("<svg")).toBeLessThan(trigger.indexOf("File"));
    expect(trigger).toMatch(/>\s*File\s*</);
  });

  it("gives the icon a fixed 16 px box", () => {
    const trigger = triggerSource();

    expect(trigger).toMatch(/width=(?:"16"|\{16\})/);
    expect(trigger).toMatch(/height=(?:"16"|\{16\})/);
  });

  it("inherits the button colour through currentColor", () => {
    const trigger = triggerSource();

    expect(trigger).toMatch(/(?:stroke|fill)="currentColor"/);
  });
});
