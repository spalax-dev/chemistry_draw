/**
 * Ketcher runtime integration seams that are not exposed through the public
 * API. Four private seams meet here:
 *
 * - `app.imagoVersions` (and the derived `Recognize` disabled state) lives in
 *   the Redux store owned by Ketcher's React tree. `ketcher.editor.options()`
 *   only updates the render options and rebuilds the canvas, so the toolbar
 *   action state never sees the model capability and the control stays disabled.
 *   `applyKetcherAppOptions` dispatches the same `APP_OPTIONS` + `UPDATE` pair
 *   Ketcher's own `checkServer` thunk uses, followed by a no-op `ACTION` so the
 *   toolbar action state (which gates Recognize) is recomputed. The editor is
 *   not remounted and the struct, selection and undo history survive.
 * - Ketcher exposes no public "open a dialog" or "clear the armed tool" API.
 *   `openStructureLibrary` dispatches the same `MODAL_OPEN` action as Ketcher's
 *   `template-lib` toolbar button, and `cancelActiveTool` sends the Escape the
 *   canvas already handles, so the backstage can open the real Structure
 *   Library and a template cannot follow the pointer over app chrome.
 * - The editor needs a struct-service provider pointed at the sidecar, and its
 *   Recognize promise must not replay a stale result; the provider and the
 *   `/v2/info` resolution live here.
 * - Welcome's template cards and the backstage need Ketcher's real Structure
 *   Library, serialized to KET and cached after the first paint.
 *
 * The store access is deliberately narrow. It optional-chains the client-area
 * lookup, caps the fiber walk, accepts only a store whose
 * `getState().options.app` exists, wraps every dispatch in `try`/`catch` and
 * returns `false` on any mismatch. If a future Ketcher version changes the
 * store or the action shapes, the caller keeps working with the capability
 * unapplied (Recognize stays disabled) and the backstage reports that it could
 * not open the library; a Ketcher upgrade must re-check this module before
 * bumping the dependency.
 */

import {
  FunctionalGroupsProvider,
  KetSerializer,
  RemoteStructServiceProvider,
  SaltsAndSolventsProvider,
  type Ketcher,
  type Struct,
  type StructService,
  type StructServiceOptions,
} from "ketcher-core";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import {
  buildLibraryTemplates,
  type LibraryTemplate,
  type TemplateSource,
} from "./templateLibrary";

/** The only part of the Redux store this adapter needs. */
export interface KetcherStore {
  /** Dispatches a Ketcher Redux action. */
  dispatch(action: unknown): unknown;
  /** Reads the current Ketcher state. */
  getState(): unknown;
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

/** React attaches its root fiber to the container under this prefix. */
const REACT_CONTAINER_PREFIX = "__reactContainer$";

/** React attaches a fiber to an element under this prefix. */
const REACT_FIBER_PREFIX = "__reactFiber$";

/** Ketcher's application root; both the store and the tool reset live there. */
const KETCHER_ROOT_SELECTOR = ".Ketcher-root";

/** Upper bound on the fiber walk; a malformed tree must not hang the app. */
const MAX_FIBER_NODES = 10_000;

interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  return?: Fiber | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiber(value: unknown): value is Fiber {
  return isRecord(value) && "child" in value && "sibling" in value && "memoizedProps" in value;
}

/** Best-effort `closest` that tolerates a missing or non-element node. */
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
 * The editor's `render.clientArea` and `canvas` are private surface; the lookup
 * optional-chains them and falls back to the document so a shape change only
 * skips the in-place operation instead of breaking the dialog flow.
 */
export function findKetcherRoot(editor: unknown): Element | null {
  const inner = isRecord(editor) && isRecord(editor.editor) ? editor.editor : null;
  const render = inner === null ? null : inner.render;
  const clientArea = isRecord(render) ? render.clientArea : null;
  const canvas = inner === null ? null : inner.canvas;
  const root =
    closestElement(clientArea, KETCHER_ROOT_SELECTOR) ??
    closestElement(canvas, KETCHER_ROOT_SELECTOR);
  if (root !== null) return root;

  return typeof document === "undefined" ? null : document.querySelector(KETCHER_ROOT_SELECTOR);
}

/** True when the state exposes Ketcher's `options.app` slice. */
function hasAppOptions(state: unknown): boolean {
  if (!isRecord(state)) return false;

  const options = state.options;
  return isRecord(options) && "app" in options;
}

/** Accepts a Redux store shaped like Ketcher's, or returns `null`. */
function storeFromValue(value: unknown): KetcherStore | null {
  if (!isRecord(value)) return null;
  if (typeof value.dispatch !== "function" || typeof value.getState !== "function") return null;

  try {
    const state = (value.getState as () => unknown).call(value);
    if (!hasAppOptions(state)) return null;
  } catch {
    return null;
  }

  return value as unknown as KetcherStore;
}

/**
 * Reads the store from React props. React-Redux's `<Provider store={store}>`
 * and a context provider (`value={store}`) both appear in Ketcher's tree, so
 * both prop shapes are checked.
 */
function storeFromProps(props: unknown): KetcherStore | null {
  if (!isRecord(props)) return null;
  return storeFromValue(props.store) ?? storeFromValue(props.value);
}

/**
 * Finds the Redux store of the React tree rooted at `container`.
 *
 * The React root container key holds the top fiber; a plain element may only
 * carry the `__reactFiber$` key, so its `return` chain is walked as a fallback.
 * The breadth-first walk is capped so a malformed tree cannot hang the app.
 */
function storeInContainer(container: Element | null): KetcherStore | null {
  if (container === null) return null;

  const keys = Object.keys(container);
  const containerKey = keys.find((name) => name.startsWith(REACT_CONTAINER_PREFIX));
  if (containerKey !== undefined) {
    const root = (container as unknown as Record<string, unknown>)[containerKey];
    if (isFiber(root)) {
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
    }
  }

  const fiberKey = keys.find((name) => name.startsWith(REACT_FIBER_PREFIX));
  if (fiberKey !== undefined) {
    let fiber = (container as unknown as Record<string, unknown>)[fiberKey];
    while (isFiber(fiber)) {
      const store = storeFromProps(fiber.memoizedProps);
      if (store !== null) return store;
      fiber = fiber.return ?? null;
    }
  }

  return null;
}

/** The Redux store behind the mounted editor, or `null` when it cannot be found. */
export function findKetcherStore(ketcher: Ketcher | null): KetcherStore | null {
  return storeInContainer(findKetcherRoot(ketcher));
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
    const store = storeInContainer(container);
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

/**
 * Opens Ketcher's **Structure Library** by dispatching the same `MODAL_OPEN`
 * action as its `template-lib` toolbar button.
 *
 * @returns `false` (without dispatching) when the editor or its store cannot be
 * resolved, so the caller can report the failure instead of showing a
 * fabricated gallery.
 */
export function openStructureLibrary(ketcher: Ketcher | null): boolean {
  const store = findKetcherStore(ketcher);
  if (store === null) return false;
  store.dispatch(STRUCTURE_LIBRARY_ACTION);
  return true;
}

/**
 * Clears an armed tool (a Structure Library template that follows the cursor)
 * by dispatching the Escape a user would press.
 *
 * Ketcher resets the armed tool when its root receives an Escape `keydown`, so
 * one bubbling, cancelable event on `.Ketcher-root` takes the same path as the
 * keyboard. No toolbar DOM click, Redux action or editor reset is used: the
 * canvas keeps its content and only the pending tool is dropped.
 *
 * @returns `true` when the root was found; a missing root is a no-op that
 * reports `false`.
 */
export function cancelActiveTool(ketcher: Ketcher | null): boolean {
  if (typeof document === "undefined") return false;

  const root = findKetcherRoot(ketcher);
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

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Versions and the real port read from `GET /v2/info`; never assumed values. */
export interface IndigoInfo {
  /** The sidecar's Indigo version, or `null` when it did not report one. */
  version: string | null;
  /** The port named by `api_path`, or the host-reported fallback. */
  port: number | null;
}

/** The resolved sidecar base plus the info the About pane reads. */
export interface ResolvedApi {
  /** Base URL ending in `/v2/`, suitable for the struct-service provider. */
  apiBase: string;
  /** Indigo version and bound port from `/v2/info`. */
  info: IndigoInfo;
}

/** Reads `indigo_version` and the port in `api_path`, tolerating a bad body. */
function parseIndigoInfo(body: unknown, fallbackPort: number): IndigoInfo {
  if (typeof body !== "object" || body === null) {
    return { version: null, port: fallbackPort };
  }

  const record = body as Record<string, unknown>;
  const version =
    typeof record.indigo_version === "string" && record.indigo_version.length > 0
      ? record.indigo_version
      : null;

  let port = fallbackPort;
  if (typeof record.api_path === "string") {
    try {
      const parsed = new URL(record.api_path);
      if (parsed.port !== "") port = Number(parsed.port);
    } catch {
      // Keep the port the host reported.
    }
  }

  return { version, port };
}

/**
 * Resolve the Indigo API base URL and the real sidecar info.
 *
 * The sidecar reports the port it actually bound to, which may not be the
 * preferred one if that port was already in use. It also starts asynchronously,
 * so this polls until `/v2/info` answers. Outside Tauri the host command is
 * unavailable and the default port is tried.
 */
export async function resolveApiBase(): Promise<ResolvedApi> {
  const deadline = Date.now() + 20_000;
  let port = 9321;

  while (Date.now() < deadline) {
    try {
      port = await invoke<number>("indigo_port");
    } catch {
      // Not running under Tauri (plain browser): keep the default.
    }

    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/v2/info`, 1_000);
      if (res.ok) {
        let info: IndigoInfo = { version: null, port };
        try {
          info = parseIndigoInfo(await res.json(), port);
        } catch {
          // The endpoint answered but not with JSON; keep the fallback.
        }
        return { apiBase: `http://127.0.0.1:${port}/v2/`, info };
      }
    } catch {
      // Sidecar not ready yet.
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Give up and let Ketcher surface the connection error.
  return { apiBase: `http://127.0.0.1:${port}/v2/`, info: { version: null, port } };
}

/**
 * Struct service provider that discards stale recognition results.
 *
 * Ketcher's Recognize dialog dispatches `setStruct` from every `recognize`
 * promise it starts. Changing the image while a recognition is still running
 * lets the older promise resolve after the newer one, overwriting the fresh
 * preview (or clearing it with an outdated error). Each call takes a monotonic
 * token and only the latest token may settle; stale promises stay pending
 * forever so the Ketcher thunk never dispatches an outdated result. The result
 * also gets a unique molfile title so Ketcher's title-keyed preview cache does
 * not replay an earlier structure.
 */
export class StaleSafeStructServiceProvider extends RemoteStructServiceProvider {
  private recognizeToken = 0;

  override createStructService(options: StructServiceOptions): StructService {
    const service = super.createStructService(options);
    const recognize = service.recognize.bind(service);

    service.recognize = (blob: Blob, version: string) => {
      const token = ++this.recognizeToken;
      return recognize(blob, version).then(
        (result) => {
          if (token !== this.recognizeToken) return new Promise<never>(() => {});
          // Ketcher's StructRender caches rendered SVG by the molfile title.
          // The sidecar writes an empty title for every structure, so a second
          // recognition of a different molecule would replay the first cached
          // preview. A unique title keeps the cache key distinct; the title is
          // cosmetic and does not change the atoms or bonds.
          const title = `Recognized structure ${token}`;
          return { ...result, struct: result.struct.replace(/^[^\n]*/, title) };
        },
        (error: unknown) =>
          token === this.recognizeToken ? Promise.reject(error) : new Promise<never>(() => {}),
      );
    };

    return service;
  }
}

/**
 * Reads Ketcher's real Structure Library. Ketcher appends salts and solvents to
 * the functional-groups list, so the salts are classified first and their names
 * are skipped when mapping groups. Every entry keeps its own KET, the only
 * structure a card previews or inserts.
 */
function readLibraryTemplates(): LibraryTemplate[] {
  const salts = SaltsAndSolventsProvider.getInstance().getSaltsAndSolventsList();
  const groups = FunctionalGroupsProvider.getInstance().getFunctionalGroupsList();
  const serializer = new KetSerializer();

  const nameOf = (struct: Struct): string => (struct.abbreviation || struct.name).trim();
  const saltNames = new Set(salts.map((struct) => nameOf(struct).toLowerCase()));
  const entries: TemplateSource[] = [];

  // A struct the serializer cannot handle is skipped: one bad library entry
  // must not empty or crash the whole Welcome grid.
  const serialize = (struct: Struct): string | null => {
    try {
      return serializer.serializeMicromolecules(struct);
    } catch {
      return null;
    }
  };

  for (const struct of groups) {
    const name = nameOf(struct);
    if (saltNames.has(name.toLowerCase())) continue;
    const ket = serialize(struct);
    if (ket === null) continue;
    entries.push({ name, group: "functional-group", ket });
  }
  for (const struct of salts) {
    const ket = serialize(struct);
    if (ket === null) continue;
    entries.push({ name: nameOf(struct), group: "salt-solvent", ket });
  }

  return buildLibraryTemplates(entries);
}

/**
 * The shared Structure Library build. Building it serializes every entry, so it
 * runs after the first paint and its result is reused by every later backstage
 * open; the in-flight promise keeps two openers from reading the providers
 * twice.
 */
let libraryCache: LibraryTemplate[] | null = null;
let libraryBuild: Promise<LibraryTemplate[]> | null = null;

/** Defers `run` to the next idle slot, falling back to a macrotask. */
function afterPaint(run: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    idle(run, { timeout: 1_000 });
    return;
  }
  setTimeout(run, 0);
}

/** Resolves the cached library, scheduling one deferred build when absent. */
function loadLibraryTemplates(): Promise<LibraryTemplate[]> {
  if (libraryCache !== null) return Promise.resolve(libraryCache);
  if (libraryBuild !== null) return libraryBuild;

  libraryBuild = new Promise<LibraryTemplate[]>((resolve) => {
    afterPaint(() => {
      let entries: LibraryTemplate[];
      try {
        entries = readLibraryTemplates();
        // An empty read is not cached: the providers may not be populated yet,
        // so a later backstage open gets to try again.
        if (entries.length > 0) libraryCache = entries;
      } catch (error) {
        // Not cached, so a later open retries once the providers are usable.
        console.warn("[chemistry-draw] could not read the structure library:", error);
        entries = [];
      }
      libraryBuild = null;
      resolve(entries);
    });
  });
  return libraryBuild;
}

/**
 * Loads the real Structure Library once the editor is ready, and retries an
 * empty build when the backstage opens again.
 *
 * @param ready - Whether Ketcher has initialized; the providers are empty before.
 * @param backstageOpen - A later open retries an empty read without looping.
 * @returns `templates` is `null` until the first build lands (skeletons), then
 * the cached real entries.
 */
export function useLibraryTemplates(
  ready: boolean,
  backstageOpen: boolean,
): { templates: LibraryTemplate[] | null } {
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  const templatesRef = useRef<LibraryTemplate[] | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void loadLibraryTemplates().then((entries) => {
      if (cancelled) return;
      templatesRef.current = entries;
      setTemplates(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  // Keyed on the open flag and readiness, never on `templates`, so an
  // again-empty read cannot loop; `libraryBuild` makes a concurrent retry a
  // no-op and `templates` returns to `null` so the skeletons stay.
  useEffect(() => {
    if (!backstageOpen || !ready) return;
    const current = templatesRef.current;
    if (current === null || current.length > 0) return;

    templatesRef.current = null;
    setTemplates(null);
    void loadLibraryTemplates().then((entries) => {
      templatesRef.current = entries;
      setTemplates(entries);
    });
  }, [backstageOpen, ready]);

  return { templates };
}
