/**
 * In-app dialogs for the document workflow: startup recovery, the close guard,
 * Export and save/export errors. They are presentational only — App.tsx owns
 * the state and the decisions (see `docs/conventions.md` §6).
 */

import type { CloseChoice, ExportFormat } from "../document";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

const PARAGRAPH = { margin: "0 0 8px" } as const;

const EXPORT_OPTIONS: { format: ExportFormat; label: string }[] = [
  { format: "v2000", label: "Molfile V2000" },
  { format: "v3000", label: "Molfile V3000" },
  { format: "smiles", label: "SMILES" },
  { format: "inchi", label: "InChI" },
  { format: "svg", label: "SVG image" },
  { format: "png", label: "PNG image" },
];

export interface RecoveryDialogProps {
  /** Base name of the document the snapshot belongs to. */
  documentName: string;
  /** Extra explanation, e.g. that the original file is no longer on disk. */
  note?: string | null;
  onRestore: () => void;
  onDiscard: () => void;
}

/** Startup prompt for an autosave snapshot. Escape discards. */
export function RecoveryDialog({
  documentName,
  note = null,
  onRestore,
  onDiscard,
}: RecoveryDialogProps) {
  return (
    <Dialog
      title="Recover unsaved work?"
      onCancel={onDiscard}
      actions={
        <>
          <Button variant="danger" onClick={onDiscard}>
            Discard
          </Button>
          <Button variant="primary" data-autofocus="true" onClick={onRestore}>
            Restore
          </Button>
        </>
      }
    >
      <p style={PARAGRAPH}>
        Chemistry Draw found unsaved changes in <strong>{documentName}</strong> from a previous
        session.
      </p>
      {note ? <p style={PARAGRAPH}>{note}</p> : null}
      <p style={PARAGRAPH}>
        Restore loads them so you can save; Discard deletes the recovered copy.
      </p>
    </Dialog>
  );
}

export interface CloseGuardDialogProps {
  /** Base name of the document the prompt is about. */
  documentName: string;
  /** What the unsaved changes are about to be replaced by. */
  intent: "close" | "replace";
  /** Called with the user's answer; Escape answers `cancel`. */
  onChoice: (choice: CloseChoice) => void;
}

/** Save / Discard / Cancel prompt for a dirty document. */
export function CloseGuardDialog({ documentName, intent, onChoice }: CloseGuardDialogProps) {
  const consequence = intent === "close" ? "closing the window" : "replacing the current document";
  return (
    <Dialog
      title="Save changes?"
      onCancel={() => onChoice("cancel")}
      actions={
        <>
          <Button data-autofocus="true" onClick={() => onChoice("cancel")}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onChoice("discard")}>
            Discard
          </Button>
          <Button variant="primary" onClick={() => onChoice("save")}>
            Save
          </Button>
        </>
      }
    >
      <p style={PARAGRAPH}>
        <strong>{documentName}</strong> has unsaved changes.
      </p>
      <p style={PARAGRAPH}>
        Cancel keeps them, Discard drops them before {consequence}, and Save writes the document
        first.
      </p>
    </Dialog>
  );
}

export interface ExportDialogProps {
  onExport: (format: ExportFormat) => void;
  onCancel: () => void;
}

/**
 * Format picker for Export. Export writes a separate file and never changes
 * the document path or its `.ket` save format.
 */
export function ExportDialog({ onExport, onCancel }: ExportDialogProps) {
  return (
    <Dialog
      title="Export"
      width={460}
      onCancel={onCancel}
      actions={
        <Button data-autofocus="true" onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <p style={PARAGRAPH}>
        Choose a format. The export is written to a new file; the document keeps its `.ket` save
        format.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px",
          marginTop: "12px",
        }}
      >
        {EXPORT_OPTIONS.map(({ format, label }) => (
          <Button key={format} onClick={() => onExport(format)}>
            {label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}

export interface ErrorDialogProps {
  message: string;
  onClose: () => void;
}

/** In-app replacement for native alerts on new save/export failures. */
export function ErrorDialog({ message, onClose }: ErrorDialogProps) {
  return (
    <Dialog
      title="Error"
      onCancel={onClose}
      actions={
        <Button variant="primary" data-autofocus="true" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p style={PARAGRAPH}>{message}</p>
    </Dialog>
  );
}
