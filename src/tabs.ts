/**
 * Pure document tab model: creation, activation, content commits, closing,
 * titles and the close-guard decision. No React, no Tauri, no DOM access, so
 * Vitest can exercise it directly.
 *
 * A tab is file state only; the single Ketcher instance lives in `App.tsx` and
 * the I/O lives in `tabStore.ts`.
 */

export interface TabState {
  /** Stable identifier, also names the tab's snapshot files. */
  id: string;
  /** User-chosen `.ket` file, or `null` when the tab was never saved. */
  path: string | null;
  /** Last committed `.ket` content, empty for an untouched tab. */
  ket: string;
  /** Unsaved edits since the last save, open or new. */
  dirty: boolean;
}

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

export type TabsCloseChoice = "save" | "discard" | "cancel";

export type TabsCloseGuardAction = "close" | "prompt" | "stay" | "discard" | "save";

export interface TabsCloseGuardDecision {
  action: TabsCloseGuardAction;
}

const KET_EXTENSION = ".ket";
const UNTITLED = "Untitled";

/** Minimal valid `.ket` document: an empty canvas. */
export const EMPTY_KET = '{"root":{"nodes":[]}}';

/** A new tab: clean, path-less and empty unless `init` says otherwise. */
export function createTab(id: string, init: TabInit = {}): TabState {
  return {
    id,
    path: init.path ?? null,
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

/** Base name without `.ket`, `Untitled` when path-less, plus `*` while dirty. */
export function tabTitle(tab: TabState): string {
  const base = tab.path === null ? UNTITLED : baseName(tab.path);
  return tab.dirty ? `${base}*` : base;
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
  const ket = tab.ket.trim();
  return tab.path === null && !tab.dirty && (ket === "" || ket === EMPTY_KET);
}

/** A tab Open loaded from a non-`.ket` file: no file backs its content. */
export function importedTab(id: string, ket: string): TabState {
  return createTab(id, { path: null, ket, dirty: true });
}

/** Last path segment on POSIX (`/`) and Windows (`\`), without `.ket`. */
function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  const name = segments[segments.length - 1] || path;
  return name.toLowerCase().endsWith(KET_EXTENSION) ? name.slice(0, -KET_EXTENSION.length) : name;
}
