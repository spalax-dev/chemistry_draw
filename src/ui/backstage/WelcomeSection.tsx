/**
 * Backstage → Welcome: the real ways to start a document plus the template
 * grid (`docs/architecture.md` §5.11, `docs/conventions.md` §6.8).
 *
 * Every action calls the same handler the File menu uses; the section owns no
 * I/O and no insertion logic. The grid is backed by Ketcher's real Structure
 * Library, passed in as `templates`, so every card is a structure the editor
 * can load. The visible subset always samples exactly `TEMPLATE_CARD_COUNT`
 * entries on mount. Previews are rendered by Ketcher through the injected
 * `renderPreview`.
 */

import { useMemo, useState, type CSSProperties } from "react";

import { activeTab, isUntouchedTab, tabTitle, type TabSet } from "../../tabs";
import type { RecentRow } from "../../recentStructures";
import { sampleTemplates, TEMPLATE_CARD_COUNT, type LibraryTemplate } from "../../templateLibrary";
import { Button } from "../Button";
import { tokens } from "../tokens";
import { RecentStructuresTable } from "./RecentStructuresTable";
import { TemplateCard } from "./TemplateCard";
import { useTemplatePreview } from "./useTemplatePreview";
import {
  ACTION_BUTTON,
  ACTION_LIST,
  EMPTY_HINT,
  SECTION_LEAD,
  SECTION_TITLE,
} from "./sectionStyles";

const TEMPLATES_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  maxWidth: 720,
  margin: "24px 0 8px",
};

const TEMPLATES_LABEL: CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  lineHeight: 1.4,
  textTransform: "uppercase",
  color: tokens.color.muted,
};

const TEMPLATE_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
  maxWidth: 720,
};

const SKELETON_CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  borderStyle: "solid",
  borderWidth: tokens.borderWidth,
  borderRadius: tokens.dialog.radius,
  borderColor: tokens.color.border,
  background: tokens.color.surface,
  overflow: "hidden",
};

const SKELETON_PREVIEW: CSSProperties = {
  height: 96,
  boxSizing: "border-box",
  background: tokens.color.surfacePreview,
  borderBottom: `${tokens.borderWidth} solid ${tokens.color.border}`,
};

const SKELETON_BODY: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 10,
};

const SKELETON_BONE: CSSProperties = {
  height: 10,
  borderRadius: tokens.radius,
  background: tokens.color.surfaceSubtle,
};

/** One placeholder card with the real card's box, until the library lands. */
function TemplateSkeletonCard() {
  return (
    <div aria-hidden="true" style={SKELETON_CARD}>
      <div style={SKELETON_PREVIEW} />
      <div style={SKELETON_BODY}>
        <div style={{ ...SKELETON_BONE, width: "70%" }} />
        <div style={{ ...SKELETON_BONE, width: "45%", height: 8 }} />
      </div>
    </div>
  );
}

/** The `RECENT STRUCTURES` heading: same 10 px uppercase label as Templates. */
const RECENT_HEADER: CSSProperties = {
  ...TEMPLATES_LABEL,
  margin: "24px 0 8px",
};

/** Props of the Welcome pane; all actions and data are injected by `App`. */
export interface WelcomeSectionProps {
  onNew: () => void;
  onImport: () => void;
  onOpen: () => void;
  /** Inserts a real library entry into a new tab; wired by `App`. */
  onTemplate: (template: LibraryTemplate) => void;
  /** Opens Ketcher's real Structure Library through the App handler. */
  onMoreTemplates: () => void;
  /**
   * The open tabs. Back to editor is offered only when at least one tab is a
   * real document (not an untouched empty tab, see `isUntouchedTab`).
   */
  tabs: TabSet;
  /** Closes the overlay only; the editor already shows the active tab. */
  onBackToEditor: () => void;
  /** The real Structure Library entries; the only source of cards. */
  templates: LibraryTemplate[];
  /** True until the deferred library build lands; shows skeleton cards. */
  templatesLoading?: boolean;
  /** Renders one entry's KET to a preview object URL through Ketcher. */
  renderPreview: (ket: string) => Promise<string>;
  /** True until the editor reports ready; the template cards stay inert. */
  disabled?: boolean;
  /** Rows of the real Recent structures table (`loadRecentStructures`). */
  recentStructures: RecentRow[];
  /** True while `App` loads the recent rows. */
  recentStructuresLoading: boolean;
  /** Opens a recent row through the App's `openProject` handler. */
  onOpenRecent: (path: string) => void;
}

interface WelcomeTemplateCardProps {
  template: LibraryTemplate;
  renderPreview: (ket: string) => Promise<string>;
  onTemplate: (template: LibraryTemplate) => void;
  disabled: boolean;
}

/** Bridges the preview hook to the presentational card (one hook per card). */
function WelcomeTemplateCard({
  template,
  renderPreview,
  onTemplate,
  disabled,
}: WelcomeTemplateCardProps) {
  const preview = useTemplatePreview(template.ket, renderPreview);

  return (
    <TemplateCard
      template={template}
      preview={preview}
      onTemplate={onTemplate}
      disabled={disabled}
    />
  );
}

/** The Welcome pane: start actions, four sampled library cards and recents. */
export function WelcomeSection({
  onNew,
  onImport,
  onOpen,
  onTemplate,
  onMoreTemplates,
  tabs,
  onBackToEditor,
  templates,
  templatesLoading = false,
  renderPreview,
  disabled = false,
  recentStructures,
  recentStructuresLoading,
  onOpenRecent,
}: WelcomeSectionProps) {
  // One RNG per mount: a new backstage open gets a fresh one, so every open
  // re-randomizes (docs/architecture.md §5.11).
  const [random] = useState(() => Math.random);
  const visibleTemplates = useMemo(
    () => sampleTemplates(templates, TEMPLATE_CARD_COUNT, random),
    [templates, random],
  );
  const hasDocument = tabs.tabs.some((tab) => !isUntouchedTab(tab));

  return (
    <section aria-labelledby="backstage-welcome-title">
      <h2 id="backstage-welcome-title" style={SECTION_TITLE}>
        Welcome
      </h2>
      <p style={SECTION_LEAD}>Start from a blank canvas or a template.</p>
      <div style={ACTION_LIST}>
        {hasDocument ? (
          <Button variant="primary" style={ACTION_BUTTON} onClick={onBackToEditor}>
            Back to editor — {tabTitle(activeTab(tabs))}
          </Button>
        ) : null}
        <Button
          variant={hasDocument ? "secondary" : "primary"}
          style={ACTION_BUTTON}
          onClick={onNew}
        >
          Blank canvas
        </Button>
        <Button style={ACTION_BUTTON} onClick={onImport}>
          Import structure…
        </Button>
        <Button style={ACTION_BUTTON} onClick={onOpen}>
          Open project…
        </Button>
      </div>

      <div style={TEMPLATES_HEADER}>
        <h3 style={TEMPLATES_LABEL}>Templates</h3>
        <Button style={{ minHeight: 24 }} onClick={onMoreTemplates} disabled={disabled}>
          More templates
        </Button>
      </div>
      {templates.length === 0 ? (
        <>
          {templatesLoading && (
            <div style={TEMPLATE_GRID} aria-hidden="true">
              {Array.from({ length: TEMPLATE_CARD_COUNT }, (_, index) => (
                <TemplateSkeletonCard key={index} />
              ))}
            </div>
          )}
          {!templatesLoading && <p style={EMPTY_HINT}>No templates available</p>}
        </>
      ) : (
        <div style={TEMPLATE_GRID}>
          {visibleTemplates.map((template) => (
            <WelcomeTemplateCard
              key={template.id}
              template={template}
              renderPreview={renderPreview}
              onTemplate={onTemplate}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <h3 style={RECENT_HEADER}>Recent structures</h3>
      <RecentStructuresTable
        rows={recentStructures}
        loading={recentStructuresLoading}
        onOpen={onOpenRecent}
      />
    </section>
  );
}
