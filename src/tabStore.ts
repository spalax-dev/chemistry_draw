/**
 * Tauri I/O for per-tab recovery snapshots. This is the only place that touches
 * `recovery/tabs/`; the tab semantics stay pure in `tabs.ts`.
 *
 *   <appDataDir>/recovery/tabs/<id>.ket    working structure (.ket text)
 *   <appDataDir>/recovery/tabs/<id>.json   { name, path, savedAt, dirty }
 *   <appDataDir>/recovery/tabs/index.json  { order: id[], activeId }
 *
 * Each tab's metadata is written last (commit record) and removed first (so an
 * interrupted cleanup cannot resurrect a stale snapshot). `index.json` is
 * written after the structural change it describes, so it never names a tab
 * whose files are missing. Outside Tauri every function is a no-op: the browser
 * has no recovery directory.
 */

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";

import {
  createClearedTabs,
  createSerialQueue,
  createWriteGeneration,
  parseAutosaveMeta,
  type AutosaveMeta,
} from "./autosave";
import { isKetDocument, pathBaseName, pathKey, type TabState } from "./tabs";

/** The `{ name, path, savedAt, dirty }` record committed after a tab's structure. */
export interface TabSnapshotMeta extends AutosaveMeta {
  /** Display name of a path-less imported tab; `null` when it has none. */
  name: string | null;
}

/** `index.json`: the strip order and the tab the editor showed. */
export interface TabIndex {
  order: string[];
  activeId: string;
}

/** A tab set read back from disk, ready to be restored silently. */
export interface RestoredTabSet {
  tabs: TabState[];
  activeId: string;
}

interface TabsPaths {
  directory: string;
  index: string;
  indexPartial: string;
}

interface TabPaths {
  directory: string;
  structure: string;
  partial: string;
  metadata: string;
}

const RECOVERY_DIRECTORY = "recovery";
const TABS_DIRECTORY = "tabs";
const KET_FILE = ".ket";
const PARTIAL_FILE = ".ket.part";
const METADATA_FILE = ".json";
const INDEX_FILE = "index.json";
const INDEX_PARTIAL_FILE = "index.json.part";

/**
 * A tab id names files directly, so it must stay a flat, path-safe token:
 * letters, digits, `_` and `-`. The app generates `tab-<n>` ids; a crafted id
 * (`../index`, `/etc/passwd`) is rejected instead of escaping the directory.
 */
const SAFE_TAB_ID = /^[A-Za-z0-9_-]+$/;

/** Shared with `clearTabSnapshot`; see `createWriteGeneration`. */
const writeGenerations = new Map<string, ReturnType<typeof createWriteGeneration>>();

/** One FIFO queue per tab id, so a write and its cleanup never interleave. */
const tabQueues = new Map<string, ReturnType<typeof createSerialQueue>>();

/** Cleared tab ids stay un-writable, so a late flush cannot resurrect them. */
const clearedTabs = createClearedTabs();

/** Serializes `index.json` mutations: the last submitted state wins. */
const indexQueue = createSerialQueue();

/** Guards `index.json` writes against a cleanup that started earlier. */
const indexGeneration = createWriteGeneration();

/** Whether an id may name a tab's snapshot files. */
export function isSafeTabId(id: string): boolean {
  return SAFE_TAB_ID.test(id);
}

/** The generation guarding one tab's writes; created on first use. */
function generationFor(id: string): ReturnType<typeof createWriteGeneration> {
  const existing = writeGenerations.get(id);
  if (existing !== undefined) return existing;

  const created = createWriteGeneration();
  writeGenerations.set(id, created);
  return created;
}

/** The serial queue guarding one tab's writes and cleanup; created on first use. */
function queueFor(id: string): ReturnType<typeof createSerialQueue> {
  const existing = tabQueues.get(id);
  if (existing !== undefined) return existing;

  const created = createSerialQueue();
  tabQueues.set(id, created);
  return created;
}

async function tabsPaths(): Promise<TabsPaths> {
  const directory = await join(await appDataDir(), RECOVERY_DIRECTORY, TABS_DIRECTORY);
  return {
    directory,
    index: await join(directory, INDEX_FILE),
    indexPartial: await join(directory, INDEX_PARTIAL_FILE),
  };
}

async function tabPaths(id: string): Promise<TabPaths> {
  const paths = await tabsPaths();
  return {
    directory: paths.directory,
    structure: await join(paths.directory, `${id}${KET_FILE}`),
    partial: await join(paths.directory, `${id}${PARTIAL_FILE}`),
    metadata: await join(paths.directory, `${id}${METADATA_FILE}`),
  };
}

/**
 * Writes one tab's snapshot: the `.ket` text first, then the metadata as the
 * last step. The structure goes through `<id>.ket.part` and is renamed over the
 * previous snapshot so a half-written file is never read back.
 *
 * A cleanup (`clearTabSnapshot`) advances that tab's generation, so a write that
 * started earlier stops before its next commit step and removes anything it
 * created. An unsafe id is ignored rather than joined into a path.
 */
export function writeTabSnapshot(tab: TabState, savedAt: number): Promise<void> {
  if (!isTauri() || !isSafeTabId(tab.id) || clearedTabs.has(tab.id)) return Promise.resolve();

  // The per-tab queue keeps this write and any cleanup for the same tab from
  // interleaving, so no step can delete files a newer write committed.
  return queueFor(tab.id).run(async () => {
    // Re-check inside the queue: a clear submitted between the call and this
    // task must still win, even though the entry check saw it as writable.
    if (clearedTabs.has(tab.id)) return;

    const generation = generationFor(tab.id);
    const token = generation.begin();
    const paths = await tabPaths(tab.id);
    if (!generation.isCurrent(token)) return;

    await mkdir(paths.directory, { recursive: true });
    if (!generation.isCurrent(token)) return;

    await writeTextFile(paths.partial, tab.ket);
    if (!generation.isCurrent(token)) {
      await removeIfPresent(paths.partial);
      return;
    }

    await rename(paths.partial, paths.structure);
    if (!generation.isCurrent(token)) {
      // The write is stale: it owns the files it just committed (the queue
      // serializes writers), so undo only its own output.
      await removeIfPresent(paths.structure);
      return;
    }

    const meta: TabSnapshotMeta = {
      name: tab.name,
      path: tab.path,
      savedAt,
      dirty: tab.dirty,
    };
    await writeTextFile(paths.metadata, JSON.stringify(meta));

    if (!generation.isCurrent(token)) {
      await removeIfPresent(paths.metadata);
      await removeIfPresent(paths.structure);
      await removeIfPresent(paths.partial);
    }
  });
}

/**
 * Deletes one tab's snapshot and invalidates every write for it already in
 * flight: metadata first, then the structure, so a crash in between cannot
 * leave restorable metadata behind.
 */
export function clearTabSnapshot(id: string): Promise<void> {
  if (!isTauri() || !isSafeTabId(id)) return Promise.resolve();

  return queueFor(id).run(async () => {
    clearedTabs.mark(id);
    generationFor(id).invalidate();
    indexGeneration.invalidate();
    const paths = await tabPaths(id);
    await removeIfPresent(paths.metadata);
    await removeIfPresent(paths.structure);
    await removeIfPresent(paths.partial);
  });
}

/**
 * Discard cleanup for a window close: delete only the **dirty** tabs'
 * snapshots and rewrite `index.json` with the surviving clean tabs, so a clean
 * close still restores everything the user kept. With no survivors the index
 * is written empty, which restore reads as "start with one empty tab".
 */
export async function clearDirtyTabSnapshots(
  dirtyIds: string[],
  survivors: string[],
  activeId: string,
): Promise<void> {
  for (const id of dirtyIds) {
    await clearTabSnapshot(id);
  }

  // Drain everything submitted before this point: a write already queued has
  // finished (or been refused by the tombstone), so the survivors index below
  // is the last write and cannot be overwritten by a stale tab flush.
  await Promise.all([...tabQueues.values()].map((queue) => queue.idle()));
  await indexQueue.idle();

  const nextActive = survivors.includes(activeId) ? activeId : (survivors[0] ?? activeId);
  await writeTabIndex(survivors, nextActive);
}

/**
 * Reads the tab set back. Returns `null` when there is no usable index or no
 * listed tab survives; tabs whose metadata or structure is missing or
 * unreadable are dropped, and the restore never throws.
 */
export async function readTabSet(): Promise<RestoredTabSet | null> {
  if (!isTauri()) return null;

  try {
    const paths = await tabsPaths();
    const index = parseTabIndex(await readTextFile(paths.index));
    if (index === null) return null;

    const tabs: TabState[] = [];
    const seen = new Set<string>();
    for (const id of index.order) {
      if (seen.has(id)) continue;
      seen.add(id);

      const tab = await readTab(id);
      if (tab !== null) tabs.push(tab);
    }

    if (tabs.length === 0) return null;

    // A set written before the guard existed can hold two tabs on one path:
    // keep the first and drop later duplicates, then pick a surviving active.
    const unique: TabState[] = [];
    const seenPaths = new Set<string>();
    for (const tab of tabs) {
      if (tab.path !== null) {
        const key = pathKey(tab.path);
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
      }
      unique.push(tab);
    }

    if (unique.length === 0) return null;

    const activeId = unique.some((tab) => tab.id === index.activeId)
      ? index.activeId
      : unique[0].id;
    return { tabs: unique, activeId };
  } catch {
    return null;
  }
}

/**
 * Writes `index.json` through a partial file and a rename. Call it after every
 * structural change (create, close, activate, path change), once the tab files
 * it names are on disk.
 */
export function writeTabIndex(order: string[], activeId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();

  // FIFO queue: the last submitted state wins. A writer that became stale
  // removes only its own `.part` and never the index another writer committed.
  return indexQueue.run(async () => {
    const token = indexGeneration.begin();
    const paths = await tabsPaths();
    if (!indexGeneration.isCurrent(token)) return;

    await mkdir(paths.directory, { recursive: true });
    if (!indexGeneration.isCurrent(token)) return;

    const index: TabIndex = { order, activeId };
    await writeTextFile(paths.indexPartial, JSON.stringify(index));
    if (!indexGeneration.isCurrent(token)) {
      await removeIfPresent(paths.indexPartial);
      return;
    }

    await rename(paths.indexPartial, paths.index);
  });
}

/** Reads one tab; a bad id, metadata or structure drops it. */
async function readTab(id: string): Promise<TabState | null> {
  if (!isSafeTabId(id)) return null;

  try {
    const paths = await tabPaths(id);
    const meta = parseTabMeta(await readTextFile(paths.metadata));
    if (meta === null) return null;

    const ket = await readTextFile(paths.structure);
    if (!isKetDocument(ket)) return null;
    return { id, name: meta.name, path: meta.path, ket, dirty: meta.dirty };
  } catch {
    return null;
  }
}

/**
 * Reads one tab's metadata. A record written before the display name existed
 * carries no `name`: it is derived from the path base name, and stays `null`
 * for a path-less entry.
 */
function parseTabMeta(raw: string | null | undefined): TabSnapshotMeta | null {
  const meta = parseAutosaveMeta(raw);
  if (meta === null || typeof raw !== "string") return null;

  let name: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).name;
      if (typeof value === "string") name = value;
    }
  } catch {
    // `parseAutosaveMeta` already rejected unparseable JSON.
  }

  if (name === null && meta.path !== null) name = pathBaseName(meta.path);
  return { ...meta, name };
}

/** Reads `index.json`; a missing, malformed or empty record yields `null`. */
function parseTabIndex(raw: string | null | undefined): TabIndex | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const order = record.order;
  const activeId = record.activeId;

  if (!Array.isArray(order) || order.length === 0) return null;
  if (!order.every((id): id is string => typeof id === "string")) return null;
  if (typeof activeId !== "string") return null;

  return { order, activeId };
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await remove(path);
  } catch {
    // Already gone (or never written): cleanup is best effort.
  }
}
