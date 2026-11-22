import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildLibraryTemplates,
  previewKetWithoutSgroups,
  sampleTemplates,
  TEMPLATE_CARD_COUNT,
  type TemplateSource,
} from "./templateLibrary";

/**
 * The Welcome template cards (`docs/architecture.md` §5.1,
 * `docs/planning/contracts.md` §5): four cards sampled from Ketcher's real
 * Structure Library, never from a curated pool, with the SGroup-free preview
 * copy and the entry's own KET for insertion.
 */

const LIBRARY_SOURCES: TemplateSource[] = [
  { name: "Acetic Acid", group: "functional-group", ket: "KET-acetic-acid" },
  { name: "Boc", group: "functional-group", ket: "KET-boc" },
  { name: "N,N-Diisopropylethylamine", group: "salt-solvent", ket: "KET-diea" },
];

describe("buildLibraryTemplates", () => {
  it("maps every source to its id, trimmed name, group and KET in provider order", () => {
    expect(buildLibraryTemplates(LIBRARY_SOURCES)).toEqual([
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

  it("trims a padded name before using it", () => {
    const [template] = buildLibraryTemplates([
      { name: "  Acetic Acid  ", group: "functional-group", ket: "KET-acetic-acid" },
    ]);

    expect(template?.name).toBe("Acetic Acid");
    expect(template?.id).toBe("acetic-acid");
  });

  it("dedupes case-insensitively and keeps the first occurrence", () => {
    expect(
      buildLibraryTemplates([
        { name: "Benzene", group: "functional-group", ket: "KET-first" },
        { name: " benzene ", group: "salt-solvent", ket: "KET-second" },
        { name: "BENZENE", group: "salt-solvent", ket: "KET-third" },
      ]),
    ).toEqual([{ id: "benzene", name: "Benzene", group: "functional-group", ket: "KET-first" }]);
  });

  it("skips entries with an empty name or an empty KET", () => {
    expect(
      buildLibraryTemplates([
        { name: "", group: "functional-group", ket: "KET-empty-name" },
        { name: "   ", group: "functional-group", ket: "KET-blank-name" },
        { name: "Kept", group: "functional-group", ket: "KET-kept" },
        { name: "No ket", group: "salt-solvent", ket: "" },
        { name: "Blank ket", group: "salt-solvent", ket: "   " },
      ]),
    ).toEqual([{ id: "kept", name: "Kept", group: "functional-group", ket: "KET-kept" }]);
  });

  it("gives slug collisions distinct ids in provider order", () => {
    const templates = buildLibraryTemplates([
      { name: "C++", group: "functional-group", ket: "KET-cpp" },
      { name: "C", group: "functional-group", ket: "KET-c" },
      { name: "c ", group: "functional-group", ket: "KET-c-lower" },
    ]);

    expect(templates.map((template) => template.id)).toEqual(["c", "c-2"]);
    expect(templates.map((template) => template.ket)).toEqual(["KET-cpp", "KET-c"]);
  });

  it("returns an empty list for an empty source list", () => {
    expect(buildLibraryTemplates([])).toEqual([]);
  });
});

interface SgroupEntry {
  abbreviation?: string;
  [field: string]: unknown;
}

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

describe("previewKetWithoutSgroups", () => {
  it("empties the sgroups and keeps the atoms, bonds and header", () => {
    const result = JSON.parse(previewKetWithoutSgroups(SGROUP_KET)) as KetDocument;
    const source = JSON.parse(SGROUP_KET) as KetDocument;

    expect(result.mol0?.sgroups).toEqual([]);
    expect(result.mol0?.atoms).toEqual(source.mol0?.atoms);
    expect(result.mol0?.bonds).toEqual(source.mol0?.bonds);
    expect(result.header).toEqual(source.header);
    expect(result.root).toEqual(source.root);
  });

  it("empties sgroups nested in every molecule object and array", () => {
    const result = JSON.parse(previewKetWithoutSgroups(NESTED_SGROUP_KET)) as KetDocument;

    expect(result.mol0?.sgroups).toEqual([]);
    expect(result.mol0?.fragments?.[0]?.sgroups).toEqual([]);
    expect(result.mol0?.nested?.deeper?.sgroups).toEqual([]);
    expect(result.mol1?.sgroups).toEqual([]);
  });

  it("returns an equivalent document when there is no sgroup", () => {
    expect(JSON.parse(previewKetWithoutSgroups(PLAIN_KET))).toEqual(JSON.parse(PLAIN_KET));
  });

  it("returns malformed JSON unchanged", () => {
    expect(previewKetWithoutSgroups("not json")).toBe("not json");
  });

  it("is deterministic and leaves the source constant intact", () => {
    expect(previewKetWithoutSgroups(SGROUP_KET)).toBe(previewKetWithoutSgroups(SGROUP_KET));

    const original = JSON.parse(SGROUP_KET) as KetDocument;
    expect(original.mol0?.sgroups?.map((sgroup) => sgroup.abbreviation)).toEqual(["Et", "Boc"]);
  });
});

describe("TEMPLATE_CARD_COUNT", () => {
  it("shows exactly four cards", () => {
    expect(TEMPLATE_CARD_COUNT).toBe(4);
  });
});

describe("sampleTemplates", () => {
  const pool = Array.from({ length: 7 }, (_, index) => ({ id: `template-${index}` }));

  it("returns the requested number of distinct entries", () => {
    const picked = sampleTemplates(pool, 4, () => 0.42);

    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((entry) => entry.id)).size).toBe(4);
  });

  it("never duplicates an entry when the injected RNG is constant", () => {
    for (const value of [0, 0.5, 0.999999]) {
      const picked = sampleTemplates(pool, 4, () => value);

      expect(new Set(picked.map((entry) => entry.id)).size).toBe(picked.length);
    }
  });

  it("keeps the picked entries in pool order", () => {
    const picked = sampleTemplates(pool, 4, seededRandom(7));
    const poolIndex = new Map(pool.map((entry, index) => [entry.id, index]));
    const indexes = picked.map((entry) => poolIndex.get(entry.id) ?? -1);

    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it("clamps a count at or above the pool size to the whole pool", () => {
    expect(sampleTemplates(pool, 7, seededRandom(1))).toHaveLength(7);
    expect(sampleTemplates(pool, 20, seededRandom(1))).toHaveLength(pool.length);
  });

  it("returns an empty list for a zero or negative count", () => {
    expect(sampleTemplates(pool, 0, seededRandom(1))).toEqual([]);
    expect(sampleTemplates(pool, -3, seededRandom(1))).toEqual([]);
  });

  it("is reproducible for the same injected RNG sequence", () => {
    const first = sampleTemplates(pool, 4, seededRandom(2024));
    const second = sampleTemplates(pool, 4, seededRandom(2024));

    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
  });
});

/** A small deterministic PRNG so sampling never depends on `Math.random`. */
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

/**
 * Welcome renders the sampled cards and the documented actions
 * (`docs/architecture.md` §5.1). There is no DOM renderer, so the pane wiring
 * is read from the source.
 */
const WELCOME_SECTION_SOURCE = readFileSync(
  new URL("./ui/backstage/WelcomeSection.tsx", import.meta.url),
  "utf8",
);

describe("Welcome template wiring", () => {
  it("samples the fixed four-card count from the injected library", () => {
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*\bsampleTemplates\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/templateLibrary["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(
      /import\s*\{[^}]*\bTEMPLATE_CARD_COUNT\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/templateLibrary["']/,
    );
    expect(WELCOME_SECTION_SOURCE).toMatch(/templates\??:/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/sampleTemplates\(\s*templates,\s*TEMPLATE_CARD_COUNT/);
    expect(WELCOME_SECTION_SOURCE).toMatch(/visibleTemplates\.map\(/);
  });

  it("renders an empty state instead of cards when the library is empty", () => {
    expect(WELCOME_SECTION_SOURCE).toContain("templates.length === 0");
    expect(WELCOME_SECTION_SOURCE).toContain("No templates available");
  });

  it("renders the Welcome actions and the library exit", () => {
    expect(WELCOME_SECTION_SOURCE).toContain("Blank canvas");
    expect(WELCOME_SECTION_SOURCE).toContain("Import structure");
    expect(WELCOME_SECTION_SOURCE).toContain("Open project");
    expect(WELCOME_SECTION_SOURCE).toContain("More templates");
    expect(WELCOME_SECTION_SOURCE).toContain("Back to editor");
  });
});
