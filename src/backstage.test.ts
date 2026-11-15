import { describe, expect, it } from "vitest";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  declaredVersion,
  formatBackstageStatus,
  formatSettingValue,
  SETTINGS_GROUPS,
  type BackstageSection,
  type BackstageSectionId,
  type SettingControl,
  type SettingDescriptor,
  type SettingsGroup,
} from "./backstage";

const SECTION_IDS: BackstageSectionId[] = ["new", "recent", "save-export", "settings", "about"];

const SECTION_LABELS = ["New", "Recent", "Save & Export", "Settings", "About"];

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

  it("defaults to the New section", () => {
    expect(DEFAULT_BACKSTAGE_SECTION).toBe("new");
  });

  it("keeps the default section inside the exported list", () => {
    expect(SECTION_IDS).toContain(DEFAULT_BACKSTAGE_SECTION);
  });

  it("exposes no Stitch-mock section", () => {
    expect(SECTION_IDS).not.toContain("templates");
    expect(SECTION_LABELS.join(" ")).not.toMatch(/templates?|sidecar|models?/i);
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

describe("formatBackstageStatus", () => {
  it("reports Connecting while the sidecar has not answered", () => {
    expect(formatBackstageStatus(null, null)).toBe("Connecting…");
    expect(formatBackstageStatus("", 9321)).toBe("Connecting…");
    expect(formatBackstageStatus("1.31.0", null)).toBe("Connecting…");
  });

  it("renders the real Indigo version and bound port", () => {
    expect(formatBackstageStatus("1.31.0", 9321)).toBe("Indigo 1.31.0 · sidecar :9321");
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
