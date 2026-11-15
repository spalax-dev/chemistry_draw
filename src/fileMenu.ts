/**
 * The File menu item model (`docs/architecture.md` §5.9,
 * `docs/conventions.md` §6.5). Rendering is driven by this fixed, ordered list;
 * `App` maps each id to the command it runs.
 */

/** Identifiers for the commands rendered above the recent section. */
export type FileMenuId = "new" | "open" | "import" | "save" | "save-as" | "export";

export interface FileMenuItem {
  id: FileMenuId;
  label: string;
}

/**
 * Fixed order and sentence-case labels. The ellipsis marks the commands that
 * open another dialog (Open, Import, Save As, Export).
 */
export const FILE_MENU_ITEMS: readonly FileMenuItem[] = [
  { id: "new", label: "New" },
  { id: "open", label: "Open…" },
  { id: "import", label: "Import…" },
  { id: "save", label: "Save" },
  { id: "save-as", label: "Save As…" },
  { id: "export", label: "Export…" },
] as const;

/** Heading above the remembered documents. */
export const RECENT_SECTION_LABEL = "Recent documents";
