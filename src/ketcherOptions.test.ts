import { readFileSync } from "node:fs";

import type { Ketcher } from "ketcher-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as ketcherOptions from "./ketcherOptions";
import { applyKetcherAppOptions, findKetcherRoot, initKetcherServerMode } from "./ketcherOptions";

/**
 * Ketcher 3.21 narrowed `editor.options()` to render options: `app` is now
 * Redux store state. The app therefore applies server mode through the store
 * adapter:
 *
 * - `applyKetcherAppOptions(ketcher, { server: true })` resolves the mounted
 *   store (`findKetcherStore`) and delegates the dispatch sequence.
 * - `applyAppOptionsToStore(store, app)` dispatches `APP_OPTIONS` (merged app),
 *   `UPDATE` and a no-op `ACTION`, and returns `false` without fabricating
 *   server mode when the store is missing or a dispatch throws.
 * - `findKetcherRoot` accepts the micromolecules editor's `render.clientArea`
 *   and falls back to the `CoreEditor` `canvas`.
 * - `src/App.tsx` uses that adapter and never passes `app` to
 *   `editor.options()`.
 *
 * The store is reached through private React fibers, so the fake tree here
 * pins the defensive behaviour: optional chaining, the capped breadth-first
 * walk, and `false` instead of a throw on any unexpected shape.
 */

type Action = { type?: unknown; data?: unknown; action?: unknown };

interface FakeStore {
  dispatch: (action: unknown) => unknown;
  getState: () => unknown;
}

type ApplyAppOptionsToStore = (store: FakeStore | null, app: Record<string, unknown>) => boolean;

const applyAppOptionsToStore = (
  ketcherOptions as { applyAppOptionsToStore?: ApplyAppOptionsToStore }
).applyAppOptionsToStore;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** Source of an exported function, from its declaration to its matching brace. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";

  const open = source.indexOf("{", start);
  if (open === -1) return "";

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

interface FakeFiber {
  child: FakeFiber | null;
  sibling: FakeFiber | null;
  memoizedProps: unknown;
}

function node(memoizedProps: unknown, child: FakeFiber | null = null): FakeFiber {
  return { child, sibling: null, memoizedProps };
}

/** A React root element whose container holds `child` as the first fiber. */
function rootWith(child: FakeFiber | null): Element {
  const root = node(null, child);
  return { __reactContainer$test: root } as unknown as Element;
}

function ketcherRootedAt(root: Element | null, canvasRoot: Element | null = null): Ketcher {
  const clientArea = root === null ? undefined : { closest: () => root };
  const canvas = canvasRoot === null ? undefined : { closest: () => canvasRoot };
  return { editor: { render: { clientArea }, canvas } } as unknown as Ketcher;
}

function storeWith(calls: Action[], state: unknown = { options: { app: {} } }): FakeStore {
  return {
    dispatch(action) {
      calls.push(action as Action);
      return action;
    },
    getState: () => state,
  };
}

function ketcherWithStore(store: unknown): Ketcher {
  return ketcherRootedAt(rootWith(node({ store })));
}

describe("applyAppOptionsToStore", () => {
  it("dispatches APP_OPTIONS, UPDATE and a no-op ACTION in order", () => {
    const calls: Action[] = [];

    const applied = applyAppOptionsToStore!(storeWith(calls), { server: true });

    expect(applied).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(["APP_OPTIONS", "UPDATE", "ACTION"]);
    expect(calls[0].data).toEqual({ server: true });

    const noOp = calls[2].action;
    expect(typeof noOp).toBe("function");
    expect((noOp as () => unknown)()).toBeUndefined();
  });

  it("returns false without dispatching when the store is missing", () => {
    expect(applyAppOptionsToStore!(null, { server: true })).toBe(false);
  });

  it("returns false and stops when a dispatch throws", () => {
    let dispatches = 0;
    const store: FakeStore = {
      dispatch() {
        dispatches += 1;
        throw new Error("private action shape changed");
      },
      getState: () => ({}),
    };

    expect(applyAppOptionsToStore!(store, { server: true })).toBe(false);
    expect(dispatches).toBe(1);
  });
});

describe("applyKetcherAppOptions", () => {
  it("resolves the mounted store and dispatches the documented sequence", () => {
    const calls: Action[] = [];

    const applied = applyKetcherAppOptions(ketcherWithStore(storeWith(calls)), {
      server: true,
      imagoVersions: ["a"],
    });

    expect(applied).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(["APP_OPTIONS", "UPDATE", "ACTION"]);
    expect(calls[0].data).toEqual({ server: true, imagoVersions: ["a"] });
  });

  it("returns false when the editor root cannot be resolved", () => {
    expect(applyKetcherAppOptions(null, { server: true })).toBe(false);
    expect(applyKetcherAppOptions(ketcherRootedAt(null), { server: true })).toBe(false);
  });

  it("returns false when the store has no getState", () => {
    const store = { dispatch: () => undefined };

    expect(applyKetcherAppOptions(ketcherWithStore(store), { server: true })).toBe(false);
  });

  it("returns false when the store state has no options.app slice", () => {
    const calls: Action[] = [];

    expect(
      applyKetcherAppOptions(ketcherWithStore(storeWith(calls, { options: {} })), {
        server: true,
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false when getState throws", () => {
    const store = {
      dispatch: () => undefined,
      getState: () => {
        throw new Error("store unavailable");
      },
    };

    expect(applyKetcherAppOptions(ketcherWithStore(store), { server: true })).toBe(false);
  });

  it("returns false instead of throwing when a dispatch throws", () => {
    const store = {
      dispatch: () => {
        throw new Error("private action shape changed");
      },
      getState: () => ({ options: { app: {} } }),
    };

    expect(applyKetcherAppOptions(ketcherWithStore(store), { server: true })).toBe(false);
  });

  it("caps the fiber walk so a malformed tree cannot hang", () => {
    const calls: Action[] = [];
    const head = node(null);
    let tail = head;
    // 10,100 siblings: the store sits past the 10,000-node cap.
    for (let index = 0; index < 10_100; index += 1) {
      const next = node(null);
      tail.sibling = next;
      tail = next;
    }
    tail.memoizedProps = { store: storeWith(calls) };

    expect(applyKetcherAppOptions(ketcherRootedAt(rootWith(head)), { server: true })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("initKetcherServerMode", () => {
  it("enables server mode through the store and does not warn", () => {
    const calls: Action[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(initKetcherServerMode(ketcherWithStore(storeWith(calls)))).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(["APP_OPTIONS", "UPDATE", "ACTION"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failure and warns when the store cannot be resolved", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(initKetcherServerMode(ketcherRootedAt(null))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[chemistry-draw] could not enable Ketcher server mode; server-backed controls stay disabled.",
    );
  });
});

describe("App.tsx init contract", () => {
  const app = readSource("./App.tsx");

  it("enables server mode through initKetcherServerMode", () => {
    expect(app).toMatch(
      /import\s*\{[^}]*initKetcherServerMode[^}]*\}\s*from\s*["']\.\/ketcherOptions["']/,
    );
    expect(app).toMatch(/initKetcherServerMode\s*\(\s*ketcher\s*\)/);
  });

  it("never passes app to editor.options()", () => {
    expect(app).not.toMatch(/editor\.options\(\s*\{[\s\S]{0,300}?\bapp\s*:/);
  });

  it("keeps the sidecar base wiring", () => {
    const handleInit = functionBody(app, "handleInit");

    // The struct-service provider is built from the resolved sidecar base, not
    // a hard-coded URL, and the editor receives that provider.
    expect(app).toMatch(/resolveApiBase\(\)/);
    expect(app).toMatch(/new StaleSafeStructServiceProvider\(\s*base\s*\)/);
    expect(app).toMatch(/structServiceProvider=\{provider\}/);
    expect(handleInit).not.toContain("editor.options");
  });
});

describe("findKetcherRoot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubDocument(querySelector: () => Element | null) {
    const querySelectorMock = vi.fn(querySelector);
    vi.stubGlobal("document", { querySelector: querySelectorMock });
    return querySelectorMock;
  }

  it("prefers the micromolecules render.clientArea root over the canvas root", () => {
    const clientAreaRoot = { source: "clientArea" } as unknown as Element;
    const canvasRoot = { source: "canvas" } as unknown as Element;
    const clientAreaClosest = vi.fn(() => clientAreaRoot);
    const canvasClosest = vi.fn(() => canvasRoot);
    const querySelector = stubDocument(() => null);

    const ketcher = {
      editor: {
        render: { clientArea: { closest: clientAreaClosest } as unknown as Element },
        canvas: { closest: canvasClosest } as unknown as Element,
      },
    } as unknown as Ketcher;

    expect(findKetcherRoot(ketcher)).toBe(clientAreaRoot);
    expect(clientAreaClosest).toHaveBeenCalledWith(".Ketcher-root");
    expect(canvasClosest).not.toHaveBeenCalled();
    expect(querySelector).not.toHaveBeenCalled();
  });

  it("falls back to the canvas root when render.clientArea is absent", () => {
    const canvasRoot = { source: "canvas" } as unknown as Element;
    const canvasClosest = vi.fn(() => canvasRoot);
    const querySelector = stubDocument(() => null);

    const ketcher = {
      editor: { canvas: { closest: canvasClosest } as unknown as Element },
    } as unknown as Ketcher;

    expect(findKetcherRoot(ketcher)).toBe(canvasRoot);
    expect(canvasClosest).toHaveBeenCalledWith(".Ketcher-root");
    expect(querySelector).not.toHaveBeenCalled();
  });

  it("uses document.querySelector('.Ketcher-root') as the last resort", () => {
    const documentRoot = { source: "document" } as unknown as Element;
    const querySelector = stubDocument(() => documentRoot);

    expect(findKetcherRoot({ editor: {} } as unknown as Ketcher)).toBe(documentRoot);
    expect(querySelector).toHaveBeenCalledWith(".Ketcher-root");
  });

  it("returns null when closest throws and no document fallback exists", () => {
    const clientArea = {
      closest() {
        throw new Error("private render shape changed");
      },
    };

    expect(
      findKetcherRoot({ editor: { render: { clientArea } } } as unknown as Ketcher),
    ).toBeNull();
  });
});
