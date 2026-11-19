/**
 * The backstage overlay: the app's start surface (`docs/architecture.md` §5.11,
 * `docs/conventions.md` §6.8).
 *
 * It is one full-window `role="dialog"` above the tab strip and Ketcher, not a
 * route or a second editor. The rail is a `nav` of real buttons with roving
 * focus; focus moves in on open, stays inside while open and returns to the
 * trigger on close. Escape closes it; the rail's Exit Backstage is the only
 * top-level exit control (the Welcome pane offers Back to editor for an open
 * document). Sections are presentational; `App` owns every command and data
 * source.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Settings } from "ketcher-core";

import {
  BACKSTAGE_SECTIONS,
  DEFAULT_BACKSTAGE_SECTION,
  normalizeSection,
  type BackstageSectionId,
} from "../backstage";
import type { LibraryTemplate } from "../templateLibrary";
import type { RecentRow } from "../recentStructures";
import type { TabSet } from "../tabs";
import { Button } from "./Button";
import { AboutSection } from "./backstage/AboutSection";
import { ModelsSection } from "./backstage/ModelsSection";
import { OpenSection } from "./backstage/OpenSection";
import { SettingsSection, type SettingValue } from "./backstage/SettingsSection";
import { WelcomeSection } from "./backstage/WelcomeSection";
import { tokens } from "./tokens";

export interface BackstageProps {
  onClose: () => void;
  onNew: () => void;
  onImport: () => void;
  onOpen: () => void;
  /** Loads a library entry into a new tab; wired by `App`. */
  onTemplate: (template: LibraryTemplate) => void;
  /** Closes the backstage and opens Ketcher's Structure Library. */
  onMoreTemplates: () => void;
  /** The real Structure Library entries; empty until `App` reads the providers. */
  templates?: LibraryTemplate[];
  /** True while `App` builds that library after paint; Welcome paints skeletons. */
  templatesLoading?: boolean;
  /** Ketcher's preview renderer; absent until `App` wires `generateImage`. */
  renderPreview?: (ket: string) => Promise<string>;
  /** Whether the editor can load a structure; template cards stay inert until it can. */
  editorReady: boolean;
  /** Welcome's and Open's Recent structures rows; empty until `App` loads them. */
  recentStructures?: RecentRow[];
  /** True while `App` builds those rows. */
  recentStructuresLoading?: boolean;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  tabs: TabSet;
  onSwitchTab: (id: string) => void;
  /** From `GET /v2/info`; `null` until the sidecar answers. */
  indigoVersion: string | null;
  /** The actually bound sidecar port from `api_path`. */
  indigoPort: number | null;
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

/** A rail button's colour changes with its active state; the bar is the marker. */
function railButtonStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
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

const ICON: CSSProperties = { flex: "0 0 auto" };

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: "false",
} as const;

/** The 16 px `currentColor` line icon that precedes each rail label (§5.11). */
function SectionIcon({ id }: { id: BackstageSectionId }) {
  switch (id) {
    case "welcome":
      return (
        <svg {...ICON_PROPS} style={ICON}>
          <path d="M2.5 7.5 8 2.5l5.5 5" />
          <path d="M4 6.8v6.7h8V6.8" />
        </svg>
      );
    case "open":
      return (
        <svg {...ICON_PROPS} style={ICON}>
          <path d="M2 12.5V4h4.2l1.3 2h5v2" />
          <path d="M2 12.5 4 7h10l-2 5.5z" />
        </svg>
      );
    case "models":
      return (
        <svg {...ICON_PROPS} style={ICON}>
          <path d="M8 1.8 14 5v6L8 14.2 2 11V5z" />
          <path d="M2 5l6 3 6-3" />
          <path d="M8 8v6.2" />
        </svg>
      );
    case "settings":
      return (
        <svg {...ICON_PROPS} style={ICON}>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          <circle cx={5.5} cy={4.5} r={1.4} />
          <circle cx={10.5} cy={8} r={1.4} />
          <circle cx={6.5} cy={11.5} r={1.4} />
        </svg>
      );
    case "about":
      return (
        <svg {...ICON_PROPS} style={ICON}>
          <circle cx={8} cy={8} r={6} />
          <path d="M8 7.3v3.9" />
          <path d="M8 4.7v.01" />
        </svg>
      );
  }
}

/** A safe default until `App` passes Ketcher's `generateImage` renderer. */
function unavailablePreview(): Promise<string> {
  return Promise.reject(new Error("Template preview renderer is not wired"));
}

export function Backstage({
  onClose,
  onNew,
  onImport,
  onOpen,
  onTemplate,
  onMoreTemplates,
  templates = [],
  templatesLoading = false,
  renderPreview = unavailablePreview,
  editorReady,
  recentStructures = [],
  recentStructuresLoading = false,
  onOpenRecent,
  onRemoveRecent,
  tabs,
  onSwitchTab,
  indigoVersion,
  indigoPort,
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
  // One normalized value drives both the pane and the rail highlight, so a stale
  // or unknown id falls back to Welcome in both places at once.
  const current = normalizeSection(section);

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
    switch (current) {
      case "open":
        return (
          <OpenSection
            recentStructures={recentStructures}
            recentStructuresLoading={recentStructuresLoading}
            onOpenRecent={onOpenRecent}
            onRemoveRecent={onRemoveRecent}
            tabs={tabs}
            onSwitchTab={onSwitchTab}
          />
        );
      case "models":
        return <ModelsSection />;
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
      case "welcome":
      // An unknown or stale id normalizes to Welcome, so both share this pane.
      // falls through
      default:
        return (
          <WelcomeSection
            onNew={onNew}
            onImport={onImport}
            onOpen={onOpen}
            onTemplate={onTemplate}
            onMoreTemplates={onMoreTemplates}
            tabs={tabs}
            onBackToEditor={onClose}
            templates={templates}
            templatesLoading={templatesLoading}
            renderPreview={renderPreview}
            disabled={!editorReady}
            recentStructures={recentStructures}
            recentStructuresLoading={recentStructuresLoading}
            onOpenRecent={onOpenRecent}
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
      </header>

      <div style={BODY}>
        <nav aria-label="Backstage sections" style={RAIL}>
          <div style={RAIL_LABEL}>File operations</div>
          <div style={RAIL_LIST}>
            {BACKSTAGE_SECTIONS.map((entry, index) => {
              const active = entry.id === current;
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
                  <SectionIcon id={entry.id} />
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
    </div>
  );
}
