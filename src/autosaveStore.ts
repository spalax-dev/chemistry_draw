/**
 * Tauri I/O for autosave snapshots. This is the only place that touches the
 * recovery directory; the scheduling, the generation counter and the recovery
 * decision stay pure in `autosave.ts`.
 *
 *   <appDataDir>/recovery/autosave.ket    working structure (.ket text)
 *   <appDataDir>/recovery/autosave.json   { path, savedAt, dirty }
 *
 * The metadata file is written last (commit record) and removed first (so an
 * interrupted cleanup cannot resurrect a stale snapshot). Outside Tauri every
 * function is a no-op: the browser has no recovery directory.
 */

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import { createWriteGeneration, parseAutosaveMeta, type AutosaveMeta } from "./autosave";

/** A snapshot that can be offered for recovery: structure plus metadata. */
export interface Snapshot {
  ket: string;
  meta: AutosaveMeta;
}

/** What the original `.ket` file looks like on disk, for the recovery offer. */
export interface OriginalFile {
  /** Modification time in epoch milliseconds, or `null` when unknown. */
  mtime: number | null;
  /** The metadata pointed at a path but the file is no longer there. */
  missing: boolean;
}

interface RecoveryPaths {
  directory: string;
  structure: string;
  partial: string;
  metadata: string;
}

const RECOVERY_DIRECTORY = "recovery";
const STRUCTURE_FILE = "autosave.ket";
const PARTIAL_FILE = "autosave.ket.part";
const METADATA_FILE = "autosave.json";

/** Shared with `clearSnapshot`; see `createWriteGeneration`. */
const writeGeneration = createWriteGeneration();

async function recoveryPaths(): Promise<RecoveryPaths> {
  const directory = await join(await appDataDir(), RECOVERY_DIRECTORY);
  return {
    directory,
    structure: await join(directory, STRUCTURE_FILE),
    partial: await join(directory, PARTIAL_FILE),
    metadata: await join(directory, METADATA_FILE),
  };
}

/**
 * Writes one snapshot: the `.ket` text first, then the metadata as the last
 * step. The structure goes through `autosave.ket.part` and is renamed over the
 * previous snapshot so a half-written file is never read back.
 *
 * A cleanup (`clearSnapshot`) advances the generation, so a write that started
 * earlier stops before its next commit step and removes anything it created.
 */
export async function writeSnapshot({
  ket,
  path,
  savedAt,
}: {
  ket: string;
  path: string | null;
  savedAt: number;
}): Promise<void> {
  if (!isTauri()) return;

  const token = writeGeneration.begin();
  const paths = await recoveryPaths();
  if (!writeGeneration.isCurrent(token)) return;

  await mkdir(paths.directory, { recursive: true });
  if (!writeGeneration.isCurrent(token)) return;

  await writeTextFile(paths.partial, ket);
  if (!writeGeneration.isCurrent(token)) {
    await removeIfPresent(paths.partial);
    return;
  }

  await rename(paths.partial, paths.structure);
  if (!writeGeneration.isCurrent(token)) {
    await removeIfPresent(paths.structure);
    return;
  }

  const meta: AutosaveMeta = { path, savedAt, dirty: true };
  await writeTextFile(paths.metadata, JSON.stringify(meta));

  if (!writeGeneration.isCurrent(token)) {
    // A cleanup ran while this write committed: undo it, metadata first.
    await removeIfPresent(paths.metadata);
    await removeIfPresent(paths.structure);
    await removeIfPresent(paths.partial);
  }
}

/**
 * Reads the snapshot. Returns `null` when the metadata is missing or malformed
 * or the structure cannot be read: a lone `.ket` is never restored.
 */
export async function readSnapshot(): Promise<Snapshot | null> {
  if (!isTauri()) return null;

  try {
    const paths = await recoveryPaths();
    const meta = parseAutosaveMeta(await readTextFile(paths.metadata));
    if (meta === null) return null;

    const ket = await readTextFile(paths.structure);
    if (ket.length === 0) return null;

    return { ket, meta };
  } catch {
    return null;
  }
}

/**
 * Deletes the snapshot and invalidates every write already in flight:
 * metadata first, then the structure, so a crash in between cannot leave
 * restorable metadata behind.
 */
export async function clearSnapshot(): Promise<void> {
  if (!isTauri()) return;

  writeGeneration.invalidate();
  const paths = await recoveryPaths();
  await removeIfPresent(paths.metadata);
  await removeIfPresent(paths.structure);
  await removeIfPresent(paths.partial);
}

/**
 * Looks at the saved file a snapshot belongs to. `mtime` is `null` when the
 * file cannot be read (deleted, moved or unreadable); `missing` says whether
 * the path itself no longer exists.
 */
export async function inspectOriginal(path: string | null): Promise<OriginalFile> {
  if (!isTauri() || path === null) return { mtime: null, missing: false };

  try {
    const info = await stat(path);
    return { mtime: info.mtime === null ? null : info.mtime.getTime(), missing: false };
  } catch {
    return { mtime: null, missing: !(await pathExists(path)) };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await remove(path);
  } catch {
    // Already gone (or never written): cleanup is best effort.
  }
}
