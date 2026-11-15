/**
 * Backstage → New: the three real ways to start a document. Every action calls
 * the same handler the File menu uses; the section owns no I/O
 * (`docs/architecture.md` §5.11).
 */

import { Button } from "../Button";
import { ACTION_BUTTON, ACTION_LIST, SECTION_LEAD, SECTION_TITLE } from "./sectionStyles";

export interface NewSectionProps {
  onNew: () => void;
  onImport: () => void;
  onOpen: () => void;
}

export function NewSection({ onNew, onImport, onOpen }: NewSectionProps) {
  return (
    <section aria-labelledby="backstage-new-title">
      <h2 id="backstage-new-title" style={SECTION_TITLE}>
        New
      </h2>
      <p style={SECTION_LEAD}>Start from an empty canvas or open a structure from disk.</p>
      <div style={ACTION_LIST}>
        <Button variant="primary" style={ACTION_BUTTON} onClick={onNew}>
          Blank canvas
        </Button>
        <Button style={ACTION_BUTTON} onClick={onImport}>
          Import structure…
        </Button>
        <Button style={ACTION_BUTTON} onClick={onOpen}>
          Open project…
        </Button>
      </div>
    </section>
  );
}
