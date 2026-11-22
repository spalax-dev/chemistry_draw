/**
 * Pure model for the Welcome "Recent structures" table (`docs/architecture.md`
 * §5.11): size and date labels, the Indigo check mapping and the preview key.
 *
 * Nothing here touches Tauri, the DOM or Ketcher: the loader
 * (`src/recentStructures.ts`) supplies file facts and the check result, and the
 * UI only renders the labels. Keeping it pure lets Vitest pin every string.
 */

/** Badge shown in the Indigo Validation column. */
export type ValidationStatus = "valid" | "warnings" | "invalid" | "unknown";

const EM_DASH = "—";
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Renders a byte count as whole bytes below 1 KiB and as one-decimal binary
 * units above, dropping a trailing `.0` (`0 B`, `512 B`, `1 KB`, `1.5 MB`).
 * A negative, non-finite or missing value degrades to `0 B`, never `NaN` or
 * scientific notation.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  if (unit === 0) return `${Math.floor(value)} B`;
  return `${value.toFixed(1).replace(/\.0$/, "")} ${SIZE_UNITS[unit]}`;
}

/** Local midnight of the calendar day containing `time`, as epoch ms. */
function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Formats a file mtime for the Last Modified column, using the local calendar:
 * the current day as `Today, HH:MM` (24-hour, zero-padded), the previous day
 * as `Yesterday`, older days as `Mon D, YYYY` in `en-US`, and an invalid,
 * missing or future timestamp as an em dash. `now` is injected for tests.
 */
export function formatModified(mtime: number | null | undefined, now: number = Date.now()): string {
  if (mtime === null || mtime === undefined || !Number.isFinite(mtime)) return EM_DASH;

  const current = Number.isFinite(now) ? now : Date.now();
  if (mtime > current) return EM_DASH;

  const today = startOfDay(current);
  const day = startOfDay(mtime);

  if (day === today) {
    const date = new Date(mtime);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `Today, ${hours}:${minutes}`;
  }

  const todayDate = new Date(today);
  const yesterday = new Date(
    todayDate.getFullYear(),
    todayDate.getMonth(),
    todayDate.getDate() - 1,
  ).getTime();
  if (day === yesterday) return "Yesterday";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(mtime));
}

/** A single reported issue; Indigo may send strings, objects or arrays. */
type CheckIssue = string | Record<string, unknown>;

function isEmptyIssue(issue: unknown): boolean {
  return typeof issue === "string" && issue.trim().length === 0;
}

function isErrorIssue(issue: CheckIssue): boolean {
  if (typeof issue === "string") return /\berror\b/i.test(issue);

  const severity = issue.severity ?? issue.level ?? issue.type;
  return typeof severity === "string" && /error/i.test(severity);
}

/** Flattens an object's check values into a list of non-empty issues. */
function issuesFromRecord(record: Record<string, unknown>): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (key === "error") continue;

    if (Array.isArray(value)) {
      issues.push(
        ...value.filter(
          (entry): entry is CheckIssue =>
            !isEmptyIssue(entry) &&
            (typeof entry === "string" || (typeof entry === "object" && entry !== null)),
        ),
      );
    } else if (typeof value === "string") {
      if (!isEmptyIssue(value)) issues.push(value);
    } else if (typeof value === "object" && value !== null) {
      issues.push(value as Record<string, unknown>);
    }
  }

  return issues;
}

/** Maps one issue list to a status; an empty list is a pass. */
function statusFromIssues(issues: readonly CheckIssue[]): ValidationStatus {
  if (issues.length === 0) return "valid";
  return issues.some(isErrorIssue) ? "invalid" : "warnings";
}

/**
 * Normalises a `structService.check` result into the badge status. An empty
 * array or object is `valid`; a non-empty result is `warnings` unless an entry
 * carries an error, then `invalid`. A missing, unreadable or non-JSON value is
 * `unknown` — never a pass, and a parse failure is never `invalid`.
 */
export function validationStatus(result: unknown): ValidationStatus {
  if (result === null || result === undefined) return "unknown";

  let value: unknown = result;
  if (typeof value === "string") {
    if (value.trim().length === 0) return "valid";
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return "unknown";
    }
  }

  if (Array.isArray(value)) {
    return statusFromIssues(
      value.filter(
        (entry): entry is CheckIssue =>
          !isEmptyIssue(entry) &&
          (typeof entry === "string" || (typeof entry === "object" && entry !== null)),
      ),
    );
  }

  if (typeof value !== "object") return "unknown";

  const record = value as Record<string, unknown>;
  const error = record.error;
  if (error !== undefined && error !== null && error !== false && error !== "") {
    return "invalid";
  }

  return statusFromIssues(issuesFromRecord(record));
}

/** The cache file name for a content hash: `<hash>.svg`. */
export function previewFileName(hash: string): string {
  return `${hash}.svg`;
}

function subtleCrypto(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** Lower-case hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 of the UTF-8 text as lower-case hex. The preview cache is keyed by
 * this value, so the same content reuses one file and an edit produces a new
 * one.
 */
export async function contentHash(text: string): Promise<string> {
  const digest = await subtleCrypto().digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}
