/**
 * Contract for `src/ketcherOptions.ts`, the narrow adapter that copies
 * `imago_versions` into Ketcher's private React/Redux option store.
 *
 * The module must never trust the private shape it reaches for. These tests use
 * fake containers and fibers (no real DOM, no React) and pin the defensive
 * behaviour: a plausible Ketcher store is required (`dispatch` plus
 * `getState().options.app`), the fiber walk is capped, a throwing `closest` or
 * dispatch degrades to `false`, and the documented action sequence is the only
 * thing dispatched.
 *
 * ```ts
 * export function findKetcherRoot(editor: unknown): Element | null;
 * export function applyKetcherAppOptions(
 *   container: Element | null,
 *   app: Record<string, unknown>,
 * ): boolean;
 * ```
 */
import { describe, expect, it } from "vitest";

import { applyKetcherAppOptions, findKetcherRoot } from "./ketcherOptions";

interface FakeFiber {
  child: FakeFiber | null;
  sibling: FakeFiber | null;
  memoizedProps: unknown;
}

type DispatchCall = { type: string; data?: unknown };

function node(memoizedProps: unknown, child: FakeFiber | null = null): FakeFiber {
  return { child, sibling: null, memoizedProps };
}

/** A container whose React root holds `child` as the first fiber. */
function containerWith(child: FakeFiber | null): Element {
  const root = node(null, child);
  return { __reactContainer$test: root } as unknown as Element;
}

function kinStore(calls: DispatchCall[], state: unknown = { options: { app: {} } }): unknown {
  return {
    dispatch(action: unknown) {
      calls.push(action as DispatchCall);
      return action;
    },
    getState() {
      return state;
    },
  };
}

function ketcherWith(store: unknown): FakeFiber {
  return node({ store });
}

describe("applyKetcherAppOptions", () => {
  it("dispatches the documented action sequence for a Ketcher-like store", () => {
    const calls: DispatchCall[] = [];
    const container = containerWith(ketcherWith(kinStore(calls)));

    const applied = applyKetcherAppOptions(container, { server: true, imagoVersions: ["a"] });

    expect(applied).toBe(true);
    expect(calls.map((call) => call.type)).toEqual(["APP_OPTIONS", "UPDATE", "ACTION"]);
    expect(calls[0].data).toEqual({ server: true, imagoVersions: ["a"] });
    expect(typeof (calls[2] as { action?: unknown }).action).toBe("function");
  });

  it("returns false when the container has no React root", () => {
    expect(applyKetcherAppOptions({} as Element, { server: true })).toBe(false);
  });

  it("returns false when the React root is not a fiber", () => {
    const container = { __reactContainer$test: "not-a-fiber" } as unknown as Element;

    expect(applyKetcherAppOptions(container, { server: true })).toBe(false);
  });

  it("returns false when the store has no getState", () => {
    const container = containerWith(ketcherWith({ dispatch: () => undefined }));

    expect(applyKetcherAppOptions(container, { server: true })).toBe(false);
  });

  it("returns false when the store state has no options.app slice", () => {
    const calls: DispatchCall[] = [];
    const container = containerWith(ketcherWith(kinStore(calls, { options: {} })));

    expect(applyKetcherAppOptions(container, { server: true })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false when getState throws", () => {
    const store = {
      dispatch: () => undefined,
      getState: () => {
        throw new Error("store unavailable");
      },
    };

    expect(applyKetcherAppOptions(containerWith(ketcherWith(store)), { server: true })).toBe(false);
  });

  it("returns false instead of throwing when a dispatch throws", () => {
    const store = {
      dispatch: () => {
        throw new Error("private action shape changed");
      },
      getState: () => ({ options: { app: {} } }),
    };

    expect(applyKetcherAppOptions(containerWith(ketcherWith(store)), { server: true })).toBe(false);
  });

  it("caps the fiber walk so a malformed tree cannot hang", () => {
    const calls: DispatchCall[] = [];
    const head = node(null);
    let tail = head;
    // 10,100 siblings: the store sits past the 10,000-node cap.
    for (let index = 0; index < 10_100; index += 1) {
      const next = node(null);
      tail.sibling = next;
      tail = next;
    }
    tail.memoizedProps = { store: kinStore(calls) };

    expect(applyKetcherAppOptions(containerWith(head), { server: true })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("findKetcherRoot", () => {
  it("returns the closest .Ketcher-root element from the editor client area", () => {
    const root = { id: "ketcher-root" };
    const clientArea = {
      closest(selector: string) {
        expect(selector).toBe(".Ketcher-root");
        return root;
      },
    };

    expect(findKetcherRoot({ editor: { render: { clientArea } } })).toBe(root);
  });

  it("returns null when closest throws", () => {
    const clientArea = {
      closest() {
        throw new Error("private render shape changed");
      },
    };

    expect(findKetcherRoot({ editor: { render: { clientArea } } })).toBeNull();
  });

  it("returns null when the client area has no closest function", () => {
    expect(findKetcherRoot({ editor: { render: { clientArea: {} } } })).toBeNull();
  });

  it("returns null when the editor has no render", () => {
    expect(findKetcherRoot({ editor: {} })).toBeNull();
  });
});
