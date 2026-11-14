import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Store-level tests for the snapshot lifecycle. The Tauri adapters are mocked
 * with an in-memory filesystem so the queue/tombstone interaction can be
 * exercised without a WebView (the only place `docs/testing.md` §5.1 allows a
 * Tauri mock).
 */
const state = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/app",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: async () => undefined,
  readTextFile: async (path: string) => {
    const text = state.files.get(path);
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  },
  writeTextFile: async (path: string, text: string) => {
    state.files.set(path, text);
  },
  rename: async (from: string, to: string) => {
    const text = state.files.get(from);
    if (text === undefined) throw new Error(`missing ${from}`);
    state.files.delete(from);
    state.files.set(to, text);
  },
  remove: async (path: string) => {
    if (!state.files.delete(path)) throw new Error(`missing ${path}`);
  },
}));

import { clearTabSnapshot, writeTabSnapshot } from "./tabStore";
import { createTab } from "./tabs";

const STRUCTURE = '{"root":{"nodes":[]}}';

function snapshotFiles(id: string): string[] {
  return [...state.files.keys()].filter((path) => path.includes(`/${id}.`));
}

describe("tab snapshot lifecycle", () => {
  beforeEach(() => {
    state.files.clear();
  });

  it("writes a structure and metadata for an open tab", async () => {
    await writeTabSnapshot(createTab("tab-write", { ket: STRUCTURE }), 1);

    expect(snapshotFiles("tab-write").sort()).toEqual([
      "/app/recovery/tabs/tab-write.json",
      "/app/recovery/tabs/tab-write.ket",
    ]);
    expect(state.files.get("/app/recovery/tabs/tab-write.ket")).toBe(STRUCTURE);
  });

  it("removes the snapshot when the tab is cleared", async () => {
    await writeTabSnapshot(createTab("tab-clear", { ket: STRUCTURE }), 1);
    expect(snapshotFiles("tab-clear").length).toBe(2);

    await clearTabSnapshot("tab-clear");

    expect(snapshotFiles("tab-clear")).toEqual([]);
  });

  it("does not resurrect a snapshot when a write is submitted after a clear", async () => {
    await clearTabSnapshot("tab-cleared");

    await writeTabSnapshot(createTab("tab-cleared", { ket: STRUCTURE }), 2);

    expect(snapshotFiles("tab-cleared")).toEqual([]);
  });

  it("refuses a write submitted between a clear call and its queued cleanup", async () => {
    // The clear is submitted first, the write second: the write's entry check
    // still sees an open tab, so the in-queue re-check must refuse it.
    const clearing = clearTabSnapshot("tab-race");
    const writing = writeTabSnapshot(createTab("tab-race", { ket: STRUCTURE }), 3);

    await Promise.all([clearing, writing]);

    expect(snapshotFiles("tab-race")).toEqual([]);
  });
});
