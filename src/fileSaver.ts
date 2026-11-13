import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";

const BINARY_EXTS = new Set(["png", "jpeg", "jpg", "gif", "bmp", "pdf", "cdx"]);

/** Receives the blob Ketcher asked to save; expected to route it. */
export type FileSaverHandler = (blob: Blob, filename: string) => void | Promise<void>;

/** Reports a failed save without throwing back into Ketcher. */
export type FileSaverErrorReporter = (error: unknown) => void;

export interface FileSaverRegistration {
  handle: FileSaverHandler;
  onError?: FileSaverErrorReporter;
}

let registration: FileSaverRegistration | null = null;

/** Registers the handler the aliased `saveAs` delegates to under Tauri. */
export function registerFileSaver(next: FileSaverRegistration): void {
  registration = next;
}

/** Clears the registration, so `saveAs` falls back to a browser download. */
export function resetFileSaver(): void {
  registration = null;
}

/** Whether a saver handler is currently registered. */
export function hasFileSaverHandler(): boolean {
  return registration !== null;
}

function isTextMime(mime: string): boolean {
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "image/svg+xml" ||
    mime === "application/xml"
  )
    return true;
  if (mime.startsWith("chemical/")) return true;
  return false;
}

/** Browser fallback for environments without the Tauri APIs. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Overwrites an already chosen path with UTF-8 text. Save uses this so a
 * document with a path never asks for a destination again.
 */
export async function writeTextFileAt(path: string, text: string): Promise<void> {
  await writeTextFile(path, text);
}

/**
 * Saves a blob through the Tauri dialog and filesystem. Outside Tauri it
 * downloads instead. A real write failure is rethrown so the caller can show
 * it: reporting a failed write as a successful download would lose data.
 */
export async function saveBlobAs(blob: Blob, name: string): Promise<void> {
  const ext = name.split(".").pop() ?? "";

  if (!isTauri()) {
    download(blob, name);
    return;
  }

  const filePath = await save({
    defaultPath: name,
    filters: [{ name: `${ext.toUpperCase()} Files`, extensions: [ext] }],
  });
  if (!filePath) return;

  if (!BINARY_EXTS.has(ext) && isTextMime(blob.type)) {
    await writeTextFile(filePath, await blob.text());
  } else {
    await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
  }
}

/**
 * The `file-saver` alias target: Ketcher's native Save As and image save call
 * this. Under Tauri with a registered handler the blob is routed by format;
 * anywhere else it downloads. A handler failure is reported, never thrown into
 * Ketcher and never disguised as a successful download.
 */
export async function saveAs(
  blobOrUrl: Blob | string,
  filename?: string,
  _opts?: { autoBom?: boolean },
): Promise<void> {
  if (typeof blobOrUrl === "string") {
    const a = document.createElement("a");
    a.href = blobOrUrl;
    a.download = filename || "download";
    a.click();
    return;
  }

  const name = filename || "download";

  if (isTauri() && registration !== null) {
    try {
      await registration.handle(blobOrUrl, name);
    } catch (error) {
      if (registration.onError) registration.onError(error);
      else console.error("[chemistry-draw] could not save the file:", error);
    }
    return;
  }

  download(blobOrUrl, name);
}
