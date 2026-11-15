/**
 * The backstage overlay: the app's start surface (`docs/architecture.md` §5.11,
 * `docs/conventions.md` §6.8).
 *
 * It is one full-window `role="dialog"` above the tab strip and Ketcher, not a
 * route or a second editor. The rail is a `nav` of real buttons with roving
 * focus; focus moves in on open, stays inside while open and returns to the
 * trigger on close. Escape and **Back to Editor** close it. Sections are
 * presentational; `App` owns every command and every data source.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Settings } from "ketcher-core";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  formatBackstageStatus,
  type BackstageSectionId,
} from "../backstage";
import type { TabSet } from "../tabs";
import { Button } from "./Button";
import { AboutSection } from "./backstage/AboutSection";
import { NewSection } from "./backstage/NewSection";
import { RecentSection } from "./backstage/RecentSection";
import { SaveExportSection } from "./backstage/SaveExportSection";
import { SettingsSection, type SettingValue } from "./backstage/SettingsSection";
import { tokens } from "./tokens";

export interface BackstageProps {
  onClose: () => void;
  onNew: () => void;
  onImport: () => void;
  onOpen: () => void;
  /** Absolute `.ket` paths, newest first. */
  recent: string[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  tabs: TabSet;
  activeTabId: string;
  onSwitchTab: (id: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  /** From `GET /v2/info`; `null` until the sidecar answers. */
  indigoVersion: string | null;
  /** The actually bound sidecar port from `api_path`. */
  indigoPort: number | null;
  /** The editor/sidecar startup has not finished; shown in the status strip. */
  starting?: boolean;
  appVersion: string;
  /** Live Ketcher settings; `null` until `settingsService` exists. */
  ketcherSettings: Settings | null;
  onChangeSetting: (key: string, value: SettingValue) => void;
  onChangeSettingUnit: (key: string, unitKey: string, value: number | string) => void;
  onPresetSetting: () => void;
  onResetSettings: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  // Above the editor and its dialogs; document dialogs raise themselves above
  // the backstage so Save As / Export still work from this view.
  zIndex: tokens.zIndex.backstage,
  display: "flex",
  flexDirection: "column",
  background: tokens.color.surface,
  color: tokens.color.text,
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
};

const TOP_BAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flex: "0 0 auto",
  height: 56,
  padding: "0 16px",
  boxSizing: "border-box",
  background: tokens.color.surface,
  borderBottom: `${tokens.borderWidth} solid ${tokens.color.border}`,
};

const LOGO: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: 28,
  height: 28,
  borderRadius: tokens.dialog.radius,
  background: tokens.color.accent,
  color: tokens.color.surface,
};

const BRAND: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  minWidth: 0,
};

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.title,
  fontWeight: 500,
  color: tokens.color.text,
};

const MUTED: CSSProperties = {
  fontSize: tokens.fontSize.body,
  fontWeight: 400,
  color: tokens.color.muted,
};

const BODY: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  flex: "1 1 auto",
  minHeight: 0,
};

const RAIL: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "0 0 260px",
  width: 260,
  boxSizing: "border-box",
  padding: "12px 0",
  background: tokens.color.surfaceSubtle,
  borderRight: `${tokens.borderWidth} solid ${tokens.color.border}`,
};

const RAIL_LABEL: CSSProperties = {
  padding: "0 16px 8px",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  lineHeight: 1.4,
  textTransform: "uppercase",
  color: tokens.color.muted,
};

const RAIL_LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
};

const RAIL_FOOTER: CSSProperties = {
  padding: "12px 16px 0",
  marginTop: 12,
};

const CONTENT: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  boxSizing: "border-box",
  padding: 24,
  background: tokens.color.surface,
};

const STATUS: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flex: "0 0 auto",
  height: 32,
  padding: "0 16px",
  boxSizing: "border-box",
  background: tokens.color.page,
  borderTop: `${tokens.borderWidth} solid ${tokens.color.border}`,
  color: tokens.color.muted,
  fontSize: tokens.fontSize.body,
};

/** A rail button's colour changes with its active state; the bar is the marker. */
function railButtonStyle(active: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    padding: "10px 16px 10px 13px",
    boxSizing: "border-box",
    border: "none",
    borderLeft: `3px solid ${active ? tokens.color.accent : "transparent"}`,
    background: active ? tokens.color.surface : "transparent",
    fontFamily: tokens.fontFamily,
    fontSize: tokens.fontSize.body,
    fontWeight: active ? 500 : 400,
    lineHeight: 1.4,
    color: active ? tokens.color.accent : tokens.color.textSecondary,
    textAlign: "left",
    cursor: "pointer",
    outlineColor: tokens.color.accent,
    outlineOffset: "-2px",
  };
}

export function Backstage({
  onClose,
  onNew,
  onImport,
  onOpen,
  recent,
  onOpenRecent,
  onRemoveRecent,
  tabs,
  activeTabId,
  onSwitchTab,
  onSave,
  onSaveAs,
  onExport,
  indigoVersion,
  indigoPort,
  starting = false,
  appVersion,
  ketcherSettings,
  onChangeSetting,
  onChangeSettingUnit,
  onPresetSetting,
  onResetSettings,
}: BackstageProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const railRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [section, setSection] = useState<BackstageSectionId>(DEFAULT_BACKSTAGE_SECTION);

  // Focus the active rail item on open and return to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    railRefs.current[0]?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function focusableElements(): HTMLElement[] {
    const root = overlayRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const root = overlayRef.current;
    const items = focusableElements();
    if (items.length === 0) {
      event.preventDefault();
      root?.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    const inside = root !== null && current !== null && root.contains(current);

    if (event.shiftKey && (!inside || current === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || current === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Moves the roving focus and selects the section the rail button stands for. */
  function moveRailFocus(index: number): void {
    const count = BACKSTAGE_SECTIONS.length;
    const target = BACKSTAGE_SECTIONS[(index + count) % count];
    setSection(target.id);
    railRefs.current[(index + count) % count]?.focus();
  }

  function handleRailKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveRailFocus(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveRailFocus(index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveRailFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveRailFocus(BACKSTAGE_SECTIONS.length - 1);
        break;
      default:
        break;
    }
  }

  function renderSection() {
    switch (section) {
      case "new":
        return <NewSection onNew={onNew} onImport={onImport} onOpen={onOpen} />;
      case "recent":
        return (
          <RecentSection
            recent={recent}
            onOpenRecent={onOpenRecent}
            onRemoveRecent={onRemoveRecent}
            tabs={tabs}
            onSwitchTab={onSwitchTab}
          />
        );
      case "save-export":
        return (
          <SaveExportSection
            tabs={tabs}
            activeTabId={activeTabId}
            onSave={onSave}
            onSaveAs={onSaveAs}
            onExport={onExport}
          />
        );
      case "settings":
        return (
          <SettingsSection
            settings={ketcherSettings}
            onChangeSetting={onChangeSetting}
            onChangeSettingUnit={onChangeSettingUnit}
            onPresetSetting={onPresetSetting}
            onResetSettings={onResetSettings}
          />
        );
      case "about":
        return (
          <AboutSection
            appVersion={appVersion}
            indigoVersion={indigoVersion}
            indigoPort={indigoPort}
          />
        );
    }
  }

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={OVERLAY}
    >
      <header style={TOP_BAR}>
        <span aria-hidden="true" style={LOGO}>
          <svg
            focusable="false"
            width={16}
            height={16}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          >
            <path d="M8 1.6 13.5 4.8v6.4L8 14.4 2.5 11.2V4.8z" />
            <circle cx={8} cy={8} r={2.2} />
          </svg>
        </span>
        <div style={BRAND}>
          <h1 id={titleId} style={TITLE}>
            Chemistry Draw
          </h1>
          <span aria-hidden="true" style={MUTED}>
            |
          </span>
          <span style={MUTED}>Backstage</span>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Button onClick={onClose}>← Back to Editor</Button>
        </div>
      </header>

      <div style={BODY}>
        <nav aria-label="Backstage sections" style={RAIL}>
          <div style={RAIL_LABEL}>File operations</div>
          <div style={RAIL_LIST}>
            {BACKSTAGE_SECTIONS.map((entry, index) => {
              const active = entry.id === section;
              return (
                <button
                  key={entry.id}
                  ref={(node) => {
                    railRefs.current[index] = node;
                  }}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setSection(entry.id)}
                  onKeyDown={(event) => handleRailKeyDown(event, index)}
                  style={railButtonStyle(active)}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
          <div style={RAIL_FOOTER}>
            <Button style={{ width: "100%" }} onClick={onClose}>
              Exit Backstage
            </Button>
          </div>
        </nav>

        <main style={CONTENT}>{renderSection()}</main>
      </div>

      <footer style={STATUS}>
        <span aria-live="polite" style={MUTED}>
          {formatBackstageStatus(indigoVersion, indigoPort)}
        </span>
        <span>
          {starting ? "Loading chemistry editor… · " : ""}Version {appVersion}
        </span>
      </footer>
    </div>
  );
}
