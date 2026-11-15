/**
 * Backstage → Recent: the remembered `.ket` paths and the tabs that are open
 * right now. Presentational only; `App` owns open/remove/switch
 * (`docs/architecture.md` §5.11).
 */

import { recentName } from "../../recent";
import { tabDisplayName, type TabSet } from "../../tabs";
import { Button } from "../Button";
import {
  CARD,
  EMPTY_HINT,
  ROW,
  ROW_DIVIDER,
  ROW_META,
  ROW_NAME,
  ROW_TEXT,
  SECTION_LEAD,
  SECTION_TITLE,
  SUBHEADING,
} from "./sectionStyles";

export interface RecentSectionProps {
  /** Absolute `.ket` paths, newest first, capped by `src/recent.ts`. */
  recent: string[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  tabs: TabSet;
  onSwitchTab: (id: string) => void;
}

export function RecentSection({
  recent,
  onOpenRecent,
  onRemoveRecent,
  tabs,
  onSwitchTab,
}: RecentSectionProps) {
  return (
    <section aria-labelledby="backstage-recent-title">
      <h2 id="backstage-recent-title" style={SECTION_TITLE}>
        Recent
      </h2>
      <p style={SECTION_LEAD}>The last documents opened on this machine.</p>

      {recent.length === 0 ? (
        <p style={EMPTY_HINT}>No recent documents</p>
      ) : (
        <ul style={CARD}>
          {recent.map((path, index) => {
            const name = recentName(path);
            return (
              <li key={path} style={{ ...ROW, ...(index === 0 ? {} : { borderTop: ROW_DIVIDER }) }}>
                <span style={ROW_TEXT}>
                  <span style={ROW_NAME} title={path}>
                    {name}
                  </span>
                  <span style={ROW_META} title={path}>
                    {path}
                  </span>
                </span>
                <Button onClick={() => onOpenRecent(path)}>Open</Button>
                <Button onClick={() => onRemoveRecent(path)}>Remove</Button>
              </li>
            );
          })}
        </ul>
      )}

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
