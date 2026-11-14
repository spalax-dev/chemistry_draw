/**
 * In-app dialogs for the document workflow: the close guard, Export and
 * save/export errors. They are presentational only — App.tsx owns the state and
 * the decisions (see `docs/conventions.md` §6). Startup restore is silent, so
 * there is no recovery dialog.
 */

import { closeGuardCopy, type CloseGuardAction } from "../closeGuardCopy";
import type { CloseChoice, ExportFormat } from "../document";
import { Button, type ButtonVariant } from "./Button";
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

export interface CloseGuardDialogProps {
  /** Base name of the document the prompt is about (single dirty tab). */
  documentName: string;
  /** How many tabs have unsaved changes; more than one hides Save. */
  dirtyCount: number;
  /**
   * Whether Save may be offered. Only a single dirty tab that is currently
   * active can be written through the one editor.
   */
  allowSave: boolean;
  /** Called with the user's answer; Escape answers `cancel`. */
  onChoice: (choice: CloseChoice) => void;
}

/** Visual weight and label for each close-guard action. */
const ACTION_STYLE: Record<CloseGuardAction, { label: string; variant: ButtonVariant }> = {
  save: { label: "Save", variant: "primary" },
  discard: { label: "Discard", variant: "danger" },
  cancel: { label: "Cancel", variant: "secondary" },
};

/** Save / Discard / Cancel prompt for one or more dirty tabs. */
export function CloseGuardDialog({
  documentName,
  dirtyCount,
  allowSave,
  onChoice,
}: CloseGuardDialogProps) {
  const copy = closeGuardCopy({ documentName, dirtyCount, allowSave });
  const [situation, question] = copy.lines;

  return (
    <Dialog
      title={copy.title}
      onCancel={() => onChoice("cancel")}
      actions={
        <>
          {copy.actions.map((action) => (
            <Button
              key={action}
              variant={ACTION_STYLE[action].variant}
              data-autofocus={action === "cancel" ? "true" : undefined}
              onClick={() => onChoice(action)}
            >
              {ACTION_STYLE[action].label}
            </Button>
          ))}
        </>
      }
    >
      <p style={PARAGRAPH}>
        <strong>{situation}</strong>
      </p>
      <p style={PARAGRAPH}>{question}</p>
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
