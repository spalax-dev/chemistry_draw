/**
 * Backstage → Save & Export: the active document's summary and the three
 * document commands. Save, Save As and Export keep the backstage open; Export
 * never changes the tab's path or format (`docs/architecture.md` §5.11).
 */

import { tabDisplayName, type TabSet } from "../../tabs";
import { Button } from "../Button";
import {
  ACTION_LIST,
  CARD,
  ROW,
  ROW_DIVIDER,
  ROW_META,
  ROW_NAME,
  ROW_TEXT,
  SECTION_LEAD,
  SECTION_TITLE,
} from "./sectionStyles";

export interface SaveExportSectionProps {
  tabs: TabSet;
  activeTabId: string;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
}

export function SaveExportSection({
  tabs,
  activeTabId,
  onSave,
  onSaveAs,
  onExport,
}: SaveExportSectionProps) {
  const tab = tabs.tabs.find((entry) => entry.id === activeTabId) ?? tabs.tabs[0];
  const name = tabDisplayName(tab);

  return (
    <section aria-labelledby="backstage-save-title">
      <h2 id="backstage-save-title" style={SECTION_TITLE}>
        Save &amp; Export
      </h2>
      <p style={SECTION_LEAD}>
        Save writes the `.ket` document. Export writes a separate file and leaves the document path
        and format unchanged.
      </p>

      <ul style={CARD}>
        <li style={ROW}>
          <span style={ROW_TEXT}>
            <span style={ROW_NAME}>{name}</span>
            <span style={ROW_META}>Document</span>
          </span>
        </li>
        <li style={{ ...ROW, borderTop: ROW_DIVIDER }}>
          <span style={ROW_TEXT}>
            <span style={ROW_NAME} title={tab.path ?? undefined}>
              {tab.path ?? "Not saved yet"}
            </span>
            <span style={ROW_META}>Path</span>
          </span>
        </li>
        <li style={{ ...ROW, borderTop: ROW_DIVIDER }}>
          <span style={ROW_TEXT}>
            <span style={ROW_NAME}>{tab.dirty ? "Unsaved changes" : "Saved"}</span>
            <span style={ROW_META}>Status</span>
          </span>
        </li>
      </ul>

      <div style={ACTION_LIST}>
        <Button variant="primary" onClick={onSave}>
          Save
        </Button>
        <Button onClick={onSaveAs}>Save As…</Button>
        <Button onClick={onExport}>Export…</Button>
      </div>
    </section>
  );
}
