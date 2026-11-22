import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  declaredVersion,
  normalizeSection,
  type BackstageSection,
  type BackstageSectionId,
} from "./backstage";

/**
 * The backstage model and its pane wiring (`docs/architecture.md` §5.1,
 * `docs/planning/contracts.md` §5). The rail is fixed, unknown ids never render
 * an empty pane, and the overlay never mounts an editor or touches a document.
 */

const SECTION_IDS: BackstageSectionId[] = ["welcome", "open", "models", "about"];

const SECTION_LABELS = ["Welcome", "Open", "Models", "About"];

describe("backstage section list", () => {
  it("exports the four sections in rail order", () => {
    const sections: BackstageSection[] = BACKSTAGE_SECTIONS;

    expect(sections.map((section) => section.id)).toEqual(SECTION_IDS);
    expect(sections).toHaveLength(4);
  });

  it("labels every section exactly", () => {
    expect(BACKSTAGE_SECTIONS.map((section) => section.label)).toEqual(SECTION_LABELS);
  });

  it("defaults to the Welcome section", () => {
    expect(DEFAULT_BACKSTAGE_SECTION).toBe("welcome");
    expect(SECTION_IDS).toContain(DEFAULT_BACKSTAGE_SECTION);
  });

  it("contains no settings or save-export section", () => {
    const ids: string[] = SECTION_IDS;

    expect(ids).not.toContain("settings");
    expect(ids).not.toContain("save-export");
  });
});

describe("normalizeSection", () => {
  it("returns each known section id unchanged", () => {
    for (const id of SECTION_IDS) {
      expect(normalizeSection(id)).toBe(id);
    }
  });

  it("returns welcome for an unknown, stale or empty id", () => {
    expect(normalizeSection("settings")).toBe("welcome");
    expect(normalizeSection("save-export")).toBe("welcome");
    expect(normalizeSection("templates")).toBe("welcome");
    expect(normalizeSection("")).toBe("welcome");
    expect(normalizeSection("Welcome")).toBe("welcome");
  });
});

describe("declaredVersion", () => {
  it("strips the caret and tilde range prefixes", () => {
    expect(declaredVersion("^3.18.0")).toBe("3.18.0");
    expect(declaredVersion("~1.2")).toBe("1.2");
  });

  it("keeps the first numeric version of a range or a bare version", () => {
    expect(declaredVersion(">=18.3.1 <19")).toBe("18.3.1");
    expect(declaredVersion("18.3.1")).toBe("18.3.1");
  });

  it("trims a value with no version and passes Unavailable through", () => {
    expect(declaredVersion("Unavailable")).toBe("Unavailable");
    expect(declaredVersion("  next ")).toBe("next");
  });
});

/**
 * No DOM renderer exists in Vitest (`docs/harness/testing.md` §3), so the
 * overlay's structural rules are read from the source. These assertions pin
 * the 1.x contract: the rail and the panes come from the model, an unknown id
 * falls back to Welcome, and the overlay never owns a second editor or a
 * document command.
 */
const BACKSTAGE_UI_SOURCE = readFileSync(new URL("./ui/Backstage.tsx", import.meta.url), "utf8");

describe("backstage rail wiring", () => {
  it("builds the rail from BACKSTAGE_SECTIONS", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /import\s*\{[^}]*\bBACKSTAGE_SECTIONS\b[^}]*\}\s*from\s*["']\.\.\/backstage["']/,
    );
    expect(BACKSTAGE_UI_SOURCE).toMatch(/BACKSTAGE_SECTIONS\.map\(/);
  });

  it("opens on the default Welcome section", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /import\s*\{[^}]*\bDEFAULT_BACKSTAGE_SECTION\b[^}]*\}\s*from\s*["']\.\.\/backstage["']/,
    );
    expect(BACKSTAGE_UI_SOURCE).toMatch(/useState(?:<[^>]+>)?\(\s*DEFAULT_BACKSTAGE_SECTION\s*\)/);
  });

  it("normalizes the section before choosing a pane", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/normalizeSection\(\s*section\s*\)/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(/switch\s*\(\s*[^)]*current\s*\)/);
  });

  it("renders Welcome for an unknown section instead of an empty pane", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/default:\s*\{?\s*return\s*\(\s*<WelcomeSection\b/);
    expect(BACKSTAGE_UI_SOURCE).not.toMatch(/default:\s*(?:\{\s*)?return\s+(?:null|undefined)\b/);
  });
});

describe("backstage exit control", () => {
  it("labels the rail close button Back to editor", () => {
    expect(BACKSTAGE_UI_SOURCE).toContain("Back to editor");
    expect(BACKSTAGE_UI_SOURCE).not.toContain("Exit Backstage");
  });

  it("closes the overlay through the provided handler", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/onClick=\{onClose\}/);
  });
});

describe("backstage document safety", () => {
  it("never mounts a second editor", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toMatch(/<Editor\b/);
  });

  it("never saves or loads a structure from the overlay", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("setMolecule(");
    expect(BACKSTAGE_UI_SOURCE).not.toContain("getKet(");
  });
});
