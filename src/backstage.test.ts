import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  declaredVersion,
  normalizeSection,
  type BackstageSection,
  type BackstageSectionId,
} from "./backstage";
import { EDITOR_BUTTONS } from "./ui/editorButtons";

const SECTION_IDS: BackstageSectionId[] = ["welcome", "open", "models", "about"];

const SECTION_LABELS = ["Welcome", "Open", "Models", "About"];

/** The rail must expose exactly these four sections, in this order. */
describe("backstage section list", () => {
  it("exports the four sections in rail order", () => {
    const sections: BackstageSection[] = BACKSTAGE_SECTIONS;

    expect(sections.map((section) => section.id)).toEqual(SECTION_IDS);
    expect(sections).toHaveLength(4);
  });

  it("labels every section exactly", () => {
    expect(BACKSTAGE_SECTIONS.map((section) => section.label)).toEqual(SECTION_LABELS);
  });

  it("has no settings section any more", () => {
    expect(BACKSTAGE_SECTIONS.map((section) => section.id)).not.toContain("settings");
    expect(BACKSTAGE_SECTIONS.map((section) => section.label)).not.toContain("Settings");
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
 * `normalizeSection` is the unknown-id guard: every value outside the four
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

  it("returns welcome for the removed settings section", () => {
    expect(normalizeSection("settings")).toBe("welcome");
  });

  it("returns welcome for another removed or unknown section id", () => {
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

/**
 * `settings` leaves the union with the Settings section. Vitest does not
 * typecheck, so the source is asserted too; `tsc --noEmit` enforces the
 * `@ts-expect-error` below.
 */
// @ts-expect-error settings is no longer a backstage section id
const STALE_SECTION: BackstageSectionId = "settings";

const BACKSTAGE_MODEL_SOURCE = readFileSync(new URL("./backstage.ts", import.meta.url), "utf8");

describe("BackstageSectionId drops settings", () => {
  it("declares no settings member in the section id union", () => {
    const union = /export\s+type\s+BackstageSectionId\s*=[^;]*;/.exec(BACKSTAGE_MODEL_SOURCE)?.[0];

    expect(union).toBeDefined();
    expect(union).not.toContain("settings");
  });

  it("still falls a stale settings id back to welcome", () => {
    void STALE_SECTION;

    expect(normalizeSection(STALE_SECTION)).toBe("welcome");
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

/** `src/`, its non-test modules and the two paths the Settings section occupied. */
const SRC_ROOT = fileURLToPath(new URL("./", import.meta.url));

const SETTINGS_SECTION_URL = new URL("./ui/backstage/SettingsSection.tsx", import.meta.url);

const SETTINGS_MODEL_URL = new URL("./settingsModel.ts", import.meta.url);

/** Every non-test `.ts`/`.tsx` module under `src/`. */
function sourceFiles(): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  }

  walk(SRC_ROOT);
  return files;
}

/** The `src/`-relative names of every module that names one of the settings modules. */
function modulesReferencing(name: string): string[] {
  return sourceFiles()
    .filter((file) => readFileSync(file, "utf8").includes(name))
    .map((file) => relative(SRC_ROOT, file));
}

describe("settings module removal", () => {
  it("ships no SettingsSection module", () => {
    expect(existsSync(SETTINGS_SECTION_URL)).toBe(false);
  });

  it("ships no settings model module", () => {
    expect(existsSync(SETTINGS_MODEL_URL)).toBe(false);
  });

  it("no longer re-exports the settings descriptors from the backstage model", () => {
    expect(BACKSTAGE_MODEL_SOURCE).not.toMatch(/SETTINGS_GROUPS|formatSettingValue/);
  });

  it("has no source module importing SettingsSection", () => {
    expect(modulesReferencing("SettingsSection")).toEqual([]);
  });

  it("has no source module importing settingsModel", () => {
    expect(modulesReferencing("settingsModel")).toEqual([]);
  });
});

/**
 * `App.tsx` no longer feeds Ketcher's live settings into the backstage; the
 * toolbar's own settings dialog stays the only settings surface
 * (`docs/architecture.md` §5.11).
 */
const APP_SOURCE = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("App settings wiring removal", () => {
  it.each([
    "settingsService",
    "ketcherSettings",
    "handleChangeSetting",
    "loadPreset(",
    "resetToDefaults(",
  ])("contains no %s", (token) => {
    expect(APP_SOURCE).not.toContain(token);
  });
});

/**
 * `Backstage.tsx` has no DOM test runner, so the brand line, the rail exit
 * label and the removed Settings pane are checked against the source
 * (`docs/conventions.md` §6.8).
 */
const BACKSTAGE_UI_SOURCE = readFileSync(new URL("./ui/Backstage.tsx", import.meta.url), "utf8");

/** The `<header>` element that carries the brand, opening tag to closing tag. */
function headerSource(): string {
  const start = BACKSTAGE_UI_SOURCE.indexOf("<header");
  const end = BACKSTAGE_UI_SOURCE.indexOf("</header>", start);

  return start >= 0 && end > start
    ? BACKSTAGE_UI_SOURCE.slice(start, end + "</header>".length)
    : "";
}

/** The rail footer, where the single top-level exit control lives. */
function railFooterSource(): string {
  const start = BACKSTAGE_UI_SOURCE.indexOf("<div style={RAIL_FOOTER}>");
  const end = BACKSTAGE_UI_SOURCE.indexOf("</div>", start);

  return start >= 0 && end > start ? BACKSTAGE_UI_SOURCE.slice(start, end) : "";
}

describe("backstage brand line", () => {
  it("renders the Chemistry Draw title", () => {
    expect(headerSource()).toContain("Chemistry Draw");
  });

  it("keeps no separate Backstage muted span", () => {
    expect(headerSource()).not.toMatch(/>Backstage</);
  });

  it("keeps no pipe separator next to the title", () => {
    expect(headerSource()).not.toMatch(/>\s*\|\s*</);
  });
});

describe("backstage exit control", () => {
  it("labels the rail close button Back to editor", () => {
    expect(railFooterSource()).toContain("Back to editor");
  });

  it("keeps the old Exit Backstage label out of the source", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("Exit Backstage");
  });
});

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

describe("backstage Settings pane removal", () => {
  it("renders no SettingsSection", () => {
    expect(BACKSTAGE_UI_SOURCE).not.toContain("SettingsSection");
  });

  it("has no settings branch in the section switch", () => {
    expect(renderSectionSource()).not.toMatch(/case\s+"settings"/);
    expect(BACKSTAGE_UI_SOURCE).not.toContain("ketcherSettings");
  });
});

/**
 * Ketcher's own settings button stays visible: the toolbar dialog is still the
 * settings surface (`docs/conventions.md` §6.5). Only Recognize and Save are
 * hidden.
 */
type ButtonEntry = { hidden?: boolean };

const EDITOR_BUTTONS_CONFIG = EDITOR_BUTTONS as unknown as Record<string, ButtonEntry | undefined>;

const EDITOR_BUTTONS_SOURCE = readFileSync(
  new URL("./ui/editorButtons.ts", import.meta.url),
  "utf8",
);

describe("Ketcher settings button stays reachable", () => {
  it("hides only recognize and save", () => {
    expect(Object.keys(EDITOR_BUTTONS).sort()).toEqual(["recognize", "save"]);
  });

  it("declares no settings entry", () => {
    expect(EDITOR_BUTTONS_CONFIG.settings).toBeUndefined();
    expect(EDITOR_BUTTONS_SOURCE).not.toMatch(/\bsettings\s*:/);
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
