/**
 * App-level Ketcher options that are not exposed through the public API.
 *
 * Ketcher 3.18 keeps `app.imagoVersions` (and the derived `Recognize` disabled
 * state) in the Redux store owned by its React tree. `ketcher.editor.options()`
 * only updates the render options and rebuilds the canvas, so the toolbar
 * action state never sees the model capability and the control stays disabled.
 *
 * This adapter finds that store through the React root container and dispatches
 * the same `APP_OPTIONS` + `UPDATE` pair Ketcher's own `checkServer` thunk uses,
 * followed by a no-op `ACTION` so the toolbar action state (which gates
 * Recognize) is recomputed. The editor is not remounted and the struct,
 * selection and undo history survive.
 *
 * The access is deliberately narrow. It optional-chains the client-area lookup,
 * caps the fiber walk, accepts only a store whose `getState().options.app`
 * exists, wraps every dispatch in `try`/`catch` and returns `false` on any
 * mismatch. If a future Ketcher version changes the store or the action shapes,
 * the caller keeps working with the capability unapplied (Recognize stays
 * disabled); a Ketcher upgrade must re-check this module before bumping the
 * dependency.
 */

/** React attaches its root fiber to the container under this prefix. */
const REACT_CONTAINER_PREFIX = "__reactContainer$";

/** Upper bound on the fiber walk; a malformed tree must not hang the app. */
const MAX_FIBER_NODES = 10_000;

interface KetcherStore {
  dispatch(action: unknown): unknown;
  getState(): unknown;
}

interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiber(value: unknown): value is Fiber {
  return isRecord(value) && "child" in value && "sibling" in value && "memoizedProps" in value;
}

/** Best-effort `closest` that tolerates a missing or non-element client area. */
function closestElement(value: unknown, selector: string): Element | null {
  if (!isRecord(value)) return null;

  const closest = value.closest;
  if (typeof closest !== "function") return null;

  try {
    const found: unknown = closest.call(value, selector);
    return isRecord(found) ? (found as unknown as Element) : null;
  } catch {
    return null;
  }
}

/**
 * Locates the `.Ketcher-root` element from the mounted editor.
 *
 * The editor's `render.clientArea` is private surface; the lookup optional-
 * chains it and falls back to the document so a shape change only skips the
 * in-place update instead of breaking the dialog flow.
 */
export function findKetcherRoot(editor: unknown): Element | null {
  const render = isRecord(editor) && isRecord(editor.editor) ? editor.editor.render : null;
  const clientArea = isRecord(render) ? render.clientArea : null;
  const root = closestElement(clientArea, ".Ketcher-root");
  if (root !== null) return root;

  return typeof document === "undefined" ? null : document.querySelector(".Ketcher-root");
}

/** True when the state exposes Ketcher's `options.app` slice. */
function hasAppOptions(state: unknown): boolean {
  if (!isRecord(state)) return false;

  const options = state.options;
  return isRecord(options) && "app" in options;
}

function storeFromProps(props: unknown): KetcherStore | null {
  if (!isRecord(props)) return null;

  const store = props.store;
  if (!isRecord(store)) return null;
  if (typeof store.dispatch !== "function" || typeof store.getState !== "function") return null;

  try {
    const state = (store.getState as () => unknown).call(store);
    if (!hasAppOptions(state)) return null;
  } catch {
    return null;
  }

  return store as unknown as KetcherStore;
}

/** Finds the Redux store of the React tree rooted at `container`. */
function findKetcherStore(container: Element | null): KetcherStore | null {
  if (container === null) return null;

  const key = Object.keys(container).find((name) => name.startsWith(REACT_CONTAINER_PREFIX));
  if (key === undefined) return null;

  const root = (container as unknown as Record<string, unknown>)[key];
  if (!isFiber(root)) return null;

  const queue: Fiber[] = [root];
  const seen = new Set<Fiber>();
  for (let index = 0; index < queue.length && seen.size < MAX_FIBER_NODES; index += 1) {
    const fiber = queue[index];
    if (seen.has(fiber)) continue;
    seen.add(fiber);

    const store = storeFromProps(fiber.memoizedProps);
    if (store !== null) return store;

    if (isFiber(fiber.child)) queue.push(fiber.child);
    if (isFiber(fiber.sibling)) queue.push(fiber.sibling);
  }

  return null;
}

/**
 * Merges `app` into Ketcher's option store and refreshes the toolbar state.
 *
 * Returns `false` when the store cannot be found, the state does not look like
 * Ketcher's or a dispatch throws, so the caller can log the fallback instead of
 * silently believing the capability was advertised.
 */
export function applyKetcherAppOptions(
  container: Element | null,
  app: Record<string, unknown>,
): boolean {
  try {
    const store = findKetcherStore(container);
    if (store === null) return false;

    store.dispatch({ type: "APP_OPTIONS", data: { ...app } });
    store.dispatch({ type: "UPDATE" });
    // A no-op action recomputes Ketcher's actionState (and therefore the
    // Recognize `disabled` flag) without changing the active tool or the struct.
    store.dispatch({ type: "ACTION", action: () => undefined });
    return true;
  } catch {
    return false;
  }
}
