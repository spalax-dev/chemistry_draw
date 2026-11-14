/**
 * Copy for the close guard: the title, the two body lines and the ordered
 * actions. Pure — it imports neither Tauri nor the DOM, so Vitest can pin the
 * wording (`docs/conventions.md` §6.4, §6.7) without rendering the dialog.
 *
 * The copy asks for a decision. It never explains implementation limits: no
 * "not possible", no "on screen", no "saving them all".
 */

/** Action the dialog offers, in the order it is rendered. */
export type CloseGuardAction = "save" | "discard" | "cancel";

export interface CloseGuardCopy {
  /** Sentence-case dialog title; `Save changes?` only when Save is offered. */
  title: string;
  /** Situation sentence, then the confirmation question. */
  lines: [string, string];
  /** Buttons to render, left to right. */
  actions: CloseGuardAction[];
}

export interface CloseGuardCopyInput {
  /** Base name of the document (single dirty document only). */
  documentName: string;
  /** How many documents have unsaved changes. */
  dirtyCount: number;
  /** Whether Save may be offered; only a single dirty document can be saved. */
  allowSave: boolean;
}

/**
 * Build the close-guard copy for one decision:
 * several dirty documents or one that cannot be saved offer Discard / Cancel;
 * a single savable document also offers Save.
 */
export function closeGuardCopy({
  documentName,
  dirtyCount,
  allowSave,
}: CloseGuardCopyInput): CloseGuardCopy {
  if (dirtyCount === 1) {
    const situation = `${documentName} has unsaved changes.`;

    if (allowSave) {
      return {
        title: "Save changes?",
        lines: [situation, "Do you want to save them before closing?"],
        actions: ["save", "discard", "cancel"],
      };
    }

    return {
      title: "Unsaved changes",
      lines: [situation, "Are you sure you want to discard them?"],
      actions: ["discard", "cancel"],
    };
  }

  return {
    title: "Unsaved changes",
    lines: [
      `${dirtyCount} documents have unsaved changes.`,
      "Are you sure you want to discard them?",
    ],
    actions: ["discard", "cancel"],
  };
}
