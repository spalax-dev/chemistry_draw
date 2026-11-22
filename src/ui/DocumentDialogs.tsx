/**
 * In-app dialogs for the document workflow: the close guard, Export,
 * save/export errors and the already-open notice. They are presentational only —
 * App.tsx owns the state and the decisions (see `docs/conventions.md` §6).
 * Startup restore is silent, so the tab set has no recovery dialog.
 */

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

/** One close-guard action and the visual weight it renders with. */
interface CloseGuardActionStyle {
  label: string;
  variant: ButtonVariant;
}

/** Visual weight and label for each close-guard action. */
const ACTION_STYLE: Record<CloseChoice, CloseGuardActionStyle> = {
  save: { label: "Save", variant: "primary" },
  discard: { label: "Discard", variant: "danger" },
  cancel: { label: "Cancel", variant: "secondary" },
};

/** The copy and ordered actions for one close-guard decision. */
function closeGuardCopy(
  documentName: string,
  dirtyCount: number,
  allowSave: boolean,
): { title: string; situation: string; question: string; actions: CloseChoice[] } {
  if (dirtyCount === 1) {
    const situation = `${documentName} has unsaved changes.`;

    if (allowSave) {
      return {
        title: "Save changes?",
        situation,
        question: "Do you want to save them before closing?",
        actions: ["save", "discard", "cancel"],
      };
    }

    return {
      title: "Unsaved changes",
      situation,
      question: "Are you sure you want to discard them?",
      actions: ["discard", "cancel"],
    };
  }

  return {
    title: "Unsaved changes",
    situation: `${dirtyCount} documents have unsaved changes.`,
    question: "Are you sure you want to discard them?",
    actions: ["discard", "cancel"],
  };
}

/**
 * Save / Discard / Cancel prompt for one or more dirty tabs.
 *
 * Save appears only when exactly one dirty tab is active; otherwise the prompt
 * offers Discard / Cancel. Escape answers `cancel`.
 */
export function CloseGuardDialog({
  documentName,
  dirtyCount,
  allowSave,
  onChoice,
}: CloseGuardDialogProps) {
  const copy = closeGuardCopy(documentName, dirtyCount, allowSave);

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
        <strong>{copy.situation}</strong>
      </p>
      <p style={PARAGRAPH}>{copy.question}</p>
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
  /** Dialog heading; recognition failures pass `Structure problem`. */
  title?: string;
  message: string;
  onClose: () => void;
}

/** In-app replacement for native alerts on save/export and recognition failures. */
export function ErrorDialog({ title = "Error", message, onClose }: ErrorDialogProps) {
  return (
    <Dialog
      title={title}
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

/** Props of the already-open (or other single-acknowledgement) notice. */
export interface NoticeDialogProps {
  /** Dialog heading; the already-open guard passes `Already open`. */
  title: string;
  /** One sentence stating the situation; the caller owns the copy. */
  message: string;
  onClose: () => void;
}

/**
 * Plain notice with a single acknowledgement action: the already-open guard
 * uses it, and Escape dismisses it like the button.
 */
export function NoticeDialog({ title, message, onClose }: NoticeDialogProps) {
  return (
    <Dialog
      title={title}
      onCancel={onClose}
      actions={
        <Button variant="primary" data-autofocus="true" onClick={onClose}>
          OK
        </Button>
      }
    >
      <p style={PARAGRAPH}>{message}</p>
    </Dialog>
  );
}
