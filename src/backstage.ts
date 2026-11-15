/**
 * Pure backstage model: the ordered rail sections, the default section and the
 * status-strip formatting (`docs/architecture.md` §5.11).
 *
 * The settings descriptors live in `src/settingsModel.ts` because they are a
 * separate concern with their own formatting rules; this module re-exports them
 * so `Backstage.tsx`, task code and the tests have one public import.
 */

export type BackstageSectionId = "new" | "recent" | "save-export" | "settings" | "about";

export interface BackstageSection {
  id: BackstageSectionId;
  label: string;
}

/** Rail order; the only sections the backstage has. */
export const BACKSTAGE_SECTIONS: BackstageSection[] = [
  { id: "new", label: "New" },
  { id: "recent", label: "Recent" },
  { id: "save-export", label: "Save & Export" },
  { id: "settings", label: "Settings" },
  { id: "about", label: "About" },
];

/** The section shown when the backstage opens. */
export const DEFAULT_BACKSTAGE_SECTION: BackstageSectionId = "new";

/**
 * The status strip's real sidecar line. Both values come from `GET /v2/info`;
 * until it answers the strip says `Connecting…` instead of inventing a version.
 */
export function formatBackstageStatus(
  indigoVersion: string | null,
  sidecarPort: number | null,
): string {
  if (indigoVersion === null || indigoVersion === "" || sidecarPort === null) {
    return "Connecting…";
  }
  return `Indigo ${indigoVersion} · sidecar :${sidecarPort}`;
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
