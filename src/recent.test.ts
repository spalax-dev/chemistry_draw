import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addRecent,
  loadRecent,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  recentName,
  removeRecent,
  saveRecent,
} from "./recent";

/**
 * The recent-documents list (`docs/planning/contracts.md` §5): newest first,
 * deduplicated, capped at ten, and backed by `localStorage` with a silent
 * degradation when storage is unavailable.
 */

const BENZENE = "/home/jorge/Documents/benzene.ket";
const TOLUENE = "/home/jorge/Documents/toluene.ket";
const PHENOL = "/home/jorge/Documents/phenol.ket";

describe("recent list constants", () => {
  it("caps the list at ten documents by default", () => {
    expect(RECENT_LIMIT).toBe(10);
  });
});

describe("addRecent", () => {
  it("creates a one-entry list from an empty list", () => {
    expect(addRecent([], BENZENE)).toEqual([BENZENE]);
  });

  it("inserts a new path at the front and keeps the existing order", () => {
    expect(addRecent([TOLUENE, PHENOL], BENZENE)).toEqual([BENZENE, TOLUENE, PHENOL]);
  });

  it("moves an existing path to the front without duplicating it", () => {
    expect(addRecent([TOLUENE, PHENOL], PHENOL)).toEqual([PHENOL, TOLUENE]);
  });

  it("moves the trailing path to the front and leaves the rest in order", () => {
    const existing = ["a", "b", "c", "d"];

    expect(addRecent(existing, "d")).toEqual(["d", "a", "b", "c"]);
  });

  it("caps the list at ten entries and drops the oldest", () => {
    const existing = Array.from({ length: 10 }, (_, index) => `doc-${index}`);

    const next = addRecent(existing, "newest");

    expect(next).toHaveLength(10);
    expect(next[0]).toBe("newest");
    expect(next).not.toContain("doc-9");
    expect(next.slice(1)).toEqual(existing.slice(0, 9));
  });

  it("honours a custom limit", () => {
    expect(addRecent(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });

  it("does not duplicate the path when it already sits at the front", () => {
    expect(addRecent([BENZENE, TOLUENE], BENZENE)).toEqual([BENZENE, TOLUENE]);
  });

  it("dedupes by the exact string only", () => {
    const sibling = "/home/jorge/Documents/Benzene.ket";

    expect(addRecent([BENZENE], sibling)).toEqual([sibling, BENZENE]);
  });

  it("leaves the input list untouched", () => {
    const existing = [TOLUENE, PHENOL];

    addRecent(existing, BENZENE);

    expect(existing).toEqual([TOLUENE, PHENOL]);
  });
});

describe("removeRecent", () => {
  it("removes only the matching path", () => {
    expect(removeRecent([BENZENE, TOLUENE, PHENOL], TOLUENE)).toEqual([BENZENE, PHENOL]);
  });

  it("returns the list unchanged for an unknown path", () => {
    expect(removeRecent([BENZENE, TOLUENE], PHENOL)).toEqual([BENZENE, TOLUENE]);
  });

  it("returns an empty list when the only entry is removed", () => {
    expect(removeRecent([BENZENE], BENZENE)).toEqual([]);
  });

  it("leaves the input list untouched", () => {
    const existing = [BENZENE, TOLUENE];

    removeRecent(existing, BENZENE);

    expect(existing).toEqual([BENZENE, TOLUENE]);
  });
});

describe("recentName", () => {
  it("drops the .ket extension from a POSIX path", () => {
    expect(recentName(BENZENE)).toBe("benzene");
  });

  it("drops a .mol extension from a POSIX path", () => {
    expect(recentName("/home/jorge/Documents/benzene.mol")).toBe("benzene");
  });

  it("drops the extension from a Windows path", () => {
    expect(recentName("C:\\Users\\jorge\\Documents\\benzene.ket")).toBe("benzene");
  });

  it("returns a base name that has no extension unchanged", () => {
    expect(recentName("/home/jorge/Documents/benzene")).toBe("benzene");
  });

  it("drops only the last extension", () => {
    expect(recentName("/home/jorge/Documents/benzene.v2.mol")).toBe("benzene.v2");
  });

  it("keeps a dotfile name intact", () => {
    expect(recentName("/home/jorge/.ketrc")).toBe(".ketrc");
  });

  it("drops the extension after a leading-dot base name", () => {
    expect(recentName("/home/jorge/.archive.ket")).toBe(".archive");
  });
});

/** A `Storage` stand-in backed by a `Map`, enough for load/save. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));

  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("loadRecent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an empty list when the key is missing", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    expect(loadRecent()).toEqual([]);
  });

  it("returns an empty list for invalid JSON", () => {
    vi.stubGlobal("localStorage", memoryStorage({ [RECENT_STORAGE_KEY]: "{not json" }));

    expect(loadRecent()).toEqual([]);
  });

  it("returns an empty list when the stored value is not an array", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ [RECENT_STORAGE_KEY]: JSON.stringify({ path: BENZENE }) }),
    );

    expect(loadRecent()).toEqual([]);
  });

  it("drops non-string entries and duplicates", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        [RECENT_STORAGE_KEY]: JSON.stringify([BENZENE, 42, null, BENZENE, TOLUENE]),
      }),
    );

    expect(loadRecent()).toEqual([BENZENE, TOLUENE]);
  });

  it("caps a long stored list at ten entries", () => {
    const paths = Array.from({ length: 15 }, (_, index) => `/doc-${index}.ket`);
    vi.stubGlobal("localStorage", memoryStorage({ [RECENT_STORAGE_KEY]: JSON.stringify(paths) }));

    expect(loadRecent()).toHaveLength(RECENT_LIMIT);
    expect(loadRecent()[0]).toBe(paths[0]);
  });

  it("returns an empty list when getItem throws", () => {
    const store = memoryStorage();
    vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.stubGlobal("localStorage", store);

    expect(loadRecent()).toEqual([]);
  });

  it("returns an empty list when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(loadRecent()).toEqual([]);
  });
});

describe("saveRecent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes a JSON array under the documented key", () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);

    saveRecent([BENZENE, TOLUENE]);

    expect(store.getItem(RECENT_STORAGE_KEY)).toBe(JSON.stringify([BENZENE, TOLUENE]));
  });

  it("round-trips through loadRecent", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    saveRecent([BENZENE, TOLUENE, PHENOL]);

    expect(loadRecent()).toEqual([BENZENE, TOLUENE, PHENOL]);
  });

  it("degrades silently when setItem throws", () => {
    const store = memoryStorage();
    vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    vi.stubGlobal("localStorage", store);

    expect(() => saveRecent([BENZENE])).not.toThrow();
  });

  it("degrades silently when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(() => saveRecent([BENZENE])).not.toThrow();
  });
});
