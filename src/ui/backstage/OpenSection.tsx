/**
 * Backstage → Open: the shared **Recent structures** table with an added
 * **Remove** action, then the tabs that are open right now. Presentational
 * only; `App` owns open/remove/switch (`docs/architecture.md` §5.11). The table
 * is the single loader-backed source shared with Welcome, so this pane never
 * builds a second list and never renders artwork of its own.
 */

import type { RecentRow } from "../../recentStructures";
import { tabDisplayName, type TabSet } from "../../tabs";
import { Button } from "../Button";
import { RecentStructuresTable } from "./RecentStructuresTable";
import {
  CARD,
  ROW,
  ROW_DIVIDER,
  ROW_META,
  ROW_NAME,
  ROW_TEXT,
  SECTION_LEAD,
  SECTION_TITLE,
  SUBHEADING,
} from "./sectionStyles";

export interface OpenSectionProps {
  /** The same rows `App` loaded for Welcome (`loadRecentStructures`). */
  recentStructures: RecentRow[];
  /** True while `App` loads those rows; the table shows its loading row. */
  recentStructuresLoading: boolean;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  tabs: TabSet;
  onSwitchTab: (id: string) => void;
}

export function OpenSection({
  recentStructures,
  recentStructuresLoading,
  onOpenRecent,
  onRemoveRecent,
  tabs,
  onSwitchTab,
}: OpenSectionProps) {
  return (
    <section aria-labelledby="backstage-open-title">
      <h2 id="backstage-open-title" style={SECTION_TITLE}>
        Open
      </h2>
      <p style={SECTION_LEAD}>The last documents opened on this machine.</p>

      <RecentStructuresTable
        rows={recentStructures}
        loading={recentStructuresLoading}
        onOpen={onOpenRecent}
        onRemove={onRemoveRecent}
      />

      <h3 style={SUBHEADING}>Open documents</h3>
      <ul style={CARD}>
        {tabs.tabs.map((tab, index) => {
          const active = tab.id === tabs.activeId;
          return (
            <li key={tab.id} style={{ ...ROW, ...(index === 0 ? {} : { borderTop: ROW_DIVIDER }) }}>
              <span style={ROW_TEXT}>
                <span style={ROW_NAME}>
                  {tabDisplayName(tab)}
                  {tab.dirty ? " •" : ""}
                </span>
                <span style={ROW_META}>
                  {tab.path ?? "Not saved yet"}
                  {tab.dirty ? " — unsaved changes" : ""}
                </span>
              </span>
              <Button
                disabled={active}
                title={active ? "Current document" : undefined}
                onClick={() => onSwitchTab(tab.id)}
              >
                Switch
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
