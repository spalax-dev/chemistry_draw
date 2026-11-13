/**
 * Contract for `src/recognizeErrors.ts`, the pure error mapping behind the
 * in-app dialog.
 *
 * ```ts
 * export const GENERIC_FAILURE: string;
 * export function unwrapError(msg: string): { detail: string; json: boolean };
 * export function friendly(detail: string): string;
 * export function describeError(raw: unknown): { title: string; message: string };
 * export function errorMessage(error: unknown): string;
 * ```
 *
 * `unwrapError` strips an `Error: ` prefix, parses a stringified `FAILURE`
 * body and returns its `error`/`message` string; `json` is `true` only when a
 * JSON body parsed. `friendly` maps a documented sidecar hint to the UI copy
 * and returns `""` for anything else. `describeError` accepts a string, an
 * `Error` or any unknown value and picks the dialog title: `Structure problem`
 * for a recognized failure or any parsed JSON body, `Error` for plain text with
 * no known hint. `errorMessage` extracts the raw message for the document
 * workflow, where a document error that happens to contain a recognition hint
 * must keep its own copy. The copy is UI-owned, so tests pin the title exactly
 * and the copy by a stable substring.
 */
import { describe, expect, it } from "vitest";

import {
  describeError,
  errorMessage,
  friendly,
  GENERIC_FAILURE,
  unwrapError,
} from "./recognizeErrors";

const NO_MOLECULE = "No molecule was detected in this image.";
const LOW_CONFIDENCE = "The structure could not be read confidently.";
const TOO_LARGE = "may be too large";

/** Every documented hint must stay reachable through `friendly`. */
const FRIENDLY_HINTS: Array<[string, string]> = [
  [NO_MOLECULE, "No chemical structure was detected"],
  [LOW_CONFIDENCE, "could not be read confidently"],
  ["Recognition models are not available.", "not set up"],
  ["The recognized structure could not be prepared for the editor.", "could not be prepared"],
  ["Unsupported image. Use a PNG, JPEG or WebP file.", "PNG, JPEG or WebP"],
  ["unsupported image content type", "not supported"],
  ["Recognition timed out. Try again.", "took too long"],
  ["unknown recognition job", "expired"],
  ["Unexpected token", TOO_LARGE],
  ["is not valid JSON", TOO_LARGE],
  ["JSON Parse error", TOO_LARGE],
  ["Failed to buffer the request body", TOO_LARGE],
  ["already have edge between vertices", "duplicate bonds"],
  ["Indigo load error", "Cannot read the structure"],
  ["Load failed", "not responding"],
  ["Connection terminated unexpectedly", "stopped unexpectedly"],
];

/** The plain-text parse errors an over-cap `413` upload produces. */
const PARSE_ERRORS = [
  "Unexpected token at position 0",
  "Unexpected end of JSON input is not valid JSON",
  "JSON Parse error: Unexpected identifier",
  "Failed to buffer the request body: length limit exceeded",
];

describe("unwrapError", () => {
  it("unwraps a stringified FAILURE body with an Error: prefix", () => {
    const raw = `Error: {"state":"FAILURE","error":"${NO_MOLECULE}"}`;

    expect(unwrapError(raw)).toEqual({ detail: NO_MOLECULE, json: true });
  });

  it("unwraps a stringified FAILURE body without a prefix", () => {
    const raw = `{"state":"FAILURE","error":"${NO_MOLECULE}"}`;

    expect(unwrapError(raw)).toEqual({ detail: NO_MOLECULE, json: true });
  });

  it("uses the message field when the body has no error field", () => {
    const raw = `{"state":"FAILURE","message":"${LOW_CONFIDENCE}"}`;

    expect(unwrapError(raw)).toEqual({ detail: LOW_CONFIDENCE, json: true });
  });

  it("reports a JSON body with no usable detail as JSON with an empty detail", () => {
    expect(unwrapError('{"state":"FAILURE"}')).toEqual({ detail: "", json: true });
  });

  it("keeps plain text as the detail and reports it as non-JSON", () => {
    expect(unwrapError("boom")).toEqual({ detail: "boom", json: false });
  });

  it("keeps a plain-text recognition message as the detail", () => {
    expect(unwrapError(NO_MOLECULE)).toEqual({ detail: NO_MOLECULE, json: false });
  });
});

describe("friendly", () => {
  it.each(FRIENDLY_HINTS)("maps %s to its UI copy", (hint, copy) => {
    expect(friendly(hint)).toContain(copy);
  });

  it("returns empty copy for an unknown detail", () => {
    expect(friendly("unrelated")).toBe("");
  });
});

describe("describeError", () => {
  it("maps a stringified FAILURE body to the friendly structure-problem dialog", () => {
    const raw = `Error: {"state":"FAILURE","error":"${NO_MOLECULE}"}`;

    const { title, message } = describeError(raw);

    expect(title).toBe("Structure problem");
    expect(message).toContain("No chemical structure was detected");
    expect(message).not.toContain('"state"');
  });

  it("maps a low-confidence failure body", () => {
    const raw = `{"state":"FAILURE","error":"${LOW_CONFIDENCE}"}`;

    const { title, message } = describeError(raw);

    expect(title).toBe("Structure problem");
    expect(message).toContain("could not be read confidently");
  });

  it("maps a plain-text recognition failure to the friendly copy", () => {
    const { title, message } = describeError(NO_MOLECULE);

    expect(title).toBe("Structure problem");
    expect(message).toContain("No chemical structure was detected");
  });

  it("uses the generic failure for a JSON body without a usable detail", () => {
    const { title, message } = describeError('{"state":"FAILURE"}');

    expect(title).toBe("Structure problem");
    expect(message).toBe(GENERIC_FAILURE);
    expect(message).not.toContain('"state"');
  });

  it("defines non-empty generic copy that is not raw JSON", () => {
    expect(GENERIC_FAILURE.length).toBeGreaterThan(0);
    expect(GENERIC_FAILURE).not.toContain("{");
  });

  it("keeps plain text with no known hint under the Error title", () => {
    expect(describeError("boom")).toEqual({ title: "Error", message: "boom" });
  });

  it("reads the message of an Error instance", () => {
    const error = new Error(`{"state":"FAILURE","error":"${NO_MOLECULE}"}`);

    const { title, message } = describeError(error);

    expect(title).toBe("Structure problem");
    expect(message).toContain("No chemical structure was detected");
  });

  it("uses an Error instance's plain message", () => {
    expect(describeError(new Error("boom"))).toEqual({ title: "Error", message: "boom" });
  });

  it("stringifies a non-string, non-Error value", () => {
    expect(describeError(42)).toEqual({ title: "Error", message: "42" });
  });

  it.each(PARSE_ERRORS)("maps the plain-text parse error %s to the too-large copy", (raw) => {
    const { title, message } = describeError(raw);

    expect(title).toBe("Structure problem");
    expect(message).toContain(TOO_LARGE);
  });
});

describe("errorMessage", () => {
  it("returns an Error instance's message verbatim", () => {
    expect(errorMessage(new Error("permission denied"))).toBe("permission denied");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage(42)).toBe("42");
  });

  it("keeps a document message that contains a recognition hint", () => {
    const raw = `write failed: ${NO_MOLECULE}`;

    expect(errorMessage(new Error(raw))).toBe(raw);
  });
});
