import { readdirSync, readFileSync } from "node:fs";

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

const TEMPLATE_CARD_SOURCE = readFileSync(
  new URL("./ui/backstage/TemplateCard.tsx", import.meta.url),
  "utf8",
);

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

/** Loads the preview helper lazily so every source contract still runs. */
async function preview(ket: string): Promise<string> {
  const { previewKetWithoutSgroups } = await import("./templateLibrary");
  return previewKetWithoutSgroups(ket);
}

interface SgroupEntry {
  abbreviation?: string;
  [field: string]: unknown;
}

/** The parts of a KET document the preview test inspects. */
interface KetDocument {
  header?: unknown;
  root?: unknown;
  mol0?: {
    type?: string;
    atoms?: unknown[];
    bonds?: unknown[];
    sgroups?: SgroupEntry[];
    fragments?: { sgroups?: SgroupEntry[] }[];
    nested?: { deeper?: { sgroups?: SgroupEntry[] } };
  };
  mol1?: {
    type?: string;
    atoms?: unknown[];
    sgroups?: SgroupEntry[];
  };
}

/**
 * A real library entry shape: the SGroups carry the labels Indigo would draw
 * (`Et`, `Boc`) next to the atoms and bonds that must survive the copy.
 */
const SGROUP_KET = JSON.stringify({
  header: { version: "0.1", moleculeCount: 1 },
  root: { nodes: [{ $ref: "mol0" }] },
  mol0: {
    type: "molecule",
    atoms: [
      { label: "C", location: [0, 0, 0] },
      { label: "O", location: [1.5, 0, 0] },
    ],
    bonds: [{ type: 1, atoms: [0, 1] }],
    sgroups: [
      { type: "SUP", abbreviation: "Et", atoms: [0] },
      { type: "SUP", abbreviation: "Boc", atoms: [1] },
    ],
  },
});

/** SGroups live in two molecule nodes, an array child and a deeper object. */
const NESTED_SGROUP_KET = JSON.stringify({
  header: { version: "0.1", moleculeCount: 2 },
  root: { nodes: [{ $ref: "mol0" }, { $ref: "mol1" }] },
  mol0: {
    type: "molecule",
    atoms: [{ label: "N", location: [0, 0, 0] }],
    sgroups: [{ type: "SUP", abbreviation: "OMe" }],
    fragments: [{ type: "fragment", sgroups: [{ abbreviation: "Ac" }] }],
    nested: { deeper: { sgroups: [{ abbreviation: "Bz" }] } },
  },
  mol1: {
    type: "molecule",
    atoms: [{ label: "S", location: [3, 0, 0] }],
    sgroups: [{ type: "SUP", abbreviation: "Tos" }],
  },
});

const PLAIN_KET = JSON.stringify({
  header: { version: "0.1", moleculeCount: 1 },
  root: { nodes: [{ $ref: "mol0" }] },
  mol0: {
    type: "molecule",
    atoms: [{ label: "C", location: [0, 0, 0] }],
    bonds: [],
  },
});

/**
 * Indigo draws a collapsed SGroup as its abbreviation, so the preview copy has
 * no SGroups at all while atoms, bonds and the header stay untouched
 * (`docs/architecture.md` §5.11).
 */
describe("previewKetWithoutSgroups", () => {
  it("empties the sgroups and keeps the atoms, bonds and header", async () => {
    const result = JSON.parse(await preview(SGROUP_KET)) as KetDocument;
    const source = JSON.parse(SGROUP_KET) as KetDocument;

    expect(result.mol0?.sgroups).toEqual([]);
    expect(result.mol0?.atoms).toEqual(source.mol0?.atoms);
    expect(result.mol0?.bonds).toEqual(source.mol0?.bonds);
    expect(result.header).toEqual(source.header);
    expect(result.root).toEqual(source.root);
  });

  it("empties sgroups nested in every molecule object and array", async () => {
    const result = JSON.parse(await preview(NESTED_SGROUP_KET)) as KetDocument;

    expect(result.mol0?.sgroups).toEqual([]);
    expect(result.mol0?.fragments?.[0]?.sgroups).toEqual([]);
    expect(result.mol0?.nested?.deeper?.sgroups).toEqual([]);
    expect(result.mol1?.sgroups).toEqual([]);
  });

  it("returns an equivalent document when there is no sgroup", async () => {
    const result = JSON.parse(await preview(PLAIN_KET)) as unknown;

    expect(result).toEqual(JSON.parse(PLAIN_KET));
  });

  it("returns malformed JSON unchanged", async () => {
    expect(await preview("not json")).toBe("not json");
  });

  it("is deterministic and leaves the source constant intact", async () => {
    const once = await preview(SGROUP_KET);
    const twice = await preview(SGROUP_KET);

    expect(twice).toBe(once);
    const original = JSON.parse(SGROUP_KET) as KetDocument;
    expect(original.mol0?.sgroups?.map((sgroup) => sgroup.abbreviation)).toEqual(["Et", "Boc"]);
  });
});

/** Collects every source file under `src/` so the legacy name can be traced. */
function listSourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name, directory);
    if (entry.isDirectory()) return listSourceFiles(new URL(`${entry.name}/`, directory));
    return entry.isFile() ? [child] : [];
  });
}

/** Split so the test file itself never contains the legacy identifier. */
const LEGACY_EXPANSION_HELPER = ["expandSgroups", "ForPreview"].join("");

/**
 * The preview strips SGroups from a copy only: `App`'s preview renderer
 * generates the image from the stripped copy, while a card click still inserts
 * the entry's original KET (`docs/conventions.md` §6.8).
 */
describe("sgroup-free preview contract", () => {
  it("strips the SGroups in the preview renderer before Ketcher draws it", () => {
    const previewBlock = sourceBetween(
      APP_SOURCE,
      "const renderTemplatePreview = useCallback(",
      "\n  const handleError",
    );

    expect(APP_SOURCE).toMatch(
      /import\s*\{[^}]*previewKetWithoutSgroups[^}]*\}\s*from\s*["']\.\/templateLibrary["']/,
    );
    expect(previewBlock).toMatch(/previewKetWithoutSgroups\(\s*ket\s*\)/);
    expect(previewBlock.indexOf("previewKetWithoutSgroups(")).toBeLessThan(
      previewBlock.indexOf("generateImage("),
    );
    expect(previewBlock).not.toMatch(/generateImage\(\s*ket\s*,/);
    expect(previewBlock).toMatch(/generateImage\(\s*\w+\s*,\s*\{\s*outputFormat:\s*["']svg["']/);
  });

  it("inserts the original entry KET without stripping it", () => {
    const insert = sourceBetween(
      APP_SOURCE,
      "const insertTemplate = useCallback(",
      "\n  const applySetting",
    );

    expect(insert).toMatch(/setMolecule\(\s*template\.ket\s*\)/);
    expect(insert).not.toMatch(/previewKetWithoutSgroups/);
  });

  it("leaves no reference to the legacy expansion helper under src", () => {
    const offenders = listSourceFiles(new URL("./", import.meta.url))
      .filter((file) => readFileSync(file, "utf8").includes(LEGACY_EXPANSION_HELPER))
      .map((file) => file.pathname);

    expect(offenders).toEqual([]);
  });
});

/**
 * The library is built after paint, so Welcome paints placeholders at once:
 * four non-clickable skeleton cards in the empty branch and an inline SVG
 * spinner in the card's preview placeholder (`docs/conventions.md` §6.8).
 */
describe("template loading placeholder contract", () => {
  it("paints non-clickable skeleton cards when the template list is empty", () => {
    const emptyBranch = sourceBetween(
      WELCOME_SECTION_SOURCE,
      "templates.length === 0 ? (",
      ") : (",
    );

    expect(emptyBranch).toMatch(/Skeleton/);
    expect(emptyBranch).toContain("TEMPLATE_CARD_COUNT");
    expect(emptyBranch).not.toMatch(/onTemplate/);
  });

  it("draws an inline SVG spinner in the preview placeholder", () => {
    const previewArea = sourceBetween(
      TEMPLATE_CARD_SOURCE,
      "function TemplatePreviewArea",
      "export interface TemplateCardProps",
    );

    expect(previewArea).toMatch(/<svg[\s>]/);
    expect(previewArea).toMatch(/animateTransform/);
  });
});

/**
 * An empty read is not cached because the providers may not be populated yet,
 * so a later backstage open retries the build (`docs/architecture.md` §5.11,
 * activity 30). The effect is keyed on the open flag and readiness, never on
 * the result, so an again-empty read cannot loop.
 */
describe("empty library retry contract", () => {
  const retryEffect = sourceBetween(
    APP_SOURCE,
    "// A later backstage open retries an empty library build.",
    "\n  const [tabSet",
  );

  it("keys the retry on backstageOpen and ready, not on the templates result", () => {
    expect(retryEffect).toMatch(/useEffect\(/);

    const dependencies = retryEffect.match(/\},\s*\[([^\]]*)\]\);/)?.[1] ?? "";
    expect(dependencies).toContain("backstageOpen");
    expect(dependencies).toContain("ready");
    expect(dependencies).not.toMatch(/\btemplates\b/);
  });

  it("reloads the library only when the current result is an empty list", () => {
    expect(retryEffect).toMatch(/if\s*\(\s*!backstageOpen\s*\|\|\s*!ready\s*\)\s*return;/);
    expect(retryEffect).toMatch(/templatesRef\.current/);
    expect(retryEffect).toMatch(
      /current\s*===\s*null\s*\|\|\s*current\.length\s*>\s*0\)\s*return;/,
    );
    expect(retryEffect).toContain("loadLibraryTemplates()");
  });

  it("skips while a shared build is in flight and keeps the loading state", () => {
    expect(retryEffect).toMatch(/libraryBuild\s*!==\s*null\)\s*return;/);
    expect(retryEffect).toMatch(/setTemplates\(null\)/);
  });
});
