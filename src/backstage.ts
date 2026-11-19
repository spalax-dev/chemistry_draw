/**
 * Pure backstage model: the ordered rail sections and the default section
 * (`docs/architecture.md` §5.11).
 *
 * The settings descriptors live in `src/settingsModel.ts` because they are a
 * separate concern with their own formatting rules; this module re-exports them
 * so `Backstage.tsx`, task code and the tests have one public import.
 */

export type BackstageSectionId = "welcome" | "open" | "models" | "settings" | "about";

export interface BackstageSection {
  id: BackstageSectionId;
  label: string;
}

/** Rail order; the only sections the backstage has. */
export const BACKSTAGE_SECTIONS: BackstageSection[] = [
  { id: "welcome", label: "Welcome" },
  { id: "open", label: "Open" },
  { id: "models", label: "Models" },
  { id: "settings", label: "Settings" },
  { id: "about", label: "About" },
];

/** The section shown when the backstage opens. */
export const DEFAULT_BACKSTAGE_SECTION: BackstageSectionId = "welcome";

/** The known section ids, so an unknown or stale id never reaches the switch. */
const KNOWN_SECTION_IDS = new Set<string>(BACKSTAGE_SECTIONS.map((section) => section.id));

/**
 * The unknown-id guard: a known section id passes through unchanged, every
 * other value (a removed section, a stale HMR value, an empty string) becomes
 * Welcome so no id can render an empty pane (`docs/architecture.md` §5.11,
 * `docs/conventions.md` §6.8).
 */
export function normalizeSection(id: string): BackstageSectionId {
  return KNOWN_SECTION_IDS.has(id) ? (id as BackstageSectionId) : DEFAULT_BACKSTAGE_SECTION;
}

/**
 * The version a `package.json` range declares: `^3.18.0` and `~1.2` become
 * `3.18.0` and `1.2`. The About section shows the declared dependency, not a
 * resolved install, so the value is the same in the desktop bundle and the
 * browser build.
 */
export function declaredVersion(range: string): string {
  const match = /\d+(?:\.\d+)*/.exec(range);
  return match ? match[0] : range.trim();
}

export { formatSettingValue, SETTINGS_GROUPS } from "./settingsModel";
export type { SettingControl, SettingDescriptor, SettingsGroup } from "./settingsModel";
