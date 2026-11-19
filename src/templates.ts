/**
 * Legacy curated ring descriptors, retained for reference only.
 *
 * The Welcome cards come from Ketcher's Structure Library
 * (`src/templateLibrary.ts`) and are rendered by Ketcher, not from this module.
 * These descriptors are kept because the sampling helpers below are still
 * exported from here; nothing in the backstage maps them into cards any more.
 */

export type TemplateId =
  | "benzene"
  | "cyclopentadiene"
  | "cyclohexane"
  | "cyclopentane"
  | "cyclopropane"
  | "cyclobutane"
  | "cycloheptane"
  | "cyclooctane"
  | "pyridine"
  | "pyrimidine"
  | "furan"
  | "thiophene"
  | "imidazole"
  | "pyrrole"
  | "piperidine"
  | "morpholine";

/** One heteroatom drawn at a 0-based ring vertex, clockwise from the top. */
export interface TemplateLabel {
  vertex: number;
  atom: "N" | "O" | "S";
}

/** The inline-SVG ring preview recipe for one card. */
export interface TemplatePreview {
  kind: "ring";
  /** Number of vertices of the regular polygon. */
  sides: number;
  /** Draw the aromatic inner circle. */
  aromatic?: boolean;
  /** Number of simple double-bond hints to draw inside the ring. */
  doubleBonds?: number;
  /** Heteroatoms shown at their ring vertices; carbocycles omit it. */
  labels?: TemplateLabel[];
}

export interface TemplateDescriptor {
  id: TemplateId;
  /** Card title, also the tab's first display name. */
  name: string;
  /** One non-empty sentence, shown on a single truncated line. */
  description: string;
  /** Small uppercase chip in the card footer. */
  tag: string;
  /** SMILES loaded verbatim through `setMolecule`. */
  structure: string;
  /** Inline-SVG preview recipe; no raster asset is involved. */
  preview: TemplatePreview;
}

/** Grid order, left to right and top to bottom. */
export const TEMPLATES: TemplateDescriptor[] = [
  {
    id: "benzene",
    name: "Benzene Ring",
    description: "Aromatic six-membered ring.",
    tag: "Aromatic",
    structure: "c1ccccc1",
    preview: { kind: "ring", sides: 6, aromatic: true },
  },
  {
    id: "cyclopentadiene",
    name: "Cyclopentadiene",
    description: "Unsaturated five-membered ring with two conjugated double bonds.",
    tag: "Diene",
    // RDKit canonical SMILES for the C5H6 ring: C1=CCC=C1.
    structure: "C1=CCC=C1",
    preview: { kind: "ring", sides: 5, doubleBonds: 2 },
  },
  {
    id: "cyclohexane",
    name: "Cyclohexane",
    description: "Saturated six-membered ring.",
    tag: "Aliphatic",
    structure: "C1CCCCC1",
    preview: { kind: "ring", sides: 6 },
  },
  {
    id: "cyclopentane",
    name: "Cyclopentane",
    description: "Saturated five-membered ring.",
    tag: "Aliphatic",
    structure: "C1CCCC1",
    preview: { kind: "ring", sides: 5 },
  },
  {
    id: "cyclopropane",
    name: "Cyclopropane",
    description: "Saturated three-membered ring.",
    tag: "Aliphatic",
    structure: "C1CC1",
    preview: { kind: "ring", sides: 3 },
  },
  {
    id: "cyclobutane",
    name: "Cyclobutane",
    description: "Saturated four-membered ring.",
    tag: "Aliphatic",
    structure: "C1CCC1",
    preview: { kind: "ring", sides: 4 },
  },
  {
    id: "cycloheptane",
    name: "Cycloheptane",
    description: "Saturated seven-membered ring.",
    tag: "Aliphatic",
    structure: "C1CCCCCC1",
    preview: { kind: "ring", sides: 7 },
  },
  {
    id: "cyclooctane",
    name: "Cyclooctane",
    description: "Saturated eight-membered ring.",
    tag: "Aliphatic",
    structure: "C1CCCCCCC1",
    preview: { kind: "ring", sides: 8 },
  },
  {
    id: "pyridine",
    name: "Pyridine",
    description: "Aromatic six-membered ring with one nitrogen.",
    tag: "Heteroaromatic",
    structure: "c1ccncc1",
    preview: { kind: "ring", sides: 6, aromatic: true, labels: [{ vertex: 0, atom: "N" }] },
  },
  {
    id: "pyrimidine",
    name: "Pyrimidine",
    description: "Aromatic six-membered ring with two nitrogens.",
    tag: "Heteroaromatic",
    structure: "c1cncnc1",
    preview: {
      kind: "ring",
      sides: 6,
      aromatic: true,
      labels: [
        { vertex: 0, atom: "N" },
        { vertex: 2, atom: "N" },
      ],
    },
  },
  {
    id: "furan",
    name: "Furan",
    description: "Aromatic five-membered ring with one oxygen.",
    tag: "Heteroaromatic",
    structure: "c1ccoc1",
    preview: { kind: "ring", sides: 5, aromatic: true, labels: [{ vertex: 0, atom: "O" }] },
  },
  {
    id: "thiophene",
    name: "Thiophene",
    description: "Aromatic five-membered ring with one sulfur.",
    tag: "Heteroaromatic",
    structure: "c1ccsc1",
    preview: { kind: "ring", sides: 5, aromatic: true, labels: [{ vertex: 0, atom: "S" }] },
  },
  {
    id: "imidazole",
    name: "Imidazole",
    description: "Aromatic five-membered ring with two nitrogens.",
    tag: "Heteroaromatic",
    structure: "c1c[nH]cn1",
    preview: {
      kind: "ring",
      sides: 5,
      aromatic: true,
      labels: [
        { vertex: 0, atom: "N" },
        { vertex: 2, atom: "N" },
      ],
    },
  },
  {
    id: "pyrrole",
    name: "Pyrrole",
    description: "Aromatic five-membered ring with one nitrogen.",
    tag: "Heteroaromatic",
    structure: "c1cc[nH]c1",
    preview: { kind: "ring", sides: 5, aromatic: true, labels: [{ vertex: 0, atom: "N" }] },
  },
  {
    id: "piperidine",
    name: "Piperidine",
    description: "Saturated six-membered ring with one nitrogen.",
    tag: "Heterocycle",
    structure: "C1CCNCC1",
    preview: { kind: "ring", sides: 6, labels: [{ vertex: 0, atom: "N" }] },
  },
  {
    id: "morpholine",
    name: "Morpholine",
    description: "Saturated six-membered ring with oxygen and nitrogen.",
    tag: "Heterocycle",
    structure: "C1COCCN1",
    preview: {
      kind: "ring",
      sides: 6,
      labels: [
        { vertex: 0, atom: "O" },
        { vertex: 3, atom: "N" },
      ],
    },
  },
];

// The grid helpers moved to `src/templateLibrary.ts` for activity 24 (the
// Welcome cards no longer import this curated pool). They are re-exported here
// so the established `src/templates.ts` API and its Vitest contract stay intact.
export { sampleTemplates as pickTemplates } from "./templateLibrary";
