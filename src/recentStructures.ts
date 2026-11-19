/**
 * Loader for the Welcome "Recent structures" table (`docs/architecture.md`
 * §5.11). For each recent path it stats the file, reads the `.ket`, derives the
 * molfile through Ketcher's serializers, asks the injected struct-service check
 * for a validation result and resolves a cached Indigo preview.
 *
 * Every failure degrades one row to placeholders (`—` size/date, `Unknown`
 * validation, no thumbnail); it never drops the row, invents a value or turns a
 * parse failure into `Invalid`. The file is only ever read.
 */

import { KetSerializer, MolSerializer } from "ketcher-core";
import { readTextFile, stat as statFile } from "@tauri-apps/plugin-fs";

import {
  contentHash,
  formatFileSize,
  formatModified,
  validationStatus,
  type ValidationStatus,
} from "./recentDetails";
import { readCachedPreview, renderStructurePreview, writeCachedPreview } from "./previewCache";

/** One rendered row of the Recent structures table. */
export interface RecentRow {
  /** Absolute path; also the row's identity for Open and dedupe. */
  path: string;
  /** Path base name without its last extension. */
  name: string;
  /** Upper-case extension without the dot (`KET`). */
  format: string;
  /** `formatFileSize(stat.size)`, or `—` when the file cannot be read. */
  sizeLabel: string;
  /** `formatModified(stat.mtime)`, or `—` when the file cannot be read. */
  modifiedLabel: string;
  /** Indigo check mapping; `unknown` for a missing file or failed read. */
  status: ValidationStatus;
  /** `data:image/svg+xml;base64,…` thumbnail, or `null`. */
  preview: string | null;
}

/** Injected runtime dependencies; the UI passes the real sidecar and Ketcher. */
export interface RecentDeps {
  /** Sidecar base URL ending in `/v2/` (`docs/architecture.md` §5.12). */
  apiBase: string;
  /** `ketcher.structService.check(molfile, …)` for one molfile. */
  check: (molfile: string) => Promise<unknown>;
  /** Maximum rows to load; defaults to 5. */
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const EM_DASH = "—";

/** File facts and resolved values a row is built from. */
export interface RecentRowInput {
  /** Absolute path; also the row's identity for Open and dedupe. */
  path: string;
  /** `stat` result, or `null` when the file is missing or unreadable. */
  stat: { size: number; mtime: number } | null;
  /** The `.ket` text, or `null` when the file cannot be read. */
  text: string | null;
  /** Raw struct-service check result, or `null` when it was not run. */
  checkResult: unknown;
  /** `data:image/svg+xml;base64,…` thumbnail, or `null`. */
  preview: string | null;
}

/** The row name and upper-case format derived from a path. */
function pathParts(path: string): { name: string; format: string } {
  const baseName = path.split(/[\\/]/).pop() ?? path;
  const dot = baseName.lastIndexOf(".");

  if (dot <= 0) return { name: baseName, format: "" };
  return { name: baseName.slice(0, dot), format: baseName.slice(dot + 1).toUpperCase() };
}

/** Epoch milliseconds from Tauri's `Date | null` (or a numeric mock). */
function mtimeOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** The `.ket` text as a molfile, or `null` for a non-KET file or parse error. */
function molfileFrom(path: string, text: string): string | null {
  if (pathParts(path).format !== "KET") return null;

  try {
    const struct = new KetSerializer().deserializeMicromolecules(text);
    return new MolSerializer().serialize(struct);
  } catch {
    return null;
  }
}

/** Base64 of the SVG's UTF-8 bytes, for the data URI. */
function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  // Chunked so a large SVG never exceeds the argument limit of `fromCharCode`.
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

/** Runs the check for `molfile`; any thrown error yields `null` (unknown). */
async function checkResultOf(molfile: string | null, deps: RecentDeps): Promise<unknown> {
  if (molfile === null) return null;

  try {
    return await deps.check(molfile);
  } catch {
    return null;
  }
}

/** Reads the cached SVG or renders it once, then returns its data URI. */
async function previewOf(molfile: string | null, deps: RecentDeps): Promise<string | null> {
  if (molfile === null) return null;

  try {
    const hash = await contentHash(molfile);
    const cached = await readCachedPreview(hash);
    const svg = cached ?? (await renderStructurePreview(deps.apiBase, molfile));
    if (svg === null) return null;

    if (cached === null) await writeCachedPreview(hash, svg);
    return `data:image/svg+xml;base64,${encodeBase64Utf8(svg)}`;
  } catch {
    return null;
  }
}

/**
 * Builds one row from already-read facts. Pure: name and format come from the
 * path, labels from the size/mtime helpers, the badge from `validationStatus`.
 * A missing `stat` or `text` degrades the row to `—` size/date, `unknown`
 * status and no thumbnail; `checkResult === null` is `unknown`, never a pass.
 */
export function buildRecentRow(input: RecentRowInput): RecentRow {
  const parts = pathParts(input.path);

  if (input.stat === null || input.text === null) {
    return {
      ...parts,
      path: input.path,
      sizeLabel: EM_DASH,
      modifiedLabel: EM_DASH,
      status: "unknown",
      preview: null,
    };
  }

  return {
    ...parts,
    path: input.path,
    sizeLabel: formatFileSize(input.stat.size),
    modifiedLabel: formatModified(input.stat.mtime),
    status: input.checkResult === null ? "unknown" : validationStatus(input.checkResult),
    preview: input.preview,
  };
}

/** Loads one row; every filesystem failure yields the degraded row. */
async function loadRow(path: string, deps: RecentDeps): Promise<RecentRow> {
  let info: Awaited<ReturnType<typeof statFile>>;
  try {
    info = await statFile(path);
  } catch {
    return buildRecentRow({ path, stat: null, text: null, checkResult: null, preview: null });
  }

  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return buildRecentRow({ path, stat: null, text: null, checkResult: null, preview: null });
  }

  const molfile = molfileFrom(path, text);
  const [checkResult, preview] = await Promise.all([
    checkResultOf(molfile, deps),
    previewOf(molfile, deps),
  ]);

  return buildRecentRow({
    path,
    stat: { size: info.size, mtime: mtimeOf(info.mtime) ?? Number.NaN },
    text,
    checkResult,
    preview,
  });
}

/**
 * Builds the table rows in recent-list order, capped to `limit ?? 5`. Each
 * row keeps its place even when its file is gone, so a stale recent entry
 * still offers **Open** (which surfaces the real error) instead of vanishing.
 */
export async function loadRecentStructures(
  paths: string[],
  deps: RecentDeps,
): Promise<RecentRow[]> {
  const requested = deps.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : DEFAULT_LIMIT;

  const rows: RecentRow[] = [];
  for (const path of paths.slice(0, limit)) {
    rows.push(await loadRow(path, deps));
  }
  return rows;
}
