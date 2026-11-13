/**
 * Pure routing of a saved blob: decides whether it belongs to the document
 * (`.ket`), to an export file, or to a plain browser download. No Tauri, no
 * DOM, no React, so Vitest exercises it directly.
 */

import type { DocumentState } from "./document";

/** What the running environment can do with a saved blob. */
export interface SaveRouteEnvironment {
  /** True under Tauri, where a dialog and the filesystem are available. */
  desktop: boolean;
  /** True when the app registered a saver handler. */
  hasHandler: boolean;
}

/** Where a saved blob goes. */
export type SaveRoute =
  | { kind: "document-save"; path: string | null; defaultName: string }
  | { kind: "export-save"; defaultName: string }
  | { kind: "download"; defaultName: string };

const KET_EXTENSION = "ket";
const UNTITLED_NAME = "untitled.ket";

/**
 * Routes a blob Ketcher asked to save. Only `.ket` (any case) touches the
 * document; every other extension is an export. Without Tauri or without a
 * registered handler there is no writable path, so the blob is downloaded.
 */
export function routeSavedBlob(
  filename: string,
  state: DocumentState,
  env: SaveRouteEnvironment,
): SaveRoute {
  const isDocument = extensionOf(filename) === KET_EXTENSION;
  const defaultName = isDocument ? documentFileName(state) : filename;

  if (!env.desktop || !env.hasHandler) return { kind: "download", defaultName };
  if (!isDocument) return { kind: "export-save", defaultName };

  return { kind: "document-save", path: state.path, defaultName };
}

/** Lowercase extension without the dot, or `null` when there is none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : name.slice(dot + 1).toLowerCase();
}

/** File name of the current document, including its `.ket` extension. */
function documentFileName(state: DocumentState): string {
  if (state.path === null) return UNTITLED_NAME;
  const segments = state.path.split(/[\\/]/);
  return segments[segments.length - 1] || state.path;
}
