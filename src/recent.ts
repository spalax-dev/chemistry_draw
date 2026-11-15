/**
 * Recent-document list helpers and the localStorage adapter
 * (`docs/architecture.md` §5.9, `docs/conventions.md` §6.4).
 *
 * The list operations are pure: they never mutate their input, dedupe by the
 * exact path string and keep the newest path first, capped at `RECENT_LIMIT`.
 */

/** Maximum number of remembered documents. */
export const RECENT_LIMIT = 10;

/** `localStorage` key; a JSON array of absolute `.ket` paths. */
export const RECENT_STORAGE_KEY = "chemistry-draw.recent";

/**
 * Puts `path` at the front of `list`, removing any earlier occurrence, and
 * trims the result to `limit` entries (the oldest fall off).
 */
export function addRecent(list: string[], path: string, limit: number = RECENT_LIMIT): string[] {
  const withoutPath = list.filter((entry) => entry !== path);
  return [path, ...withoutPath].slice(0, limit);
}

/** Removes every occurrence of `path`; an unknown path leaves the list as-is. */
export function removeRecent(list: string[], path: string): string[] {
  return list.filter((entry) => entry !== path);
}

/** The visible label for a path: its base name without the last extension. */
export function recentName(path: string): string {
  const baseName = path.split(/[\\/]/).pop() ?? path;
  const dot = baseName.lastIndexOf(".");

  // `dot === 0` is a dotfile (`.ketrc`) with no extension to drop.
  return dot > 0 ? baseName.slice(0, dot) : baseName;
}

/** The browser storage, or `null` when it is unavailable or blocked. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Access can throw when storage is disabled (private mode, policy).
    return null;
  }
}

/**
 * Reads the persisted list. A missing, unreadable, malformed or non-array value
 * yields an empty list; entries are strings, deduped and capped defensively.
 */
export function loadRecent(): string[] {
  const store = storage();
  if (!store) return [];

  try {
    const raw = store.getItem(RECENT_STORAGE_KEY);
    if (raw === null) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const paths = parsed.filter((entry): entry is string => typeof entry === "string");
    return paths.filter((entry, index) => paths.indexOf(entry) === index).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Persists `paths`; an unavailable or full storage degrades silently. */
export function saveRecent(paths: string[]): void {
  const store = storage();
  if (!store) return;

  try {
    store.setItem(RECENT_STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Quota exceeded or storage disabled: the menu must never fail.
  }
}
