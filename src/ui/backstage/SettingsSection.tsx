/**
 * Backstage → Settings: the curated Ketcher settings bound to the mounted
 * editor's `settingsService` (`docs/architecture.md` §5.11.1).
 *
 * Presentational only. The values come from the `settings` prop, which `App`
 * seeds from `getSettings()` and refreshes from `subscribe`; every change is
 * forwarded to `App`, which sends the partial to `updateSettings`. This
 * component never keeps a settings object of its own.
 */

import type { CSSProperties } from "react";
import type { Settings } from "ketcher-core";

import { SETTINGS_GROUPS, formatSettingValue, type SettingDescriptor } from "../../settingsModel";
import { Button } from "../Button";
import { tokens } from "../tokens";
import { CARD, ROW, ROW_DIVIDER, SECTION_LEAD, SECTION_TITLE } from "./sectionStyles";

export type SettingValue = boolean | number | string;

export interface SettingsSectionProps {
  /** `null` until `ketcher.settingsService` exists (before `onInit`). */
  settings: Settings | null;
  onChangeSetting: (key: string, value: SettingValue) => void;
  /**
   * A unit-bearing number: a numeric value patches `key`, a unit name patches
   * `unitKey`. Ketcher keeps the number as typed and does not convert it.
   */
  onChangeSettingUnit: (key: string, unitKey: string, value: number | string) => void;
  /** Loads Ketcher's own `acs` preset through `loadPreset`. */
  onPresetSetting: () => void;
  /** Restores Ketcher's own defaults through `resetToDefaults`. */
  onResetSettings: () => void;
}

const GROUP_HEADING: CSSProperties = {
  margin: "20px 0 8px",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  lineHeight: 1.4,
  textTransform: "uppercase",
  color: tokens.color.muted,
};

const SETTING_ROW: CSSProperties = {
  ...ROW,
  gap: 16,
};

const SETTING_LABEL: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const CONTROLS: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: "0 0 auto",
};

const CONTROL: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 28,
  padding: "4px 6px",
  border: `${tokens.borderWidth} solid ${tokens.color.border}`,
  borderRadius: tokens.radius,
  background: tokens.color.surface,
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  color: tokens.color.text,
  outlineColor: tokens.color.accent,
  outlineOffset: 1,
};

const NUMBER_INPUT: CSSProperties = {
  ...CONTROL,
  width: 88,
  textAlign: "right",
};

const UNIT_SELECT: CSSProperties = {
  ...CONTROL,
  minWidth: 64,
};

const VALUE_SUMMARY: CSSProperties = {
  minWidth: 72,
  fontSize: tokens.fontSize.body,
  color: tokens.color.muted,
  whiteSpace: "nowrap",
};

const CHECKBOX: CSSProperties = {
  width: 16,
  height: 16,
  margin: 0,
  accentColor: tokens.color.accent,
  cursor: "pointer",
};

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 20,
};

const STORAGE_NOTE: CSSProperties = {
  margin: "12px 0 0",
  fontSize: tokens.fontSize.body,
  lineHeight: 1.5,
  color: tokens.color.muted,
};

/** Reads a live Ketcher value without assuming its concrete type. */
function readSetting(settings: Settings, key: string): SettingValue | undefined {
  const value = (settings as unknown as Record<string, unknown>)[key];
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return undefined;
}

function controlId(key: string): string {
  return `setting-${key}`;
}

interface SettingRowProps {
  item: SettingDescriptor;
  settings: Settings | null;
  disabled: boolean;
  /** The first row of a card carries no top divider. */
  first: boolean;
  onChangeSetting: SettingsSectionProps["onChangeSetting"];
  onChangeSettingUnit: SettingsSectionProps["onChangeSettingUnit"];
}

function SettingRow({
  item,
  settings,
  disabled,
  first,
  onChangeSetting,
  onChangeSettingUnit,
}: SettingRowProps) {
  const id = controlId(item.key);
  const value = settings === null ? undefined : readSetting(settings, item.key);
  const unitValue =
    settings !== null && item.unitKey !== undefined
      ? readSetting(settings, item.unitKey)
      : undefined;

  let control;
  switch (item.control) {
    case "toggle":
      control = (
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChangeSetting(item.key, event.currentTarget.checked)}
          style={CHECKBOX}
        />
      );
      break;

    case "select":
      control = (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChangeSetting(item.key, event.currentTarget.value)}
          style={CONTROL}
        >
          {(item.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;

    case "number": {
      // Integer settings step by 1; the fraction-bearing measures by 0.1.
      const step = item.min !== undefined && Number.isInteger(item.min) ? 1 : 0.1;
      control = (
        <div style={CONTROLS}>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            min={item.min}
            max={item.max}
            step={step}
            value={typeof value === "number" ? value : ""}
            disabled={disabled}
            onChange={(event) => {
              const input = event.currentTarget;
              const next = input.valueAsNumber;
              // Only valid, in-range values reach the service; a half-typed
              // number stays local until it is complete.
              if (Number.isNaN(next) || !input.checkValidity()) return;
              if (item.unitKey === undefined) onChangeSetting(item.key, next);
              else onChangeSettingUnit(item.key, item.unitKey, next);
            }}
            style={NUMBER_INPUT}
          />
          {item.unitKey !== undefined && (
            <select
              aria-label={`${item.label} unit`}
              value={typeof unitValue === "string" ? unitValue : ""}
              disabled={disabled}
              onChange={(event) =>
                onChangeSettingUnit(item.key, item.unitKey as string, event.currentTarget.value)
              }
              style={UNIT_SELECT}
            >
              {(item.unitOptions ?? []).map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          )}
          {/* The live value as Ketcher stores it, unit included: a read-only
              summary beside the editable input. */}
          {typeof value === "number" && (
            <span style={VALUE_SUMMARY}>
              {formatSettingValue(value, typeof unitValue === "string" ? unitValue : undefined)}
            </span>
          )}
        </div>
      );
      break;
    }
  }

  return (
    <li style={first ? SETTING_ROW : { ...SETTING_ROW, borderTop: ROW_DIVIDER }}>
      <label htmlFor={id} style={SETTING_LABEL}>
        {item.label}
      </label>
      <div style={CONTROLS}>{control}</div>
    </li>
  );
}

export function SettingsSection({
  settings,
  onChangeSetting,
  onChangeSettingUnit,
  onPresetSetting,
  onResetSettings,
}: SettingsSectionProps) {
  const disabled = settings === null;

  return (
    <section aria-labelledby="backstage-settings-title">
      <h2 id="backstage-settings-title" style={SECTION_TITLE}>
        Settings
      </h2>
      <p style={SECTION_LEAD}>
        {disabled
          ? "Settings become available when the editor is ready."
          : "Editor preferences applied live through the Ketcher settings service."}
      </p>

      {SETTINGS_GROUPS.map((group, groupIndex) => (
        <div key={group.id}>
          <h3 style={{ ...GROUP_HEADING, ...(groupIndex === 0 ? { marginTop: 0 } : {}) }}>
            {group.label}
          </h3>
          <ul style={CARD}>
            {group.items.map((item, index) => (
              <SettingRow
                key={item.key}
                item={item}
                settings={settings}
                disabled={disabled}
                first={index === 0}
                onChangeSetting={onChangeSetting}
                onChangeSettingUnit={onChangeSettingUnit}
              />
            ))}
          </ul>
        </div>
      ))}

      <div style={FOOTER}>
        <Button onClick={onResetSettings} disabled={disabled}>
          Reset to defaults
        </Button>
        <Button onClick={onPresetSetting} disabled={disabled}>
          Restore ACS preset
        </Button>
      </div>
      <p style={STORAGE_NOTE}>
        These preferences are stored locally by Ketcher and apply to every document. They are not
        saved inside the `.ket` file.
      </p>
    </section>
  );
}
