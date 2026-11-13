/**
 * Recognition and editor error unwrapping and copy for the in-app dialog.
 *
 * Ketcher's `RemoteStructService` throws `new Error(JSON.stringify(response))`
 * for a `FAILURE` job, so the editor's `errorHandler` receives either the
 * stringified `{"state":"FAILURE","error":"…"}` body (sometimes wrapped as
 * `Error: {…}`) or plain text. These helpers turn that into the Ketcher-styled
 * `ErrorDialog` title and copy; `errorMessage` exposes the raw message for the
 * document workflow, which keeps its own copy. The UI never echoes raw JSON.
 * Pure module: no Tauri, no DOM, no React (`docs/testing.md` §6.1).
 */

/**
 * Substring → friendly copy for errors surfaced by Ketcher or the sidecar.
 *
 * Recognize Molecule failures arrive as the stringified `FAILURE` body
 * (`{"state":"FAILURE","error":"…"}`), so these keys are substrings of the
 * documented sidecar messages, not whole strings. The copy is UI-owned: it
 * must never echo the raw JSON.
 */
export const SIMPLE_ERRORS: Record<string, string> = {
  "No molecule was detected in this image.":
    "No chemical structure was detected in this image. Try a clear image of one drawn molecule, or draw the structure in the editor.",
  "The structure could not be read confidently.":
    "The structure could not be read confidently. Try a sharper or larger image of one molecule.",
  "Recognition models are not available.":
    "Molecule recognition is not set up. Check that the image-classifier and OCSR models are installed (see CHEMISTRY_MODELS_DIR) and restart the app.",
  "The recognized structure could not be prepared for the editor.":
    "The structure was recognized but could not be prepared for the editor. Please try again.",
  "Unsupported image. Use a PNG, JPEG or WebP file.":
    "This image cannot be used. Choose a PNG, JPEG or WebP file.",
  "unsupported image content type":
    "This image format is not supported. Choose a PNG, JPEG or WebP file.",
  "Recognition timed out. Try again.": "Recognition took too long. Please try again.",
  "unknown recognition job":
    "The recognition result expired before it reached the editor. Please try again.",
  // An over-cap upload is `413` with a plain-text body (axum's body limit, not
  // `{ "error": … }`), so Ketcher's `response.json()` throws a parse error.
  "Unexpected token": "The server could not process the image. It may be too large.",
  "is not valid JSON": "The server could not process the image. It may be too large.",
  "JSON Parse error": "The server could not process the image. It may be too large.",
  "Failed to buffer the request body":
    "The server could not process the image. It may be too large.",
  "already have edge between vertices":
    "The structure contains duplicate bonds. Please remove overlapping bonds and try again.",
  "Indigo load error":
    "Cannot read the structure. The data may be corrupted or in an unsupported format.",
  "Load failed": "The chemistry server is not responding. Restart the app or check the connection.",
  "Connection terminated unexpectedly":
    "The chemistry server stopped unexpectedly. Restart the app.",
};

/** Fallback copy for a structured failure with no recognized detail. */
export const GENERIC_FAILURE = "Recognition failed. Please try again.";

/**
 * Unwraps Ketcher's stringified error body.
 *
 * `RemoteStructService` throws `new Error(JSON.stringify(response))` for a
 * `FAILURE` job, and the editor either reports `error.message` or the error
 * object (whose `String()` is `Error: {…}`). Returns the inner
 * `error`/`message` text and whether the input carried a JSON body.
 *
 * A JSON object without a usable `error`/`message` still counts as JSON: the
 * structured protocol failed, so the caller shows the generic failure instead
 * of echoing raw JSON. Only non-JSON text falls back to the plain message.
 */
export function unwrapError(msg: string): { detail: string; json: boolean } {
  const trimmed = msg.trim().replace(/^Error:\s*/, "");
  if (!trimmed.startsWith("{")) return { detail: trimmed, json: false };

  try {
    const body: unknown = JSON.parse(trimmed);
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const detail = record.error ?? record.message;
      return { detail: typeof detail === "string" ? detail : "", json: true };
    }
  } catch {
    // Not JSON: fall back to the plain message.
  }

  return { detail: trimmed, json: false };
}

/** Returns friendly copy for an already-unwrapped message, or `""`. */
export function friendly(detail: string): string {
  for (const [key, hint] of Object.entries(SIMPLE_ERRORS)) {
    if (detail.includes(key)) return hint;
  }
  return "";
}

/** Returns an `Error`'s message, or the string form of any other thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns any editor error into the in-app dialog title and copy.
 *
 * A documented failure or any parsed JSON body is a `Structure problem`;
 * unknown JSON gets `GENERIC_FAILURE` so raw JSON is never shown, and plain
 * text with no known hint keeps its own message under the `Error` title.
 */
export function describeError(raw: unknown): { title: string; message: string } {
  const text = errorMessage(raw);
  const { detail, json } = unwrapError(text);
  const hint = friendly(detail);

  if (hint !== "") return { title: "Structure problem", message: hint };
  if (json) return { title: "Structure problem", message: GENERIC_FAILURE };
  return { title: "Error", message: detail };
}
