/**
 * Autosave scheduling and the pure snapshot helpers shared with the per-tab
 * store. Pure and injectable: the caller supplies the dirty check and the write
 * function (the real one comes from Tauri), so this module imports neither Tauri
 * nor the DOM.
 *
 * There is no single-document recovery path. `src/tabStore.ts` owns the snapshot
 * files under `<appDataDir>/recovery/tabs/` and is the only writer and reader;
 * this module contributes the debounce scheduler, the metadata parser and the
 * write-generation guard.
 */

/** Debounce after the last editor change. */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

/** Slow safety-net interval; it only writes while the document is dirty. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** The metadata base every tab snapshot commits after its `.ket` file. */
export interface AutosaveMeta {
  /** Path of the tab's original file, `null` when it was never saved. */
  path: string | null;
  /** Epoch milliseconds of the snapshot. */
  savedAt: number;
  /** Whether the tab had unsaved edits when snapshotted. */
  dirty: boolean;
}

export interface AutosaveSchedulerOptions {
  /** Evaluated at write time, so a save in between cancels the write. */
  isDirty: () => boolean;
  write: () => void;
}

export interface AutosaveScheduler {
  /** Starts the slow interval; safe to call once. */
  start: () => void;
  /** Cancels every pending timer. */
  stop: () => void;
  /** Signals an editor change; (re)arms the debounce. */
  notifyChange: () => void;
}

/**
 * Creates the autosave timers. Rapid edits coalesce into one debounced write;
 * the slow interval covers changes the debounce never sees. Both check
 * `isDirty` when they fire, and a write re-arms the interval so the safety net
 * measures from the last snapshot.
 */
export function createAutosaveScheduler({
  isDirty,
  write,
}: AutosaveSchedulerOptions): AutosaveScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearIntervalTimer(): void {
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function armInterval(): void {
    clearIntervalTimer();
    intervalTimer = setInterval(() => {
      if (!running) return;
      if (isDirty()) write();
    }, AUTOSAVE_INTERVAL_MS);
  }

  function onDebounce(): void {
    debounceTimer = null;
    if (!running || !isDirty()) return;
    write();
    armInterval();
  }

  return {
    start() {
      if (running) return;
      running = true;
      armInterval();
    },
    stop() {
      running = false;
      clearDebounce();
      clearIntervalTimer();
    },
    notifyChange() {
      if (!running) return;
      clearDebounce();
      debounceTimer = setTimeout(onDebounce, AUTOSAVE_DEBOUNCE_MS);
    },
  };
}

/**
 * Reads a snapshot metadata record (`<id>.json` for a tab). Returns `null` for
 * missing, empty, malformed or incomplete records, so a `.ket` without valid
 * metadata is never restored. Extra fields, such as a tab's `name`, are ignored
 * here and parsed by their owner.
 */
export function parseAutosaveMeta(raw: string | null | undefined): AutosaveMeta | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const path = record.path;
  const savedAt = record.savedAt;
  const dirty = record.dirty;

  if (path !== null && typeof path !== "string") return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof dirty !== "boolean") return null;

  return { path, savedAt, dirty };
}

/** Token guarding one snapshot write against a later cleanup. */
export interface WriteGeneration {
  /** Starts a write and returns the token it must present before each commit. */
  begin: () => number;
  /** Makes every write that started before this call stale. */
  invalidate: () => void;
  /** Whether `token` still belongs to the latest generation. */
  isCurrent: (token: number) => boolean;
}

/**
 * Monotonic counter shared by a snapshot writer and its cleanup
 * (`clearTabSnapshot` in `tabStore.ts`).
 *
 * A write records the generation it started in; the cleanup advances it, so a
 * write that was already in flight cannot recreate a tab's `.ket` or `.json`
 * after that tab was saved, closed or discarded.
 */
export function createWriteGeneration(): WriteGeneration {
  let generation = 0;

  return {
    begin: () => generation,
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}
