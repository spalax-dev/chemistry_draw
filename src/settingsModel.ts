/**
 * Curated Ketcher settings descriptors for the backstage Settings section
 * (`docs/architecture.md` §5.11.1, `docs/conventions.md` §6.8).
 *
 * Pure data and formatting only: no React, no DOM, no Ketcher import. The
 * section binds these descriptors to `ketcher.settingsService`; this module
 * never holds a settings object of its own.
 *
 * `src/backstage.ts` re-exports the settings surface so the public backstage
 * model stays a single import for callers and tests.
 */

/** The control kinds the Settings section can render. */
export type SettingControl = "toggle" | "select" | "number";

export interface SettingDescriptor {
  /** Real Ketcher 3.18 key, sent as-is in a single-key `updateSettings` patch. */
  key: string;
  /** Sentence-case visible label. */
  label: string;
  control: SettingControl;
  /** Companion `<key>Unit` setting for a number that carries a unit. */
  unitKey?: string;
  /** Selectable units when `unitKey` is present. */
  unitOptions?: readonly string[];
  /** Inclusive lower bound for a number control. */
  min?: number;
  /**
   * Inclusive upper bound for a number control, only when Ketcher's schema
   * defines one; an unbounded setting omits it.
   */
  max?: number;
  /** Allowed values for a select control. */
  options?: readonly string[];
}

export interface SettingsGroup {
  /** Unique, non-empty group id. */
  id: string;
  label: string;
  items: SettingDescriptor[];
}

/** Every Ketcher unit setting accepts these four units. */
const LENGTH_UNITS = ["px", "pt", "cm", "inch"] as const;

/** A unit-bearing number control: the key, its unit key and the documented bounds. */
function length(key: string, label: string, min: number, max: number): SettingDescriptor {
  return {
    key,
    label,
    control: "number",
    unitKey: `${key}Unit`,
    unitOptions: LENGTH_UNITS,
    min,
    max,
  };
}

/**
 * The curated descriptors, grouped for display. Keys and options are exactly
 * Ketcher's schema; numeric bounds match the schema where it defines one
 * (`docs/architecture.md` §5.11.1) and are otherwise documented UI bounds.
 * Nothing Ketcher does not expose appears here.
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: "atoms-labels",
    label: "Atoms and labels",
    items: [
      { key: "atomColoring", label: "Atom coloring", control: "toggle" },
      { key: "carbonExplicitly", label: "Show carbon explicitly", control: "toggle" },
      {
        key: "showHydrogenLabels",
        label: "Hydrogen labels",
        control: "select",
        options: ["off", "Hetero", "Terminal", "Terminal and Hetero", "On"],
      },
      { key: "showCharge", label: "Show charges", control: "toggle" },
      { key: "showValence", label: "Show valence", control: "toggle" },
      length("fontsz", "Atom label size", 0.1, 96),
    ],
  },
  {
    id: "bonds",
    label: "Bonds",
    items: [
      { key: "aromaticCircle", label: "Aromatic circle", control: "toggle" },
      length("bondLength", "Bond length", 0.1, 1000),
      length("bondThickness", "Bond thickness", 0.1, 96),
      // Ketcher has no `bondSpacingUnit`: the value is a plain integer.
      { key: "bondSpacing", label: "Bond spacing", control: "number", min: 1, max: 100 },
      length("stereoBondWidth", "Stereo bond width", 0.1, 96),
      length("hashSpacing", "Hash spacing", 0.1, 1000),
    ],
  },
  {
    id: "stereo-layout",
    label: "Stereochemistry and layout",
    items: [
      { key: "showStereoFlags", label: "Stereo flags", control: "toggle" },
      {
        key: "stereoLabelStyle",
        label: "Stereo label style",
        control: "select",
        options: ["IUPAC", "classic", "On-Atoms", "off"],
      },
      {
        key: "valence-mode",
        label: "Valence mode",
        control: "select",
        options: ["default", "biovia-2009", "biovia-2017"],
      },
      { key: "smart-layout", label: "Smart layout", control: "toggle" },
      {
        key: "ignore-stereochemistry-errors",
        label: "Ignore stereochemistry errors",
        control: "toggle",
      },
      { key: "dearomatize-on-load", label: "Dearomatize on load", control: "toggle" },
      { key: "rotationStep", label: "Rotation step", control: "number", min: 1, max: 90 },
      length("reactionComponentMarginSize", "Reaction component margin", 0.1, 1000),
    ],
  },
  {
    id: "export",
    label: "Export",
    items: [
      // Ketcher's schema leaves this unbounded: keep a sensible floor of 1 and
      // no maximum, so the default (72) and the ACS preset (600) always fit.
      { key: "imageResolution", label: "Image resolution", control: "number", min: 1 },
    ],
  },
];

/**
 * The visible value of a setting: a toggle reads `On`/`Off`, a select passes
 * through, and a number appends its unit only when one is supplied.
 */
export function formatSettingValue(value: boolean | number | string, unit?: string): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value;
  return unit === undefined || unit === "" ? String(value) : `${value} ${unit}`;
}
