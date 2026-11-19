/**
 * The narrow Ketcher store adapter used by the backstage
 * (`docs/architecture.md` §5.11).
 *
 * Ketcher exposes no public "open a dialog" API: its toolbar buttons dispatch a
 * Redux `MODAL_OPEN` action into the store that `ketcher-react` creates around
 * the mounted editor. Instead of clicking a toolbar button (a DOM shortcut that
 * breaks with the toolbar), this module finds that store through the editor's
 * React root and dispatches the same action Ketcher's `template-lib` button
 * sends. Every lookup is defensive: an unexpected shape returns `false` and the
 * caller reports the failure, so no fabricated gallery is ever shown.
 */

import type { Ketcher } from "ketcher-core";

/** The only part of the Redux store this adapter needs. */
export interface KetcherStore {
  dispatch: (action: unknown) => unknown;
  getState: () => unknown;
}

/** The `MODAL_OPEN` payload for Ketcher's Structure Library dialog. */
export const STRUCTURE_LIBRARY_ACTION = {
  type: "MODAL_OPEN",
  data: {
    name: "templates",
    prop: {
      tab: null,
    },
  },
} as const;

const REACT_FIBER_PREFIX = "__reactFiber$";
const REACT_CONTAINER_PREFIX = "__reactContainer$";
const KETCHER_ROOT_SELECTOR = ".Ketcher-root";

interface FiberLike {
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  return?: FiberLike | null;
  memoizedProps?: { value?: unknown; store?: unknown } | null;
  stateNode?: unknown;
}

/** The runtime shape of the mounted editor that the adapter reads. */
interface MountedEditor {
  canvas?: Element | null;
}

function isKetcherStore(value: unknown): value is KetcherStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { dispatch?: unknown; getState?: unknown };
  return typeof candidate.dispatch === "function" && typeof candidate.getState === "function";
}

function storeOf(fiber: FiberLike): KetcherStore | null {
  const props = fiber.memoizedProps;
  // React-Redux's <Provider store={store}> and a React context provider both
  // appear in the tree; check both prop shapes plus the class-component path.
  if (isKetcherStore(props?.value)) return props.value;
  if (isKetcherStore(props?.store)) return props.store;
  if (isKetcherStore(fiber.stateNode)) return fiber.stateNode;
  return null;
}

/** Breadth-first over a React root: the Redux Provider sits near the top. */
function storeFromTree(start: FiberLike | null): KetcherStore | null {
  const queue: FiberLike[] = start === null ? [] : [start];
  const seen = new Set<FiberLike>();

  while (queue.length > 0 && seen.size < 10_000) {
    const fiber = queue.shift();
    if (fiber === undefined || seen.has(fiber)) continue;
    seen.add(fiber);
    const store = storeOf(fiber);
    if (store !== null) return store;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }

  return null;
}

/** Walks up the outer tree, for the React root that hosts the editor element. */
function storeFromAncestors(start: FiberLike | null): KetcherStore | null {
  let fiber = start;
  while (fiber) {
    const store = storeOf(fiber);
    if (store !== null) return store;
    fiber = fiber.return ?? null;
  }
  return null;
}

/** The Redux store behind a mounted Ketcher React root element. */
function storeFromRoot(node: Element): KetcherStore | null {
  const keys = Object.keys(node);
  const containerKey = keys.find((name) => name.startsWith(REACT_CONTAINER_PREFIX));

  if (containerKey !== undefined) {
    const container = (node as unknown as Record<string, unknown>)[containerKey];
    const store = storeFromTree(container as FiberLike | null);
    if (store !== null) return store;
  }

  const fiberKey = keys.find((name) => name.startsWith(REACT_FIBER_PREFIX));
  if (fiberKey === undefined) return null;
  return storeFromAncestors(
    (node as unknown as Record<string, unknown>)[fiberKey] as FiberLike | null,
  );
}

/**
 * The editor's React root element: the one that carries the mounted Ketcher
 * component tree. Prefers the element above the editor canvas, then falls back
 * to the single `.Ketcher-root` on the page.
 */
export function findKetcherRoot(ketcher: Ketcher | null): Element | null {
  if (typeof document === "undefined") return null;

  // `Ketcher.editor` is typed as the legacy Editor interface, but the runtime
  // object is a `CoreEditor` that carries the mounted canvas.
  const editor = ketcher === null ? null : (ketcher.editor as unknown as MountedEditor);
  const canvas = editor?.canvas ?? null;
  const root = canvas === null ? null : canvas.closest(KETCHER_ROOT_SELECTOR);
  return root ?? document.querySelector(KETCHER_ROOT_SELECTOR);
}

/** The Redux store behind the mounted editor, or `null` when it cannot be found. */
export function findKetcherStore(ketcher: Ketcher | null): KetcherStore | null {
  const root = findKetcherRoot(ketcher);
  if (root === null) return null;
  return storeFromRoot(root);
}

/**
 * Opens Ketcher's **Structure Library** by dispatching the same `MODAL_OPEN`
 * action as its `template-lib` toolbar button. Returns `false` (without
 * dispatching) when the editor or its store cannot be resolved.
 */
export function openStructureLibrary(ketcher: Ketcher | null): boolean {
  const store = findKetcherStore(ketcher);
  if (store === null) return false;
  store.dispatch(STRUCTURE_LIBRARY_ACTION);
  return true;
}

/**
 * Clears an armed tool (a Structure Library template that follows the cursor)
 * by dispatching the Escape a user would press (`docs/architecture.md` §5.11,
 * "Tool reset").
 *
 * Ketcher resets the armed tool when its root receives an Escape `keydown`, so
 * one bubbling, cancelable event on `.Ketcher-root` takes the same path as the
 * keyboard. No toolbar DOM click, Redux action or editor reset is used: the
 * canvas keeps its content and only the pending tool is dropped. Returns
 * `true` when the root was found; a missing root is a no-op that reports
 * `false`.
 */
export function cancelActiveTool(ketcher: Ketcher | null): boolean {
  if (typeof document === "undefined") return false;

  // `findKetcherRoot` resolves the canvas ancestor; the explicit selector is
  // the same fallback it applies, kept here so a detached editor still resets.
  const root = findKetcherRoot(ketcher) ?? document.querySelector(".Ketcher-root");
  if (root === null) return false;

  root.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
