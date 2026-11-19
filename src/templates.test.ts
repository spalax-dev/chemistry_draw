import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { pickTemplates, TEMPLATES } from "./templates";

/**
 * The legacy curated ring pool, in grid order (kept for reference; the live
 * Welcome cards come from the Structure Library in `src/templateLibrary.ts`):
 * name, SMILES, tag, one-line description and the old inline-SVG descriptor.
 */
const EXPECTED_TEMPLATES = [
  {
    id: "benzene",
    name: "Benzene Ring",
    structure: "c1ccccc1",
    tag: "Aromatic",
    description: "Aromatic six-membered ring.",
    preview: { kind: "ring", sides: 6, aromatic: true },
  },
  {
    id: "cyclopentadiene",
    name: "Cyclopentadiene",
    structure: "C1=CCC=C1",
    tag: "Diene",
    description: "Unsaturated five-membered ring with two conjugated double bonds.",
    preview: { kind: "ring", sides: 5, doubleBonds: 2 },
  },
  {
    id: "cyclohexane",
    name: "Cyclohexane",
    structure: "C1CCCCC1",
    tag: "Aliphatic",
    description: "Saturated six-membered ring.",
    preview: { kind: "ring", sides: 6 },
  },
  {
    id: "cyclopentane",
    name: "Cyclopentane",
    structure: "C1CCCC1",
    tag: "Aliphatic",
    description: "Saturated five-membered ring.",
    preview: { kind: "ring", sides: 5 },
  },
  {
    id: "cyclopropane",
    name: "Cyclopropane",
    structure: "C1CC1",
    tag: "Aliphatic",
    description: "Saturated three-membered ring.",
    preview: { kind: "ring", sides: 3 },
  },
  {
    id: "cyclobutane",
    name: "Cyclobutane",
    structure: "C1CCC1",
    tag: "Aliphatic",
    description: "Saturated four-membered ring.",
    preview: { kind: "ring", sides: 4 },
  },
  {
    id: "cycloheptane",
    name: "Cycloheptane",
    structure: "C1CCCCCC1",
    tag: "Aliphatic",
    description: "Saturated seven-membered ring.",
    preview: { kind: "ring", sides: 7 },
  },
  {
    id: "cyclooctane",
    name: "Cyclooctane",
    structure: "C1CCCCCCC1",
    tag: "Aliphatic",
    description: "Saturated eight-membered ring.",
    preview: { kind: "ring", sides: 8 },
  },
] as const;

/** The carbocycles keep the leading grid positions (`docs/architecture.md` §5.11). */
const CARBOCYCLE_IDS = EXPECTED_TEMPLATES.map((template) => template.id);

/**
 * The eight heteroatom rings activity 23 appends after the carbocycles
 * (`docs/architecture.md` §5.11). Only id, name, SMILES and tag are pinned here;
 * the previews have their own block below.
 */
const EXPECTED_HETEROATOMS = [
  { id: "pyridine", name: "Pyridine", structure: "c1ccncc1", tag: "Heteroaromatic" },
  { id: "pyrimidine", name: "Pyrimidine", structure: "c1cncnc1", tag: "Heteroaromatic" },
  { id: "furan", name: "Furan", structure: "c1ccoc1", tag: "Heteroaromatic" },
  { id: "thiophene", name: "Thiophene", structure: "c1ccsc1", tag: "Heteroaromatic" },
  { id: "imidazole", name: "Imidazole", structure: "c1c[nH]cn1", tag: "Heteroaromatic" },
  { id: "pyrrole", name: "Pyrrole", structure: "c1cc[nH]c1", tag: "Heteroaromatic" },
  { id: "piperidine", name: "Piperidine", structure: "C1CCNCC1", tag: "Heterocycle" },
  { id: "morpholine", name: "Morpholine", structure: "C1COCCN1", tag: "Heterocycle" },
] as const;

/**
 * Every heteroatom of each ring, at its documented 0-based vertex
 * (`docs/architecture.md` §5.11). The card draws one label per heteroatom.
 */
const EXPECTED_HETEROATOM_LABELS: Record<string, { vertex: number; atom: string }[]> = {
  pyridine: [{ vertex: 0, atom: "N" }],
  pyrimidine: [
    { vertex: 0, atom: "N" },
    { vertex: 2, atom: "N" },
  ],
  furan: [{ vertex: 0, atom: "O" }],
  thiophene: [{ vertex: 0, atom: "S" }],
  imidazole: [
    { vertex: 0, atom: "N" },
    { vertex: 2, atom: "N" },
  ],
  pyrrole: [{ vertex: 0, atom: "N" }],
  piperidine: [{ vertex: 0, atom: "N" }],
  morpholine: [
    { vertex: 0, atom: "O" },
    { vertex: 3, atom: "N" },
  ],
};

const HETEROATOM_ATOMS = ["N", "O", "S"];

/**
 * The legacy curated module (`src/templates.ts`): its ring descriptors are
 * retained as a documented fallback only. They are **not** the live Welcome
 * cards, which come from Ketcher's real Structure Library
 * (`src/templateLibrary.ts`, `docs/architecture.md` §5.11).
 */
describe("legacy curated welcome templates", () => {
  it("keeps the carbocycles first and the pool at twelve entries or more", () => {
    const ids = TEMPLATES.map((template) => template.id);

    expect(TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(ids.slice(0, CARBOCYCLE_IDS.length)).toEqual(CARBOCYCLE_IDS);
  });

  it("appends the documented heteroatom rings after the carbocycles", () => {
    for (const expected of EXPECTED_HETEROATOMS) {
      const index = TEMPLATES.findIndex((template) => template.id === expected.id);

      expect(index).toBeGreaterThanOrEqual(CARBOCYCLE_IDS.length);
      expect(TEMPLATES[index]?.name).toBe(expected.name);
      expect(TEMPLATES[index]?.structure).toBe(expected.structure);
      expect(TEMPLATES[index]?.tag).toBe(expected.tag);
    }
  });

  it("gives every template a non-empty, unique structure", () => {
    const structures = TEMPLATES.map((template) => template.structure);

    for (const structure of structures) {
      expect(structure.trim()).not.toBe("");
    }
    expect(new Set(structures).size).toBe(structures.length);
  });

  it("pins every name, SMILES, tag, description and preview descriptor", () => {
    for (const expected of EXPECTED_TEMPLATES) {
      const template = TEMPLATES.find((entry) => entry.id === expected.id);

      expect(template).toBeDefined();
      expect(template?.name).toBe(expected.name);
      expect(template?.structure).toBe(expected.structure);
      expect(template?.tag).toBe(expected.tag);
      expect(template?.description).toBe(expected.description);
      expect(template?.preview).toEqual(expected.preview);
    }
  });

  it("retires the Peptide Fragment and Reaction Scheme cards", () => {
    const ids = TEMPLATES.map((template) => template.id);
    const names = TEMPLATES.map((template) => template.name).join(" ");

    expect(ids).not.toContain("peptide");
    expect(ids).not.toContain("reaction");
    expect(names).not.toMatch(/peptide|reaction|scheme/i);
  });

  it("gives every template a unique non-empty id", () => {
    const ids = TEMPLATES.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.trim()).not.toBe("");
    }
  });

  it("describes every template in one non-empty sentence", () => {
    for (const template of TEMPLATES) {
      const description = template.description.trim();

      expect(description).not.toBe("");
      expect(description).not.toContain("\n");
      expect(description).toMatch(/^[^.!?]+[.!?]$/);
    }
  });

  it("draws a ring preview of the matching size for every card", () => {
    for (const template of TEMPLATES) {
      expect(template.preview.kind).toBe("ring");
      expect(template.preview.sides).toBeGreaterThanOrEqual(3);
      expect(template.preview.sides).toBeLessThanOrEqual(8);
    }
    expect(TEMPLATES.find((template) => template.id === "benzene")?.preview.aromatic).toBe(true);
    expect(
      TEMPLATES.find((template) => template.id === "cyclopentadiene")?.preview.doubleBonds,
    ).toBe(2);
  });
});

describe("template heteroatom previews", () => {
  it("labels at least four of the heteroatom rings", () => {
    const labelled = TEMPLATES.filter((template) => (template.preview.labels ?? []).length > 0);

    expect(labelled.length).toBeGreaterThanOrEqual(4);
  });

  it("labels each documented ring at its documented vertices", () => {
    for (const [id, labels] of Object.entries(EXPECTED_HETEROATOM_LABELS)) {
      const template = TEMPLATES.find((entry) => entry.id === id);

      expect(template).toBeDefined();
      expect(template?.preview.labels).toEqual(labels);
    }
  });

  it("uses only N, O or S at a distinct in-range vertex", () => {
    for (const template of TEMPLATES) {
      const labels = template.preview.labels ?? [];
      const vertices = labels.map((label) => label.vertex);

      expect(new Set(vertices).size).toBe(vertices.length);
      for (const label of labels) {
        expect(HETEROATOM_ATOMS).toContain(label.atom);
        expect(Number.isInteger(label.vertex)).toBe(true);
        expect(label.vertex).toBeGreaterThanOrEqual(0);
        expect(label.vertex).toBeLessThan(template.preview.sides);
      }
    }
  });

  it("leaves the carbocycle previews unlabelled", () => {
    for (const id of CARBOCYCLE_IDS) {
      expect(TEMPLATES.find((template) => template.id === id)?.preview.labels).toBeUndefined();
    }
  });

  it("keeps the documented aromatic flags and ring sizes", () => {
    for (const template of TEMPLATES) {
      expect(template.preview.kind).toBe("ring");
      expect(template.preview.sides).toBeGreaterThanOrEqual(3);

      const expected = EXPECTED_HETEROATOM_LABELS[template.id];
      if (expected === undefined) continue;
      expect(template.preview.aromatic).toBe(template.tag === "Heteroaromatic" ? true : undefined);
    }
  });
});

const TEMPLATE_LIBRARY_SOURCE = readFileSync(
  new URL("./templateLibrary.ts", import.meta.url),
  "utf8",
);

const TEMPLATES_SOURCE = readFileSync(new URL("./templates.ts", import.meta.url), "utf8");

/**
 * The Welcome pane always shows exactly four cards, independent of the viewport
 * width (`docs/architecture.md` §5.11): the count is the exported
 * `TEMPLATE_CARD_COUNT` and there is no width breakpoint table.
 */
describe("TEMPLATE_CARD_COUNT", () => {
  it("exports the constant from the template library", async () => {
    const library = await import("./templateLibrary");

    expect("TEMPLATE_CARD_COUNT" in library).toBe(true);
    expect(library.TEMPLATE_CARD_COUNT).toBe(4);
  });

  it("removes the width breakpoint helper from both modules", () => {
    expect(TEMPLATE_LIBRARY_SOURCE).not.toMatch(/templateCountForWidth/);
    expect(TEMPLATES_SOURCE).not.toMatch(/templateCountForWidth/);
  });

  it("samples at most four cards whatever the library size", async () => {
    const { sampleTemplates, TEMPLATE_CARD_COUNT } = await import("./templateLibrary");

    for (const size of [1, 4, 7, 40]) {
      const entries = Array.from({ length: size }, (_, index) => ({ id: `template-${index}` }));
      const picked = sampleTemplates(entries, TEMPLATE_CARD_COUNT, seededRandom(size));

      expect(picked.length).toBe(Math.min(size, 4));
      expect(picked.length).toBeLessThanOrEqual(4);
      expect(new Set(picked.map((entry) => entry.id)).size).toBe(picked.length);
    }
  });
});

/** A small deterministic PRNG so the sampling tests never depend on `Math.random`. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pickTemplates", () => {
  it("returns the requested number of distinct descriptors for 2, 4, 6 and 8", () => {
    for (const count of [2, 4, 6, 8]) {
      const picked = pickTemplates(TEMPLATES, count, seededRandom(count));

      expect(picked).toHaveLength(count);
      expect(new Set(picked.map((template) => template.id)).size).toBe(count);
    }
  });

  it("only ever returns descriptors from the pool", () => {
    const poolIds = new Set(TEMPLATES.map((template) => template.id));

    for (const count of [2, 4, 6, 8]) {
      for (const template of pickTemplates(TEMPLATES, count, seededRandom(count + 7))) {
        expect(poolIds.has(template.id)).toBe(true);
      }
    }
  });

  it("shows eight of the pool for the widest grid, never the whole pool", () => {
    const picked = pickTemplates(TEMPLATES, 8, () => 0.5);
    const ids = picked.map((template) => template.id);

    expect(picked).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(TEMPLATES.length).toBeGreaterThan(8);
    expect(new Set(ids)).not.toEqual(new Set(TEMPLATES.map((template) => template.id)));
  });

  it("never duplicates a card when the injected RNG is constant", () => {
    for (const value of [0, 0.5, 0.999999]) {
      const picked = pickTemplates(TEMPLATES, 8, () => value);
      const ids = picked.map((template) => template.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("clamps a count above the pool size to the pool", () => {
    const picked = pickTemplates(TEMPLATES, 20, seededRandom(1));

    expect(picked).toHaveLength(TEMPLATES.length);
    expect(new Set(picked.map((template) => template.id)).size).toBe(TEMPLATES.length);
  });

  it("returns an empty list for a zero or negative count", () => {
    expect(pickTemplates(TEMPLATES, 0, seededRandom(1))).toEqual([]);
    expect(pickTemplates(TEMPLATES, -3, seededRandom(1))).toEqual([]);
  });

  it("is reproducible for the same injected RNG sequence", () => {
    const first = pickTemplates(TEMPLATES, 4, seededRandom(2024));
    const second = pickTemplates(TEMPLATES, 4, seededRandom(2024));

    expect(first.map((template) => template.id)).toEqual(second.map((template) => template.id));
  });

  it("can pick a different subset for a different RNG sequence", () => {
    const alwaysFirst = pickTemplates(TEMPLATES, 2, () => 0);
    const alwaysLast = pickTemplates(TEMPLATES, 2, () => 0.999999);

    expect(alwaysFirst.map((template) => template.id)).not.toEqual(
      alwaysLast.map((template) => template.id),
    );
  });

  it("keeps the picked cards in pool order for a stable grid", () => {
    const picked = pickTemplates(TEMPLATES, 4, seededRandom(99));
    const poolIndex = new Map(TEMPLATES.map((template, index) => [template.id, index]));
    const indexes = picked.map((template) => poolIndex.get(template.id) ?? -1);

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

/**
 * No DOM test runner exists, so the card contract is checked against the
 * source: previews are rendered by Ketcher (`<img>` from `generateImage`, never
 * an inline drawing or a raster asset) and the cards stay inert until the
 * editor can load a structure (`docs/testing.md`, `docs/conventions.md` §6.8).
 */
const TEMPLATE_CARD_SOURCE = readFileSync(
  new URL("./ui/backstage/TemplateCard.tsx", import.meta.url),
  "utf8",
);

const WELCOME_SECTION_SOURCE = readFileSync(
  new URL("./ui/backstage/WelcomeSection.tsx", import.meta.url),
  "utf8",
);

const APP_SOURCE = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

const BACKSTAGE_UI_SOURCE = readFileSync(new URL("./ui/Backstage.tsx", import.meta.url), "utf8");

/**
 * The Welcome grid is a pure function of the viewport width and an injected
 * RNG, re-drawn on mount and whenever the breakpoint changes
 * (`docs/architecture.md` §5.11, `docs/testing.md` §5.1). No DOM test runner
 * exists, so the pane wiring is checked against the source: a map over a fixed
 * four-card list, a missing resize listener or an unkeyed `useMemo` must each
 * fail these assertions.
 */
describe("welcome responsive template wiring", () => {
  it("imports the sampling helper and the fixed card count; entries arrive as props", () => {
    expect(WELCOME_SECTION_SOURCE).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*["']\.\.\/\.\.\/templates["']/,
    );
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/\bTEMPLATES\b/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/\bpickTemplates\b/);
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*\bsampleTemplates\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/templateLibrary["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*\bTEMPLATE_CARD_COUNT\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/templateLibrary["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(/templates\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/renderPreview\??:/);
  });

  it("has no viewport width state or resize listener", () => {
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/templateCountForWidth/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/innerWidth/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/addEventListener\(\s*["']resize["']/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/removeEventListener\(\s*["']resize["']/);
  });

  it("samples the fixed four-card count with the mount RNG", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/const \[random\] = useState\(\(\) => Math\.random\)/);
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /const visibleTemplates = useMemo\(\s*\(\)\s*=>\s*sampleTemplates\(templates,\s*TEMPLATE_CARD_COUNT,\s*random\),\s*\[templates,\s*random\],?\s*\)/,
    );
  });

  it("renders the sampled subset, never a hardcoded four-card list", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/visibleTemplates\.map\(/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/const visibleTemplates = \[/);
    expect(WELCOME_SECTION_SOURCE).not.toMatch(
      /\[[^\]]*["']benzene["'][^\]]*["']cyclopentadiene["']/,
    );
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/TEMPLATES\.slice\(\s*0\s*,\s*4\s*\)/);
  });

  it("renders the More templates button and the Back to editor action", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/More templates/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/onClick=\{[^}]*onMoreTemplates/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/Back to editor/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/onClick=\{onBackToEditor\}/);
  });
});

describe("template card previews", () => {
  it("renders Ketcher's preview as an image, never an inline structure drawing", () => {
    expect(TEMPLATE_CARD_SOURCE).toMatch(/<img\b/);
    expect(TEMPLATE_CARD_SOURCE).toContain("preview.url");
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/<text\b/);
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/strokeWidth=\{1\.5\}|stroke-width="1\.5"/);

    // Exactly one inline SVG exists, and it is the loading spinner: the source
    // may not hand-author a structure anywhere on the card.
    expect(TEMPLATE_CARD_SOURCE.match(/<svg\b/g) ?? []).toHaveLength(1);

    const previewAreaStart = TEMPLATE_CARD_SOURCE.indexOf("function TemplatePreviewArea");
    expect(previewAreaStart).toBeGreaterThan(-1);
    const previewAreaEnd = TEMPLATE_CARD_SOURCE.indexOf("\nexport interface TemplateCardProps");
    expect(previewAreaEnd).toBeGreaterThan(previewAreaStart);

    const svgIndex = TEMPLATE_CARD_SOURCE.indexOf("<svg");
    expect(svgIndex).toBeGreaterThan(previewAreaStart);
    expect(svgIndex).toBeLessThan(previewAreaEnd);

    const previewArea = TEMPLATE_CARD_SOURCE.slice(previewAreaStart, previewAreaEnd);
    const spinnerStart = previewArea.indexOf("<svg");
    const spinnerEnd = previewArea.indexOf("</svg>", spinnerStart);
    expect(spinnerStart).toBeGreaterThan(-1);
    expect(spinnerEnd).toBeGreaterThan(spinnerStart);

    const spinner = previewArea.slice(spinnerStart, spinnerEnd + "</svg>".length);
    expect(spinner).toContain("animateTransform");
    expect(spinner).toContain("<circle");

    // Outside the spinner block the card draws no vector primitives at all.
    const outsideSpinner = TEMPLATE_CARD_SOURCE.replace(spinner, "");
    for (const primitive of [/<path\b/, /<polygon\b/, /<circle\b/, /<text\b/]) {
      expect(outsideSpinner).not.toMatch(primitive);
    }
  });

  it("shows only Ketcher-produced previews, never a bundled raster asset", () => {
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/<image\b/i);
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/data:image/i);
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/\.(png|jpe?g|gif|webp)\b/i);
  });

  it("draws no hand-positioned heteroatom labels", () => {
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/<text\b/);
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/fontSize=\{10\}/);
    expect(TEMPLATE_CARD_SOURCE).not.toMatch(/fill=\{tokens\.color\.textSecondary\}/);
  });
});

/**
 * While the deferred library build lands the grid paints placeholder cards, not
 * a curated or partial set (`docs/architecture.md` §5.11, `docs/conventions.md`
 * §6.8). No DOM runner exists, so the count and the inert wiring are pinned
 * against the source: a hardcoded skeleton count, a missing `aria-hidden` or a
 * clickable skeleton must each fail.
 */
describe("welcome template skeletons", () => {
  it("renders exactly four skeletons from TEMPLATE_CARD_COUNT", async () => {
    const { TEMPLATE_CARD_COUNT } = await import("./templateLibrary");

    expect(TEMPLATE_CARD_COUNT).toBe(4);
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /Array\.from\(\s*\{\s*length:\s*TEMPLATE_CARD_COUNT\s*\}/,
    );

    const loadingStart = WELCOME_SECTION_SOURCE.indexOf("{templatesLoading && (");
    expect(loadingStart).toBeGreaterThan(-1);
    const loadingEnd = WELCOME_SECTION_SOURCE.indexOf("{!templatesLoading &&", loadingStart);
    expect(loadingEnd).toBeGreaterThan(loadingStart);
    const skeletonBlock = WELCOME_SECTION_SOURCE.slice(loadingStart, loadingEnd);

    expect(skeletonBlock).toMatch(/<TemplateSkeletonCard\b/);
    expect(skeletonBlock).not.toMatch(/onClick/);
  });

  it("keeps the skeleton cards aria-hidden and non-interactive", () => {
    const cardStart = WELCOME_SECTION_SOURCE.indexOf("function TemplateSkeletonCard");
    expect(cardStart).toBeGreaterThan(-1);
    const cardEnd = WELCOME_SECTION_SOURCE.indexOf("const RECENT_HEADER", cardStart);
    expect(cardEnd).toBeGreaterThan(cardStart);
    const skeletonCard = WELCOME_SECTION_SOURCE.slice(cardStart, cardEnd);

    expect(skeletonCard).toMatch(/aria-hidden="true"/);
    expect(skeletonCard).toMatch(/<div\b/);
    expect(skeletonCard).not.toMatch(/<button\b/);
    expect(skeletonCard).not.toMatch(/onClick/);
  });
});

describe("template cards before the editor is ready", () => {
  it("takes a disabled prop, reports it and ignores the click", () => {
    expect(TEMPLATE_CARD_SOURCE).toMatch(/disabled\??:/);
    expect(TEMPLATE_CARD_SOURCE).toContain("aria-disabled");
    expect(TEMPLATE_CARD_SOURCE).toMatch(/if\s*\(\s*disabled\s*\)\s*return/);
  });

  it("is wired from Backstage through the editor readiness", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/disabled\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/<TemplateCard[\s\S]{0,200}?disabled=\{/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(/editorReady\??:/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /<WelcomeSection[\s\S]{0,400}?disabled=\{!\s*editorReady\s*\}/,
    );
    expect(APP_SOURCE).toMatch(/<Backstage[\s\S]{0,3000}?editorReady=\{ready\}/);
  });
});

describe("template insert failure", () => {
  it("restores the active tab into the editor after a mid-insert failure", () => {
    const insertStart = APP_SOURCE.indexOf("const insertTemplate = useCallback(");

    expect(insertStart).toBeGreaterThan(-1);
    const insertSource = APP_SOURCE.slice(insertStart, APP_SOURCE.indexOf("\n  );", insertStart));
    const catchStart = insertSource.indexOf("} catch (error) {");
    const catchSource = insertSource.slice(catchStart);

    expect(catchStart).toBeGreaterThan(-1);
    expect(catchSource).toContain("loadTabIntoEditor(activeTab(tabsRef.current))");
    expect(catchSource).not.toContain("setBackstageOpen(false)");
  });
});

/**
 * **More templates** closes the overlay and opens Ketcher's real Structure
 * Library through `src/ketcherOptions.ts` (`docs/architecture.md` §5.11). There
 * is no DOM test runner, so the pane/wiring and the dispatched action are
 * checked against the source.
 */
const KETCHER_OPTIONS_URL = new URL("./ketcherOptions.ts", import.meta.url);

function ketcherOptionsSource(): string {
  return existsSync(KETCHER_OPTIONS_URL) ? readFileSync(KETCHER_OPTIONS_URL, "utf8") : "";
}

describe("welcome More templates", () => {
  it("renders a More templates button beside the TEMPLATES heading", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/More templates/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/onMoreTemplates\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/onClick=\{[^}]*onMoreTemplates/);
  });

  it("keeps the More templates button disabled until the editor is ready", () => {
    const labelIndex = WELCOME_SECTION_SOURCE.indexOf("More templates");
    const button = WELCOME_SECTION_SOURCE.slice(
      Math.max(0, labelIndex - 300),
      labelIndex + "More templates".length,
    );

    expect(labelIndex).toBeGreaterThan(-1);
    expect(button).toMatch(/disabled=\{/);
    expect(button).toMatch(/onMoreTemplates/);
  });

  it("passes onMoreTemplates from the backstage", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/onMoreTemplates\??:/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(/<WelcomeSection[\s\S]{0,600}?onMoreTemplates=\{/);
  });

  it("closes the backstage before opening the structure library", () => {
    expect(APP_SOURCE).toMatch(
      /import\s*\{[^}]*openStructureLibrary[^}]*\}\s*from\s*["']\.\/ketcherOptions["']/,
    );
    expect(APP_SOURCE).toMatch(/setBackstageOpen\(false\);[\s\S]{0,160}?openStructureLibrary\(/);
    expect(APP_SOURCE).toMatch(/<Backstage[\s\S]{0,3000}?onMoreTemplates=\{/);
  });

  it("ships the ketcherOptions helper module", () => {
    expect(existsSync(KETCHER_OPTIONS_URL)).toBe(true);
    expect(ketcherOptionsSource()).toMatch(/export\s+function\s+openStructureLibrary\b/);
  });

  it("dispatches MODAL_OPEN for the templates dialog with a null tab", () => {
    const source = ketcherOptionsSource();

    expect(source).not.toBe("");
    expect(source).toMatch(/type:\s*["']MODAL_OPEN["']/);
    expect(source).toMatch(/name:\s*["']templates["']/);
    expect(source).toMatch(/prop:\s*\{/);
    expect(source).toMatch(/tab:\s*null/);
    expect(source).toMatch(/dispatch\(/);
    expect(source).toMatch(/store/i);
  });
});

/**
 * **Back to editor** is the first primary Welcome action when tabs exist, and it
 * only closes the overlay (`docs/architecture.md` §5.11).
 */
describe("welcome Back to editor", () => {
  it("derives hasDocument from the tab set with isUntouchedTab", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/tabs\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*\bisUntouchedTab\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/tabs["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /const hasDocument = tabs\.tabs\.some\(\s*\(tab\) => !isUntouchedTab\(tab\)\s*\)/,
    );
    expect(WELCOME_SECTION_SOURCE).not.toMatch(/tabs\.tabs\.length\s*>\s*0/);
  });

  it("shows the primary Back to editor only when a document exists", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/\{hasDocument \? \(/);
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /<Button variant="primary"[\s\S]{0,160}?onClick=\{onBackToEditor\}/,
    );
  });

  it("makes Blank canvas primary only when no document exists", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/variant=\{hasDocument \? "secondary" : "primary"\}/);
  });

  it("labels the action with tabTitle so the dirty marker shows", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*tabTitle[^}]*\}\s*from\s*["']\.\.\/\.\.\/tabs["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /Back to editor — \{[^}]*tabTitle\(|`Back to editor — \$\{[^}]*tabTitle\(/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(/activeTab\(/);
  });

  it("calls the provided return handler", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(/onBackToEditor/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/onClick=\{onBackToEditor\}/);
  });

  it("is wired from Backstage with the tab set and the close handler", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/<WelcomeSection[\s\S]{0,600}?tabs=\{tabs\}/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(/<WelcomeSection[\s\S]{0,600}?onBackToEditor=\{onClose\}/s);
  });
});

describe("backstage default Welcome reset", () => {
  it("initializes the section from DEFAULT_BACKSTAGE_SECTION", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /useState<BackstageSectionId>\(DEFAULT_BACKSTAGE_SECTION\)/,
    );
  });

  it("is unmounted on close so the next open starts on Welcome", () => {
    expect(APP_SOURCE).toMatch(/\{backstageOpen && \(\s*<Backstage\b/);
  });
});

/**
 * The top bar carries only the logo and the `Chemistry Draw | Backstage` title;
 * the rail's **Exit Backstage** is the only way out (`docs/architecture.md`
 * §5.11). There is no DOM test runner, so the absence is checked against the
 * source slice of the `<header>`.
 */
describe("backstage top bar", () => {
  function between(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);

    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("contains no Back to Editor control", () => {
    const topBar = between(BACKSTAGE_UI_SOURCE, "<header style={TOP_BAR}>", "</header>");

    expect(topBar).not.toMatch(/Back to [Ee]ditor/);
    expect(topBar).not.toMatch(/onClose/);
    expect(topBar).not.toMatch(/←|u2190|&larr;/);
  });

  it("keeps Exit Backstage in the rail as the close control", () => {
    const footer = between(BACKSTAGE_UI_SOURCE, "<div style={RAIL_FOOTER}>", "</div>");

    expect(footer).toMatch(/Exit Backstage/);
    expect(footer).toMatch(/onClick=\{onClose\}/);
  });
});

/**
 * The Open pane is the renamed Recent pane: no DOM test runner exists, so the
 * no-preview rule and the rename are checked against the source
 * (`docs/architecture.md` §5.11).
 */
const OPEN_SECTION_URL = new URL("./ui/backstage/OpenSection.tsx", import.meta.url);

const RECENT_SECTION_URL = new URL("./ui/backstage/RecentSection.tsx", import.meta.url);

function openSectionSource(): string {
  return existsSync(OPEN_SECTION_URL) ? readFileSync(OPEN_SECTION_URL, "utf8") : "";
}

describe("backstage Open pane", () => {
  it("ships a dedicated OpenSection module", () => {
    expect(existsSync(OPEN_SECTION_URL)).toBe(true);
  });

  it("no longer ships the RecentSection module", () => {
    expect(existsSync(RECENT_SECTION_URL)).toBe(false);
  });

  it("delegates previews to the shared recent table instead of drawing its own", () => {
    const source = openSectionSource();

    expect(source).not.toBe("");
    // Previews now live in RecentStructuresTable; the section only wires it.
    expect(source).toContain("RecentStructuresTable");
    for (const forbidden of [/<img\b/i, /<svg\b/i]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("is wired for the open section and no longer imports RecentSection", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("RecentSection");
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /import\s+\{\s*OpenSection\s*\}\s+from\s+["']\.\/backstage\/OpenSection["']/,
    );
    expect(BACKSTAGE_UI_SOURCE).toMatch(/case\s+"open":[\s\S]{0,300}?<OpenSection\b/);
  });
});

/**
 * The Welcome actions are a horizontal wrapping row, not a vertical column
 * (`docs/architecture.md` §5.11, `docs/conventions.md` §6.8). No DOM runner
 * exists, so the layout contract is pinned against the shared style module and
 * the pane source: switching back to a column, stretching the buttons or adding
 * a fifth action must each fail these assertions.
 */
const SECTION_STYLES_SOURCE = readFileSync(
  new URL("./ui/backstage/sectionStyles.ts", import.meta.url),
  "utf8",
);

function styleBlock(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export const ${name}: CSSProperties = \\{([\\s\\S]*?)\\n\\};`),
  );
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("welcome action row layout", () => {
  it("lays the actions out as a horizontal wrapping row", () => {
    const list = styleBlock(SECTION_STYLES_SOURCE, "ACTION_LIST");

    expect(list).toMatch(/display:\s*["']flex["']/);
    expect(list).toMatch(/flexDirection:\s*["']row["']/);
    expect(list).toMatch(/flexWrap:\s*["']wrap["']/);
    expect(list).toMatch(/gap:\s*8\b/);
    expect(list).toMatch(/alignItems:\s*["']center["']/);
    expect(list).toMatch(/maxWidth:\s*720\b/);
    expect(list).not.toMatch(/flexDirection:\s*["']column["']/);
  });

  it("sizes each action button to its content", () => {
    const button = styleBlock(SECTION_STYLES_SOURCE, "ACTION_BUTTON");

    expect(button).toMatch(/minHeight:\s*36\b/);
    expect(button).toMatch(/justifyContent:\s*["']center["']/);
    expect(button).not.toMatch(/width:\s*["']100%["']/);
    expect(button).not.toMatch(/alignSelf:\s*["']stretch["']/);
  });

  it("keeps the four-action maximum in the Welcome pane", () => {
    const start = WELCOME_SECTION_SOURCE.indexOf("<div style={ACTION_LIST}>");
    const end = WELCOME_SECTION_SOURCE.indexOf("</div>", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const actions = WELCOME_SECTION_SOURCE.slice(start, end);

    expect((actions.match(/<Button\b/g) ?? []).length).toBe(4);
    expect(actions).toMatch(/Back to editor/);
    expect(actions).toMatch(/Blank canvas/);
    expect(actions).toMatch(/Import structure/);
    expect(actions).toMatch(/Open project/);
  });

  it("still samples exactly TEMPLATE_CARD_COUNT (four) template cards", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /sampleTemplates\(templates,\s*TEMPLATE_CARD_COUNT,\s*random\)/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(/visibleTemplates\.map\(/);
  });
});

/**
 * The Open pane renders the same **Recent structures** table as Welcome
 * (`docs/architecture.md` §5.11), with an added **Remove** action. No DOM test
 * runner exists, so the delegation, the optional action and the App wiring are
 * checked against the source: a second hand-built list, an unconditional
 * Remove button or an unwired pane must each fail these assertions.
 */
const RECENT_STRUCTURES_TABLE_URL = new URL(
  "./ui/backstage/RecentStructuresTable.tsx",
  import.meta.url,
);

function recentStructuresTableSource(): string {
  return existsSync(RECENT_STRUCTURES_TABLE_URL)
    ? readFileSync(RECENT_STRUCTURES_TABLE_URL, "utf8")
    : "";
}

/** The `<Tag ... />` element in `source`, from its opening to its self-close. */
function selfClosingElement(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}`);
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe("backstage Open shared recent table", () => {
  it("imports and renders RecentStructuresTable with rows, loading, onOpen and onRemove", () => {
    const source = openSectionSource();

    expect(source).toMatch(
      /import\s*\{\s*RecentStructuresTable\s*\}\s*from\s*["']\.\/RecentStructuresTable["']/,
    );

    const table = selfClosingElement(source, "RecentStructuresTable");

    expect(table).toMatch(/\brows=\{/);
    expect(table).toMatch(/\bloading=\{/);
    expect(table).toMatch(/\bonOpen=\{/);
    expect(table).toMatch(/\bonRemove=\{/);
  });

  it("keeps the open-tabs list with its Switch action below the table", () => {
    const source = openSectionSource();
    const tableIndex = source.indexOf("<RecentStructuresTable");
    const tabsIndex = source.indexOf("tabs.tabs.map(");

    expect(tableIndex).toBeGreaterThan(-1);
    expect(tabsIndex).toBeGreaterThan(tableIndex);
    expect(source).toMatch(/onClick=\{\(\) => onSwitchTab\(tab\.id\)\}/);
    expect(source).toMatch(/>\s*Switch\s*</);
  });

  it("accepts an optional onRemove on the shared table", () => {
    const source = recentStructuresTableSource();

    expect(source).not.toBe("");
    expect(source).toMatch(/onRemove\?:\s*\(path:\s*string\)\s*=>\s*void/);
  });

  it("renders the Remove action only when onRemove is provided", () => {
    const source = recentStructuresTableSource();
    const guard = source.search(/\bonRemove\s*(?:&&|\?\s*\()/);
    const removeIndex = source.search(/>\s*Remove\s*</);

    expect(guard).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(guard);
  });

  it("passes the loaded rows and loading flag from Backstage to OpenSection", () => {
    const openSection = selfClosingElement(BACKSTAGE_UI_SOURCE, "OpenSection");

    expect(openSection).toMatch(/\brecentStructures\b/);
    expect(openSection).toMatch(/\brecentStructuresLoading\b/);
  });
});
