/**
 * Pure document tab model: creation, activation, content commits, closing,
 * titles and the close-guard decision. No React, no Tauri, no DOM access, so
 * Vitest can exercise it directly.
 *
 * A tab is file state only; the single Ketcher instance lives in `App.tsx` and
 * the I/O lives in `tabStore.ts`.
 */

/** File state of one open tab over the single Ketcher editor. */
export interface TabState {
  /** Stable identifier, also names the tab's snapshot files. */
  id: string;
  /** User-chosen `.ket` file, or `null` when the tab was never saved. */
  path: string | null;
  /** Source file base name for a path-less import, or `null` when unnamed. */
  name: string | null;
  /** Last committed `.ket` content, empty for an untouched tab. */
  ket: string;
  /** Unsaved edits since the last save, open or new. */
  dirty: boolean;
}

/** The window's whole tab workspace: strip order plus the active tab. */
export interface TabSet {
  /** Tabs left to right; never empty. */
  tabs: TabState[];
  /** The tab the single editor currently shows. */
  activeId: string;
}

/** Partial state applied on top of a new tab; the id always wins. */
export type TabInit = Partial<Omit<TabState, "id">>;

/** Fields a caller may patch on an existing tab; the id is immutable. */
export type TabPatch = Partial<Omit<TabState, "id">>;

/** The answer a user gives the dirty-tabs close prompt. */
export type TabsCloseChoice = "save" | "discard" | "cancel";

/** What the close guard decides to do next. */
export type TabsCloseGuardAction = "close" | "prompt" | "stay" | "discard" | "save";

/** The close guard's next step, returned by `decideTabsCloseGuard`. */
export interface TabsCloseGuardDecision {
  /** Action the caller must run; `prompt` means show Save/Discard/Cancel. */
  action: TabsCloseGuardAction;
}

const UNTITLED = "Untitled";

/** Minimal valid `.ket` document: an empty canvas. */
export const EMPTY_KET = '{"root":{"nodes":[]}}';

/** A new tab: clean, path-less and empty unless `init` says otherwise. */
export function createTab(id: string, init: TabInit = {}): TabState {
  return {
    id,
    path: init.path ?? null,
    name: init.name ?? null,
    ket: init.ket ?? "",
    dirty: init.dirty ?? false,
  };
}

/** A fresh set holding one clean active tab. */
export function emptyTabSet(id: string): TabSet {
  return { tabs: [createTab(id)], activeId: id };
}

/** Activates a known tab; an unknown id leaves the set untouched. */
export function activateTab(set: TabSet, id: string): TabSet {
  if (!set.tabs.some((tab) => tab.id === id)) return set;
  return { ...set, activeId: id };
}

/** Appends a tab and activates it. */
export function addTab(set: TabSet, tab: TabState): TabSet {
  return { tabs: [...set.tabs, tab], activeId: tab.id };
}

/** Patches one tab; an unknown id leaves the set untouched. */
export function updateTab(set: TabSet, id: string, patch: TabPatch): TabSet {
  const index = set.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return set;

  const tabs = set.tabs.map((tab, current) => (current === index ? { ...tab, ...patch } : tab));
  return { ...set, tabs };
}

/**
 * Stores serialized editor content in a tab. The content is now the tab's
 * working structure, but it has not been written to the user's file, so the tab
 * stays dirty.
 */
export function commitEditor(set: TabSet, id: string, ket: string): TabSet {
  return updateTab(set, id, { ket, dirty: true });
}

/**
 * Closes a tab. When it was the active one, the next tab to its right becomes
 * active, otherwise the one to its left. Closing the only tab yields a fresh
 * empty tab, so a window never has zero tabs.
 */
export function closeTab(set: TabSet, id: string, emptyId: string): TabSet {
  const index = set.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return set;
  if (set.tabs.length === 1) return emptyTabSet(emptyId);

  const tabs = set.tabs.filter((tab) => tab.id !== id);
  if (set.activeId !== id) return { ...set, tabs };

  const neighbour = tabs[index] ?? tabs[index - 1];
  return { tabs, activeId: neighbour.id };
}

/**
 * Path base name first, then the imported source `name`, then `Untitled`, plus
 * `*` while dirty.
 */
export function tabTitle(tab: TabState): string {
  const base = tab.path !== null ? pathBaseName(tab.path) : (tab.name ?? UNTITLED);
  return tab.dirty ? `${base}*` : base;
}

/** The same precedence as `tabTitle`, without the dirty marker: dialog copy. */
export function tabDisplayName(tab: TabState): string {
  return tab.path !== null ? pathBaseName(tab.path) : (tab.name ?? UNTITLED);
}

/** The tab the editor shows. Every set has an active tab. */
export function activeTab(set: TabSet): TabState {
  return set.tabs.find((tab) => tab.id === set.activeId) ?? set.tabs[0];
}

/** Every tab with unsaved edits, in strip order. */
export function dirtyTabs(set: TabSet): TabState[] {
  return set.tabs.filter((tab) => tab.dirty);
}

/**
 * Decides what a window close does. `choice` is `null` while the user has not
 * answered the prompt.
 *
 * With a dirty set, Save is only offered when exactly one tab is dirty **and**
 * it is the active one: the other documents cannot be written without loading
 * them into the single editor.
 */
export function decideTabsCloseGuard(
  set: TabSet,
  choice: TabsCloseChoice | null,
): TabsCloseGuardDecision {
  const dirty = dirtyTabs(set);
  if (dirty.length === 0) return { action: "close" };
  if (choice === null) return { action: "prompt" };
  if (choice === "cancel") return { action: "stay" };
  if (choice === "discard") return { action: "discard" };

  return dirty.length === 1 && dirty[0].id === set.activeId
    ? { action: "save" }
    : { action: "stay" };
}

/**
 * Whether text may be loaded as a `.ket` document. An empty (or blank) string
 * is the untouched tab and is allowed; anything else must parse as a JSON
 * object carrying a `root`. Snapshot restore uses this so a truncated or
 * unrelated file drops the tab instead of failing `setMolecule`.
 */
export function isKetDocument(text: string): boolean {
  if (text.trim().length === 0) return true;

  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "root" in parsed
    );
  } catch {
    return false;
  }
}

/** An untouched tab Open may reuse instead of opening a new one. */
export function isUntouchedTab(tab: TabState): boolean {
  return tab.name === null && tab.path === null && !tab.dirty && isEmptyCanvasKet(tab.ket);
}

/**
 * Whether serialized editor content is an empty canvas. `""` and whitespace are
 * the untouched tab, and Ketcher's `getKet()` returns pretty-printed KET with
 * `ket_version` and empty `root.nodes` (plus empty `connections`/`templates`),
 * so a byte comparison with `EMPTY_KET` is not enough. Anything else —
 * malformed JSON, a missing or non-empty `root.nodes` — is a real structure.
 */
export function isEmptyCanvasKet(ket: string): boolean {
  if (ket.trim().length === 0) return true;

  try {
    const parsed: unknown = JSON.parse(ket);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

    const root = (parsed as { root?: unknown }).root;
    if (typeof root !== "object" || root === null || Array.isArray(root)) return false;

    const nodes = (root as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) && nodes.length === 0;
  } catch {
    return false;
  }
}

/** What New does with the current set: empty the active tab, or add one. */
export type NewDocumentTarget = { kind: "reuse"; tabId: string } | { kind: "create" };

/**
 * New reuses the active tab only when it is an untouched empty tab, so an empty
 * canvas is not stacked on top of itself; any document or edit forces a new
 * tab.
 */
export function newDocumentTarget(set: TabSet): NewDocumentTarget {
  const tab = set.tabs.find((entry) => entry.id === set.activeId);
  return tab !== undefined && isUntouchedTab(tab)
    ? { kind: "reuse", tabId: tab.id }
    : { kind: "create" };
}

/**
 * A tab imported from a non-`.ket` file: clean (it equals its source file) and
 * path-less until its first Save As, carrying the source file's base name.
 */
export function importedTab(id: string, ket: string, name: string | null = null): TabState {
  return createTab(id, { path: null, name, ket, dirty: false });
}

/**
 * Last path segment on POSIX (`/`) and Windows (`\`), without its last
 * extension: `benzene.ket` and `benzene.mol` both yield `benzene`. A name with
 * no extension and a leading-dot dotfile such as `.enol` are kept as they are.
 */
export function pathBaseName(path: string): string {
  const segments = path.split(/[\\/]/);
  const name = segments[segments.length - 1] || path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** One-sentence notice body for an already-open path (§6.7). */
export const ALREADY_OPEN_MESSAGE = "This document is already open.";

/**
 * Comparison key for a document path (`docs/architecture.md` §5.10):
 * separators are unified and collapsed, one trailing separator is dropped, and
 * a Windows drive-letter path is lower-cased because that filesystem compares
 * case-insensitively. A POSIX path keeps its case. Nothing else is normalised:
 * no dot segments, no symlink resolution, no extension change.
 */
export function pathKey(path: string): string {
  const unified = path.replace(/[\\/]+/g, "/");
  const trimmed = unified.length > 1 && unified.endsWith("/") ? unified.slice(0, -1) : unified;
  return /^[A-Za-z]:/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** The tab holding a path, comparing through `pathKey`; `undefined` if none. */
export function findTabByPath(set: TabSet, path: string): TabState | undefined {
  const key = pathKey(path);
  return set.tabs.find((tab) => tab.path !== null && pathKey(tab.path) === key);
}

/**
 * The tab owning a path, optionally ignoring one tab (`excludeId`). Save As
 * uses it to refuse a destination held by another tab while allowing the
 * active tab's own path.
 */
export function tabOwningPath(set: TabSet, path: string, excludeId?: string): TabState | undefined {
  const key = pathKey(path);
  return set.tabs.find(
    (tab) => tab.id !== excludeId && tab.path !== null && pathKey(tab.path) === key,
  );
}

/** What Open does with a path: activate its owning tab, or open it. */
export type OpenTarget = { kind: "activate"; tabId: string } | { kind: "open" };

/** Open and Recent…: an owned path activates its tab, a free path opens. */
export function resolveOpenTarget(set: TabSet, path: string): OpenTarget {
  const owner = findTabByPath(set, path);
  return owner ? { kind: "activate", tabId: owner.id } : { kind: "open" };
}

/**
 * Save As…: a path owned by another tab is refused, while the tab's own path
 * and a free path are allowed.
 */
export function canSaveToPath(set: TabSet, path: string, tabId: string): boolean {
  return tabOwningPath(set, path, tabId) === undefined;
}
