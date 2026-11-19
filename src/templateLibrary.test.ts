import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TemplateSource } from "./templateLibrary";

/**
 * The real Structure Library entries replace the curated ring pool
 * (`docs/architecture.md` §5.11): the mapper is pure, dedupes by the
 * case-insensitive name and keeps the provider order.
 */
const LIBRARY_SOURCES: TemplateSource[] = [
  { name: "Acetic Acid", group: "functional-group", ket: "KET-acetic-acid" },
  { name: "Boc", group: "functional-group", ket: "KET-boc" },
  { name: "N,N-Diisopropylethylamine", group: "salt-solvent", ket: "KET-diea" },
];

const WELCOME_SECTION_SOURCE = readFileSync(
  new URL("./ui/backstage/WelcomeSection.tsx", import.meta.url),
  "utf8",
);

const BACKSTAGE_UI_SOURCE = readFileSync(new URL("./ui/Backstage.tsx", import.meta.url), "utf8");

const APP_SOURCE = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

const KETCHER_OPTIONS_SOURCE = readFileSync(
  new URL("./ketcherOptions.ts", import.meta.url),
  "utf8",
);

/** Loads the mapper lazily so the source contracts still run before it exists. */
async function build(entries: TemplateSource[]) {
  const { buildLibraryTemplates } = await import("./templateLibrary");
  return buildLibraryTemplates(entries);
}

/** Source slice from `startMarker` up to the next `endMarker` (exclusive). */
function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf(endMarker, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("buildLibraryTemplates", () => {
  it("maps every source to its id, trimmed name, group and KET in provider order", async () => {
    expect(await build(LIBRARY_SOURCES)).toEqual([
      {
        id: "acetic-acid",
        name: "Acetic Acid",
        group: "functional-group",
        ket: "KET-acetic-acid",
      },
      { id: "boc", name: "Boc", group: "functional-group", ket: "KET-boc" },
      {
        id: "n-n-diisopropylethylamine",
        name: "N,N-Diisopropylethylamine",
        group: "salt-solvent",
        ket: "KET-diea",
      },
    ]);
  });

  it("slugs names into lower-case dash-separated ids", async () => {
    const ids = (await build(LIBRARY_SOURCES)).map((template) => template.id);

    expect(ids).toEqual(["acetic-acid", "boc", "n-n-diisopropylethylamine"]);
  });

  it("trims a padded name before using it", async () => {
    const [template] = await build([
      { name: "  Acetic Acid  ", group: "functional-group", ket: "KET-acetic-acid" },
    ]);

    expect(template?.name).toBe("Acetic Acid");
    expect(template?.id).toBe("acetic-acid");
  });

  it("dedupes case-insensitively and keeps the first occurrence", async () => {
    const entries = await build([
      { name: "Benzene", group: "functional-group", ket: "KET-first" },
      { name: " benzene ", group: "salt-solvent", ket: "KET-second" },
      { name: "BENZENE", group: "salt-solvent", ket: "KET-third" },
    ]);

    expect(entries).toEqual([
      { id: "benzene", name: "Benzene", group: "functional-group", ket: "KET-first" },
    ]);
  });

  it("skips entries with an empty name or an empty KET", async () => {
    const entries = await build([
      { name: "", group: "functional-group", ket: "KET-empty-name" },
      { name: "   ", group: "functional-group", ket: "KET-blank-name" },
      { name: "Kept", group: "functional-group", ket: "KET-kept" },
      { name: "No ket", group: "salt-solvent", ket: "" },
      { name: "Blank ket", group: "salt-solvent", ket: "   " },
    ]);

    expect(entries).toEqual([
      { id: "kept", name: "Kept", group: "functional-group", ket: "KET-kept" },
    ]);
  });

  it("returns an empty list for an empty source list", async () => {
    expect(await build([])).toEqual([]);
  });
});

/**
 * The Welcome cards come from the real Structure Library only. There is no DOM
 * test runner, so the pane/wiring is checked against the source
 * (`docs/testing.md` §5.1, activity 24).
 */
describe("welcome template source contract", () => {
  it("no longer imports the curated pool or its sampler", () => {
    expect(WELCOME_SECTION_SOURCE).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*["']\.\.\/\.\.\/templates["']/,
    );
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/\bTEMPLATES\b/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/\bpickTemplates\b/);
  });

  it("takes the library entries through a templates prop", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/templates\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/<TemplateCard[\s\S]{0,240}?template=\{/);
  });

  it("passes a templates prop from the backstage", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/<WelcomeSection[\s\S]{0,900}?templates=\{/);
  });

  it("renders the empty state instead of cards when the library is empty", () => {
    expect(WELCOME_SECTION_SOURCE).toContain("templates.length === 0");
    expect(WELCOME_SECTION_SOURCE).toContain("No templates available");

    const emptyBranch = sourceBetween(
      WELCOME_SECTION_SOURCE,
      "templates.length === 0 ? (",
      ") : (",
    );
    expect(emptyBranch).toContain("No templates available");
    expect(emptyBranch).not.toContain("<WelcomeTemplateCard");
    expect(emptyBranch).not.toContain("visibleTemplates.map(");

    const cardsBranch = sourceBetween(WELCOME_SECTION_SOURCE, ") : (", "\n      )}");
    expect(cardsBranch).toMatch(/visibleTemplates\.map\(/);
    expect(cardsBranch).toContain("<WelcomeTemplateCard");
  });
});

/**
 * An armed template tool must not survive opening the backstage or switching
 * tabs (`docs/architecture.md` §5.11, "Tool reset"). The helper dispatches the
 * same Escape a user would; the App calls it before serializing/loading.
 */
describe("template tool reset contract", () => {
  it("calls cancelActiveTool first when opening the backstage", () => {
    const openBackstage = sourceBetween(
      APP_SOURCE,
      "const openBackstage = useCallback(",
      "\n  const closeBackstage",
    );

    expect(openBackstage).toMatch(/cancelActiveTool\(/);
    expect(openBackstage.indexOf("cancelActiveTool(")).toBeLessThan(
      openBackstage.indexOf("setBackstageOpen("),
    );
  });

  it("calls cancelActiveTool before serializing and loading in activateTabById", () => {
    const activateTabById = sourceBetween(
      APP_SOURCE,
      "const activateTabById = useCallback(",
      "\n  const saveActiveTab",
    );

    expect(activateTabById).toMatch(/cancelActiveTool\(/);
    expect(activateTabById.indexOf("cancelActiveTool(")).toBeLessThan(
      activateTabById.indexOf("getKet()"),
    );
    expect(activateTabById.indexOf("cancelActiveTool(")).toBeLessThan(
      activateTabById.indexOf("loadTabIntoEditor("),
    );
  });

  it("exports a cancelActiveTool helper from ketcherOptions", () => {
    expect(KETCHER_OPTIONS_SOURCE).toMatch(/export\s+function\s+cancelActiveTool\b/);
  });

  it("dispatches a bubbling, cancelable Escape keydown to the Ketcher root", () => {
    const helper = sourceBetween(
      KETCHER_OPTIONS_SOURCE,
      "export function cancelActiveTool",
      "\nexport ",
    );

    expect(helper).toMatch(/querySelector\(\s*["']\.Ketcher-root["']\s*\)/);
    expect(helper).toMatch(/key:\s*["']Escape["']/);
    expect(helper).toMatch(/bubbles:\s*true/);
    expect(helper).toMatch(/cancelable:\s*true/);
    expect(helper).toMatch(/dispatchEvent\(/);
    expect(helper).not.toMatch(/\.click\(/);
  });
});
