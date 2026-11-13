/**
 * Pure document model: state, titles and the decisions behind Save, Export and
 * the close guard. No React, no Tauri, no DOM access, so Vitest can exercise
 * it directly.
 */

export type DocumentFormat = "ket";

export interface DocumentState {
  /** User-chosen `.ket` file, or `null` when the document was never saved. */
  path: string | null;
  /** The only format Save ever writes. */
  format: DocumentFormat;
  /** Unsaved edits since the last save, open or new. */
  dirty: boolean;
}

export type ExportFormat = "v2000" | "v3000" | "smiles" | "inchi" | "svg" | "png";

export type ExportSource = "getMolfile" | "getSmiles" | "getInchi" | "generateImage";

export interface SaveRequest {
  path: string;
  format: DocumentFormat;
  extension: ".ket";
  source: "getKet";
}

export interface ExportRequest {
  format: ExportFormat;
  source: ExportSource;
  /** Argument passed to the Ketcher source, or `null` when it takes none. */
  argument: string | null;
  extension: string;
}

export type CloseChoice = "save" | "discard" | "cancel";

export type CloseGuardAction = "close" | "prompt" | "stay" | "discard" | "save" | "save-as";

export interface CloseGuardDecision {
  action: CloseGuardAction;
}

export type SaveOutcome = "saved" | "cancelled" | "failed";

const KET_EXTENSION = ".ket";
const DEFAULT_SAVE_NAME = "untitled.ket";

const EXPORT_REQUESTS: Record<ExportFormat, ExportRequest> = {
  v2000: { format: "v2000", source: "getMolfile", argument: "v2000", extension: ".mol" },
  v3000: { format: "v3000", source: "getMolfile", argument: "v3000", extension: ".mol" },
  smiles: { format: "smiles", source: "getSmiles", argument: null, extension: ".smi" },
  inchi: { format: "inchi", source: "getInchi", argument: null, extension: ".inchi" },
  svg: { format: "svg", source: "generateImage", argument: "svg", extension: ".svg" },
  png: { format: "png", source: "generateImage", argument: "png", extension: ".png" },
};

/** A fresh, clean document with no path. */
export function newDocument(): DocumentState {
  return { path: null, format: "ket", dirty: false };
}

/** A clean document backed by an existing `.ket` file. */
export function openDocument(path: string): DocumentState {
  return { path, format: "ket", dirty: false };
}

/** Marks the document as having unsaved edits. */
export function markDirty(state: DocumentState): DocumentState {
  return { ...state, dirty: true };
}

/** Records a successful save to `path`: the document becomes clean there. */
export function applySaved(state: DocumentState, path: string): DocumentState {
  return { ...state, path, dirty: false };
}

/** File name without directory or extension, plus `*` while dirty. */
export function documentTitle(state: DocumentState): string {
  const base = state.path === null ? "Untitled" : baseName(state.path);
  return state.dirty ? `${base}*` : base;
}

/** The document name used in dialog copy: base name, or `Untitled`. */
export function documentName(path: string | null): string {
  return path === null ? "Untitled" : baseName(path);
}

/** Export file name: the document base name plus the format extension. */
export function exportFileName(path: string | null, extension: string): string {
  return path === null ? `untitled${extension}` : `${baseName(path)}${extension}`;
}

/** Where Save writes: the current path, or the default for a new document. */
export function saveTarget(state: DocumentState): string {
  return state.path ?? DEFAULT_SAVE_NAME;
}

/** Save As target: keeps `.ket`, appending it when the extension is missing. */
export function saveAsTarget(path: string): string {
  return /\.ket$/i.test(path) ? path : `${path}${KET_EXTENSION}`;
}

/** The `.ket` write behind Save. */
export function saveRequest(state: DocumentState): SaveRequest {
  return {
    path: saveTarget(state),
    format: "ket",
    extension: KET_EXTENSION,
    source: "getKet",
  };
}

/** Maps an export format to its Ketcher source, argument and file extension. */
export function exportRequest(format: ExportFormat): ExportRequest {
  return { ...EXPORT_REQUESTS[format] };
}

/**
 * Runs an export: it writes a separate file and never changes the document
 * path, format or dirty flag.
 */
export function applyExport(
  state: DocumentState,
  format: ExportFormat,
): { state: DocumentState; request: ExportRequest } {
  return { state, request: exportRequest(format) };
}

/**
 * Decides what a close request does. `choice` is `null` while the user has not
 * answered the Save / Discard / Cancel prompt.
 */
export function decideCloseGuard(
  state: DocumentState,
  choice: CloseChoice | null,
): CloseGuardDecision {
  if (!state.dirty) return { action: "close" };
  if (choice === null) return { action: "prompt" };
  if (choice === "cancel") return { action: "stay" };
  if (choice === "discard") return { action: "discard" };
  return { action: state.path === null ? "save-as" : "save" };
}

/** A close may proceed only after the save actually succeeded. */
export function closeAfterSave(result: SaveOutcome): "close" | "stay" {
  return result === "saved" ? "close" : "stay";
}

/** Last path segment, on both POSIX (`/`) and Windows (`\`) separators. */
function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  const name = segments[segments.length - 1] || path;
  return name.toLowerCase().endsWith(KET_EXTENSION) ? name.slice(0, -KET_EXTENSION.length) : name;
}
