/**
 * On-disk preview cache for the Welcome "Recent structures" table
 * (`docs/architecture.md` §5.11).
 *
 *   <appDataDir>/previews/<sha256>.svg
 *
 * The key is the content hash of the row's molfile, so equal content reuses one
 * SVG and an edit produces a new key. A cache miss renders the molfile through
 * `POST <apiBase>indigo/render` (the sidecar replies base64 in a text/plain
 * body) and writes the decoded SVG text. Outside Tauri the cache is inert: the
 * browser has no app-data directory and every read reports a miss.
 */

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import { previewFileName } from "./recentDetails";

/** Directory under the app-data root that holds every rendered preview. */
const PREVIEW_DIRECTORY = "previews";

/** Absolute cache path for `hash`: `<appDataDir>/previews/<hash>.svg`. */
export async function previewFilePath(hash: string): Promise<string> {
  return join(await appDataDir(), PREVIEW_DIRECTORY, previewFileName(hash));
}

/**
 * Reads the cached SVG for `hash`. A missing cache, an unreadable file or a
 * browser runtime yields `null` (a miss), never an error.
 */
export async function readCachedPreview(hash: string): Promise<string | null> {
  if (!isTauri()) return null;

  try {
    const svg = await readTextFile(await previewFilePath(hash));
    return svg.length > 0 ? svg : null;
  } catch {
    return null;
  }
}

/**
 * Writes the rendered SVG for `hash`, creating the previews directory on the
 * first miss. A browser runtime is a no-op; filesystem errors propagate so the
 * caller can fall back to the neutral placeholder.
 */
export async function writeCachedPreview(hash: string, svg: string): Promise<void> {
  if (!isTauri()) return;

  const directory = await join(await appDataDir(), PREVIEW_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeTextFile(await previewFilePath(hash), svg);
}

/** Decodes the sidecar's base64 body into UTF-8 SVG text. */
function decodeBase64Utf8(encoded: string): string | null {
  try {
    const binary = atob(encoded.trim());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const svg = new TextDecoder().decode(bytes);
    return svg.length > 0 ? svg : null;
  } catch {
    return null;
  }
}

/**
 * Renders `molfile` to SVG through the sidecar. Returns the SVG text from the
 * base64 `text/plain` body, or `null` on a non-200 response, a network failure
 * or a body that cannot be decoded.
 */
export async function renderStructurePreview(
  apiBase: string,
  molfile: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${apiBase}indigo/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        struct: molfile,
        options: { "render-output-format": "svg" },
      }),
    });

    if (!response.ok) return null;

    return decodeBase64Utf8(await response.text());
  } catch {
    return null;
  }
}
