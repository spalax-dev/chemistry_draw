import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_INTERVAL_MS,
  createAutosaveScheduler,
  createWriteGeneration,
  parseAutosaveMeta,
  shouldOfferRecovery,
  type AutosaveMeta,
} from "./autosave";

const SAVED_AT = 1_700_000_100_000;

function meta(overrides: Partial<AutosaveMeta> = {}): AutosaveMeta {
  return {
    path: "/home/jorge/Documents/benzene.ket",
    savedAt: SAVED_AT,
    dirty: true,
    ...overrides,
  };
}

describe("autosave scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SAVED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 2 s debounce and a 30 s interval", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(2000);
    expect(AUTOSAVE_INTERVAL_MS).toBe(30_000);
  });

  it("coalesces rapid edits into one debounced write", () => {
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => true, write });

    scheduler.start();
    scheduler.notifyChange();
    vi.advanceTimersByTime(1500);
    scheduler.notifyChange();
    vi.advanceTimersByTime(1999);

    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("writes on the slow interval only while dirty", () => {
    let dirty = false;
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => dirty, write });

    scheduler.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(write).not.toHaveBeenCalled();

    dirty = true;
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(write).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("never writes while the document is clean", () => {
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => false, write });

    scheduler.start();
    scheduler.notifyChange();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);

    expect(write).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("skips a pending debounced write when the document became clean", () => {
    let dirty = true;
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => dirty, write });

    scheduler.start();
    scheduler.notifyChange();
    vi.advanceTimersByTime(1000);
    dirty = false;
    vi.advanceTimersByTime(1000);

    expect(write).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("resets the interval after a debounced write", () => {
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => true, write });

    scheduler.start();
    scheduler.notifyChange();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS - 1);
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("re-arms the debounce after a write", () => {
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => true, write });

    scheduler.start();
    scheduler.notifyChange();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    scheduler.notifyChange();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("stops writing once stopped", () => {
    const write = vi.fn();
    const scheduler = createAutosaveScheduler({ isDirty: () => true, write });

    scheduler.start();
    scheduler.notifyChange();
    scheduler.stop();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);

    expect(write).not.toHaveBeenCalled();
  });
});

describe("autosave metadata", () => {
  it("parses a complete metadata record", () => {
    const raw = JSON.stringify({
      path: "/home/jorge/Documents/benzene.ket",
      savedAt: SAVED_AT,
      dirty: true,
    });

    expect(parseAutosaveMeta(raw)).toEqual({
      path: "/home/jorge/Documents/benzene.ket",
      savedAt: SAVED_AT,
      dirty: true,
    });
  });

  it("accepts metadata without an original path", () => {
    const raw = JSON.stringify({ path: null, savedAt: SAVED_AT, dirty: true });

    expect(parseAutosaveMeta(raw)).toEqual({ path: null, savedAt: SAVED_AT, dirty: true });
  });

  it("returns null for missing, empty or invalid JSON", () => {
    expect(parseAutosaveMeta(null)).toBeNull();
    expect(parseAutosaveMeta("")).toBeNull();
    expect(parseAutosaveMeta("{not json")).toBeNull();
  });

  it("returns null when a field is missing or has the wrong type", () => {
    expect(parseAutosaveMeta(JSON.stringify({ savedAt: SAVED_AT, dirty: true }))).toBeNull();
    expect(
      parseAutosaveMeta(JSON.stringify({ path: 7, savedAt: SAVED_AT, dirty: true })),
    ).toBeNull();
    expect(
      parseAutosaveMeta(JSON.stringify({ path: null, savedAt: "now", dirty: true })),
    ).toBeNull();
    expect(
      parseAutosaveMeta(JSON.stringify({ path: null, savedAt: SAVED_AT, dirty: "yes" })),
    ).toBeNull();
  });
});

describe("recovery decision", () => {
  const lastCleanSave = SAVED_AT - 60_000;

  it("does not offer recovery without metadata", () => {
    expect(shouldOfferRecovery(null, lastCleanSave)).toBe(false);
  });

  it("does not offer recovery for a clean snapshot", () => {
    expect(shouldOfferRecovery(meta({ dirty: false }), lastCleanSave)).toBe(false);
  });

  it("does not offer recovery when the snapshot is older than the last clean save", () => {
    expect(shouldOfferRecovery(meta({ savedAt: lastCleanSave - 1 }), lastCleanSave)).toBe(false);
  });

  it("does not offer recovery when the snapshot matches the last clean save", () => {
    expect(shouldOfferRecovery(meta({ savedAt: lastCleanSave }), lastCleanSave)).toBe(false);
  });

  it("offers recovery when the snapshot is newer than the last clean save", () => {
    expect(shouldOfferRecovery(meta({ savedAt: lastCleanSave + 1 }), lastCleanSave)).toBe(true);
  });

  it("always offers recovery when the original path is unknown", () => {
    expect(shouldOfferRecovery(meta({ path: null }), lastCleanSave)).toBe(true);
    expect(shouldOfferRecovery(meta({ path: null, savedAt: 0 }), lastCleanSave)).toBe(true);
  });

  it("offers recovery when the original file is missing or unreadable", () => {
    // No mtime means there is no evidence of a clean save: the snapshot is the
    // only remaining copy, so dropping it would lose the user's work.
    expect(shouldOfferRecovery(meta({ savedAt: lastCleanSave - 60_000 }), null)).toBe(true);
  });

  it("does not offer recovery when the metadata is unreadable", () => {
    const parsed = parseAutosaveMeta("{path:");

    expect(parsed).toBeNull();
    expect(shouldOfferRecovery(parsed, lastCleanSave)).toBe(false);
  });
});

describe("snapshot write generation", () => {
  it("cancels a write that started before a cleanup", () => {
    const generation = createWriteGeneration();
    const inFlight = generation.begin();

    expect(generation.isCurrent(inFlight)).toBe(true);

    generation.invalidate();

    expect(generation.isCurrent(inFlight)).toBe(false);
  });

  it("lets a write started after a cleanup commit", () => {
    const generation = createWriteGeneration();
    generation.invalidate();

    const next = generation.begin();
    expect(generation.isCurrent(next)).toBe(true);

    generation.invalidate();
    expect(generation.isCurrent(next)).toBe(false);
  });

  it("keeps earlier generation tokens stale across several invalidations", () => {
    const generation = createWriteGeneration();
    const first = generation.begin();
    generation.invalidate();
    const second = generation.begin();
    generation.invalidate();
    const third = generation.begin();

    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(false);
    expect(generation.isCurrent(third)).toBe(true);
  });
});
