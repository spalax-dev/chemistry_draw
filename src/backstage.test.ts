import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  declaredVersion,
  formatSettingValue,
  normalizeSection,
  SETTINGS_GROUPS,
  type BackstageSection,
  type BackstageSectionId,
  type SettingControl,
  type SettingDescriptor,
  type SettingsGroup,
} from "./backstage";

const SECTION_IDS: BackstageSectionId[] = ["welcome", "open", "models", "settings", "about"];

const SECTION_LABELS = ["Welcome", "Open", "Models", "Settings", "About"];

/** Real Ketcher 3.18 keys the backstage must expose (docs/architecture.md §5.11.1). */
const REQUIRED_SETTING_KEYS = [
  "atomColoring",
  "showHydrogenLabels",
  "stereoLabelStyle",
  "aromaticCircle",
  "bondLength",
  "bondThickness",
  "bondSpacing",
  "imageResolution",
  "valence-mode",
  "smart-layout",
];

/** Keys Ketcher pairs with a companion `<key>Unit` setting. */
const UNIT_BEARING_KEYS = [
  "bondLength",
  "bondThickness",
  "stereoBondWidth",
  "hashSpacing",
  "reactionComponentMarginSize",
  "fontsz",
];

/** Keys with a real value but no companion unit key in Ketcher. */
const UNITLESS_NUMBER_KEYS = ["bondSpacing", "imageResolution"];

const INVENTED_SETTING = /theme|grid|model|threshold|wasm|iupac/i;

const ALL_DESCRIPTORS: SettingDescriptor[] = SETTINGS_GROUPS.flatMap((group: SettingsGroup) =>
  group.items.flatMap((item: SettingDescriptor) => item),
);

function descriptorFor(key: string): SettingDescriptor | undefined {
  return ALL_DESCRIPTORS.find((item) => item.key === key);
}

describe("backstage section list", () => {
  it("exports the sections in rail order", () => {
    const sections: BackstageSection[] = BACKSTAGE_SECTIONS;

    expect(sections.map((section) => section.id)).toEqual(SECTION_IDS);
  });

  it("labels every section exactly", () => {
    expect(BACKSTAGE_SECTIONS.map((section) => section.label)).toEqual(SECTION_LABELS);
  });

  it("defaults to the Welcome section", () => {
    expect(DEFAULT_BACKSTAGE_SECTION).toBe("welcome");
  });

  it("keeps the default section inside the exported list", () => {
    expect(SECTION_IDS).toContain(DEFAULT_BACKSTAGE_SECTION);
  });

  it("exposes no Stitch-mock section", () => {
    expect(SECTION_IDS).not.toContain("templates");
    expect(SECTION_LABELS.join(" ")).not.toMatch(/templates?|sidecar/i);
  });
});

/**
 * `normalizeSection` is the unknown-id guard: every value outside the five
 * section ids falls back to Welcome so no id can render an empty pane
 * (`docs/architecture.md` §5.11, `docs/conventions.md` §6.8).
 */
describe("normalizeSection", () => {
  it("returns each known section id unchanged", () => {
    for (const id of SECTION_IDS) {
      expect(normalizeSection(id)).toBe(id);
    }
  });

  it("keeps models as a real section", () => {
    expect(normalizeSection("models")).toBe("models");
  });

  it("returns welcome for a removed or unknown section id", () => {
    expect(normalizeSection("save-export")).toBe("welcome");
    expect(normalizeSection("new")).toBe("welcome");
    expect(normalizeSection("templates")).toBe("welcome");
  });

  it("returns welcome for an empty id", () => {
    expect(normalizeSection("")).toBe("welcome");
  });

  it("returns welcome for an arbitrary string", () => {
    expect(normalizeSection("Settings")).toBe("welcome");
  });
});

describe("settings groups", () => {
  it("gives every group a unique non-empty id, a label and items", () => {
    const ids = SETTINGS_GROUPS.map((group) => group.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const group of SETTINGS_GROUPS) {
      expect(group.id).not.toBe("");
      expect(group.label).not.toBe("");
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("carries each real key exactly once", () => {
    for (const key of REQUIRED_SETTING_KEYS) {
      expect(ALL_DESCRIPTORS.filter((item) => item.key === key)).toHaveLength(1);
    }
  });

  it("never repeats a setting key across groups", () => {
    const keys = ALL_DESCRIPTORS.map((item) => item.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("labels every descriptor", () => {
    for (const item of ALL_DESCRIPTORS) {
      expect(item.label.trim()).not.toBe("");
      expect(item.label).not.toBe(item.key);
    }
  });

  it("uses only the supported control kinds", () => {
    const controls: SettingControl[] = ["toggle", "select", "number"];

    for (const item of ALL_DESCRIPTORS) {
      expect(controls).toContain(item.control);
    }
  });
});

describe("settings unit pairing", () => {
  it("declares the companion unit key for every unit-bearing number", () => {
    for (const key of UNIT_BEARING_KEYS) {
      const item = descriptorFor(key);

      expect(item).toBeDefined();
      expect(item?.control).toBe("number");
      expect(item?.unitKey).toBe(`${key}Unit`);
    }
  });

  it("leaves bond spacing and image resolution without a unit key", () => {
    for (const key of UNITLESS_NUMBER_KEYS) {
      expect(descriptorFor(key)?.unitKey).toBeUndefined();
    }
  });
});

describe("settings number bounds", () => {
  it("declares a min for every number control and a max only when bounded", () => {
    const numbers = ALL_DESCRIPTORS.filter((item) => item.control === "number");

    expect(numbers.length).toBeGreaterThan(0);
    for (const item of numbers) {
      expect(typeof item.min).toBe("number");
      if (item.max !== undefined) {
        expect(typeof item.max).toBe("number");
        expect(item.min as number).toBeLessThan(item.max);
      }
    }
  });

  it("keeps the documented bounds for the bond metrics", () => {
    expect(descriptorFor("bondLength")?.min).toBe(0.1);
    expect(descriptorFor("bondLength")?.max).toBe(1000);
    expect(descriptorFor("bondThickness")?.min).toBe(0.1);
    expect(descriptorFor("bondThickness")?.max).toBe(96);
  });

  it("leaves image resolution unbounded like Ketcher's schema", () => {
    const item = descriptorFor("imageResolution");

    expect(item?.control).toBe("number");
    expect(item?.min).toBe(1);
    expect(item?.max).toBeUndefined();
  });
});

describe("settings select options", () => {
  it("declares non-empty options for every select control", () => {
    const selects = ALL_DESCRIPTORS.filter((item) => item.control === "select");

    expect(selects.length).toBeGreaterThan(0);
    for (const item of selects) {
      expect(Array.isArray(item.options)).toBe(true);
      expect(item.options?.length).toBeGreaterThan(0);
      for (const option of item.options ?? []) {
        expect(option.trim()).not.toBe("");
      }
    }
  });

  it("matches Ketcher's hydrogen label and stereo label enums", () => {
    expect(descriptorFor("showHydrogenLabels")?.options).toEqual([
      "off",
      "Hetero",
      "Terminal",
      "Terminal and Hetero",
      "On",
    ]);
    expect(descriptorFor("stereoLabelStyle")?.options).toEqual([
      "IUPAC",
      "classic",
      "On-Atoms",
      "off",
    ]);
    expect(descriptorFor("valence-mode")?.options).toEqual([
      "default",
      "biovia-2009",
      "biovia-2017",
    ]);
  });
});

describe("settings realism", () => {
  it("exposes no invented setting key or label", () => {
    for (const item of ALL_DESCRIPTORS) {
      expect(item.key).not.toMatch(INVENTED_SETTING);
      expect(item.label).not.toMatch(INVENTED_SETTING);
    }
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

describe("formatSettingValue", () => {
  it("appends the unit to a number", () => {
    expect(formatSettingValue(14.4, "pt")).toBe("14.4 pt");
  });

  it("renders a toggle as On", () => {
    expect(formatSettingValue(true)).toBe("On");
  });

  it("passes a select value through unchanged", () => {
    expect(formatSettingValue("Hetero")).toBe("Hetero");
  });

  it("never invents a unit for a unitless number", () => {
    expect(formatSettingValue(0.000089)).toBe("0.000089");
  });

  it("keeps the plain number when no unit is given", () => {
    expect(formatSettingValue(40)).toBe("40");
  });
});

/**
 * `Backstage.tsx` and `backstage.ts` have no DOM test runner, so the removed
 * status strip and Save & Export section are checked against the source
 * (`docs/conventions.md` §6.8).
 */
const BACKSTAGE_UI_SOURCE = readFileSync(new URL("./ui/Backstage.tsx", import.meta.url), "utf8");

const BACKSTAGE_MODEL_SOURCE = readFileSync(new URL("./backstage.ts", import.meta.url), "utf8");

/** The `renderSection` body, from its declaration to the component's own `return (`. */
function renderSectionSource(): string {
  const start = BACKSTAGE_UI_SOURCE.indexOf("function renderSection");
  const end = BACKSTAGE_UI_SOURCE.indexOf("\n  return (", start);

  return start >= 0 && end > start ? BACKSTAGE_UI_SOURCE.slice(start, end) : "";
}

/**
 * An unknown or stale section id must render Welcome, never an empty pane
 * (`docs/architecture.md` §5.11, `docs/conventions.md` §6.8). No DOM test runner
 * exists, so the switch and its `default` branch are checked against the source.
 */
describe("backstage unknown section fallback", () => {
  it("imports normalizeSection from the backstage model", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /import\s*\{[^}]*\bnormalizeSection\b[^}]*\}\s*from\s*["']\.\.\/backstage["']/,
    );
  });

  it("normalizes the section once and drives the pane and rail from it", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(/const current = normalizeSection\(section\)/);
    expect(renderSectionSource()).toMatch(/switch\s*\(\s*current\s*\)/);
    expect(BACKSTAGE_UI_SOURCE).toMatch(/const active = entry\.id === current/);
  });

  it("renders the Welcome pane in the default branch", () => {
    expect(renderSectionSource()).toMatch(/default:\s*\{?\s*return\s*\(\s*<WelcomeSection\b/);
  });

  it("never leaves an unknown id with an empty pane", () => {
    const source = renderSectionSource();

    expect(source).not.toBe("");
    expect(source).not.toMatch(/default:\s*(?:\{\s*)?return\s+(?:null|undefined)\b/);
    expect(source).not.toMatch(/default:\s*break;/);
  });
});

describe("backstage status strip removal", () => {
  it("neither imports nor calls formatBackstageStatus", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("formatBackstageStatus");
  });

  it("no longer exports formatBackstageStatus from the model", () => {
    expect(BACKSTAGE_MODEL_SOURCE).not.toMatch(/export\s+function\s+formatBackstageStatus/);
    expect(BACKSTAGE_MODEL_SOURCE).not.toContain("Indigo ${indigoVersion}");
  });

  it("renders no status footer or status-strip style", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toMatch(/<footer[\s>]/);
    expect(BACKSTAGE_UI_SOURCE).not.toMatch(/const\s+STATUS\s*:/);
    expect(BACKSTAGE_UI_SOURCE).not.toContain("aria-live");
  });

  it("drops the status-related starting flag", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("starting");
  });
});

describe("backstage Save & Export removal", () => {
  it("neither imports nor renders SaveExportSection", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("SaveExportSection");
  });

  it("has no save-export section branch or rail entry", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("save-export");
    expect(BACKSTAGE_MODEL_SOURCE).not.toContain("save-export");
  });

  it("keeps the Save & Export label out of the backstage model", () => {
    expect(BACKSTAGE_MODEL_SOURCE).not.toContain("Save & Export");
  });
});

/**
 * The Models section is a reserved, empty placeholder (`docs/conventions.md`
 * §6.8): a heading plus a muted note, no list, no actions. There is no DOM test
 * runner, so the pane and its wiring are checked against the source.
 */
const MODELS_SECTION_URL = new URL("./ui/backstage/ModelsSection.tsx", import.meta.url);

function modelsSectionSource(): string {
  return existsSync(MODELS_SECTION_URL) ? readFileSync(MODELS_SECTION_URL, "utf8") : "";
}

describe("backstage Models section", () => {
  it("ships a dedicated ModelsSection module", () => {
    expect(existsSync(MODELS_SECTION_URL)).toBe(true);
  });

  it("exports a ModelsSection component", () => {
    expect(modelsSectionSource()).toMatch(
      /export\s+(?:default\s+)?(?:function|const)\s+ModelsSection\b/,
    );
  });

  it("renders the Models heading", () => {
    expect(modelsSectionSource()).toMatch(/<h[1-6][^>]*>\s*Models\s*<\/h[1-6]>/i);
  });

  it("stays an empty state, with no control or handler", () => {
    const source = modelsSectionSource();

    expect(source).not.toBe("");
    for (const forbidden of ["<button", "<a ", "<input", "<select", "onClick"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("is imported and rendered for the models id by the backstage", () => {
    expect(BACKSTAGE_UI_SOURCE).toMatch(
      /import\s+\{\s*ModelsSection\s*\}\s+from\s+["']\.\/backstage\/ModelsSection["']/,
    );
    expect(BACKSTAGE_UI_SOURCE).toMatch(/case\s+"models":[\s\S]{0,200}?<ModelsSection\s*\/>/);
  });
});
