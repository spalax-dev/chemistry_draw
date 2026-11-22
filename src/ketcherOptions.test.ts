import { readFileSync } from "node:fs";

import type { Ketcher } from "ketcher-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as ketcherOptions from "./ketcherOptions";
import { findKetcherRoot } from "./ketcherOptions";

/**
 * Ketcher 3.21 narrowed `editor.options()` to render options: `app` is now
 * Redux store state. The main/backstage app therefore applies server mode
 * through the store adapter (`docs/architecture.md`, section 4.1):
 *
 * - `applyKetcherAppOptions(ketcher, { server: true })` resolves the mounted
 *   store through `findKetcherStore` and delegates the dispatch sequence.
 * - `applyAppOptionsToStore(store, app)` dispatches `APP_OPTIONS` (merged app),
 *   `UPDATE` and a no-op `ACTION`, and returns `false` without fabricating
 *   server mode when the store is missing or a dispatch throws.
 * - `src/App.tsx` uses that adapter and never passes `app` to
 *   `editor.options()`.
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

describe("applyAppOptionsToStore", () => {
  it("dispatches APP_OPTIONS, UPDATE and a no-op ACTION in order", () => {
    const calls: Action[] = [];
    const store: FakeStore = {
      dispatch(action) {
        calls.push(action as Action);
        return action;
      },
      getState: () => ({}),
    };

    const applied = applyAppOptionsToStore!(store, { server: true });

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
  it("exists and applies through findKetcherStore", () => {
    const source = readSource("./ketcherOptions.ts");
    const body = functionBody(source, "applyKetcherAppOptions");

    expect(body, "ketcherOptions.ts must export applyKetcherAppOptions").not.toBe("");
    expect(body).toContain("findKetcherStore(ketcher)");
    expect(body).toContain("applyAppOptionsToStore(");
  });
});

describe("App.tsx init contract", () => {
  const app = readSource("./App.tsx");

  it("enables server mode through applyKetcherAppOptions", () => {
    expect(app).toMatch(
      /import\s*\{[^}]*applyKetcherAppOptions[^}]*\}\s*from\s*["']\.\/ketcherOptions["']/,
    );
    expect(app).toMatch(
      /applyKetcherAppOptions\s*\(\s*ketcher\s*,\s*\{\s*server:\s*true\s*\}\s*\)/,
    );
  });

  it("never passes app to editor.options()", () => {
    expect(app).not.toMatch(/editor\.options\(\s*\{[\s\S]{0,300}?\bapp\s*:/);
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

  function ketcherWithEditor(editor: Record<string, unknown>): Ketcher {
    return { editor } as unknown as Ketcher;
  }

  it("prefers the micromolecules render.clientArea root over the canvas root", () => {
    const clientAreaRoot = { source: "clientArea" } as unknown as Element;
    const canvasRoot = { source: "canvas" } as unknown as Element;
    const clientAreaClosest = vi.fn(() => clientAreaRoot);
    const canvasClosest = vi.fn(() => canvasRoot);
    const querySelector = stubDocument(() => null);

    const ketcher = ketcherWithEditor({
      render: { clientArea: { closest: clientAreaClosest } as unknown as Element },
      canvas: { closest: canvasClosest } as unknown as Element,
    });

    expect(findKetcherRoot(ketcher)).toBe(clientAreaRoot);
    expect(clientAreaClosest).toHaveBeenCalledWith(".Ketcher-root");
    expect(canvasClosest).not.toHaveBeenCalled();
    expect(querySelector).not.toHaveBeenCalled();
  });

  it("falls back to the canvas root when render.clientArea is absent", () => {
    const canvasRoot = { source: "canvas" } as unknown as Element;
    const canvasClosest = vi.fn(() => canvasRoot);
    const querySelector = stubDocument(() => null);

    const ketcher = ketcherWithEditor({
      canvas: { closest: canvasClosest } as unknown as Element,
    });

    expect(findKetcherRoot(ketcher)).toBe(canvasRoot);
    expect(canvasClosest).toHaveBeenCalledWith(".Ketcher-root");
    expect(querySelector).not.toHaveBeenCalled();
  });

  it("uses document.querySelector('.Ketcher-root') as the last resort", () => {
    const documentRoot = { source: "document" } as unknown as Element;
    const querySelector = stubDocument(() => documentRoot);

    expect(findKetcherRoot(ketcherWithEditor({}))).toBe(documentRoot);
    expect(querySelector).toHaveBeenCalledWith(".Ketcher-root");
  });
});
