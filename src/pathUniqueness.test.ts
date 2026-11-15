import { describe, expect, it } from "vitest";

import {
  ALREADY_OPEN_MESSAGE,
  canSaveToPath,
  createTab,
  emptyTabSet,
  addTab,
  findTabByPath,
  pathKey,
  resolveOpenTarget,
  tabOwningPath,
  type TabSet,
} from "./tabs";

const POSIX_PATH = "/home/jorge/Documents/benzene.ket";
const WINDOWS_PATH = "C:\\Users\\jorge\\Documents\\Benzene.KET";

function oneOwnedTab(): TabSet {
  return addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
}

describe("pathKey", () => {
  it("keeps POSIX case so two differently cased documents stay distinct", () => {
    expect(pathKey("/docs/A.ket")).toBe("/docs/A.ket");
    expect(pathKey("/docs/a.ket")).toBe("/docs/a.ket");
    expect(pathKey("/docs/A.ket")).not.toBe(pathKey("/docs/a.ket"));
  });

  it("folds a Windows drive-letter path to lower case", () => {
    expect(pathKey("C:\\Docs\\A.ket")).toBe("c:/docs/a.ket");
    expect(pathKey("c:/docs/a.ket")).toBe("c:/docs/a.ket");
  });

  it("unifies backslashes and forward slashes", () => {
    expect(pathKey("C:\\Docs\\a.ket")).toBe(pathKey("C:/Docs/a.ket"));
  });

  it("collapses duplicate separators", () => {
    expect(pathKey("/docs//a.ket")).toBe("/docs/a.ket");
    expect(pathKey("C:\\\\Docs\\\\\\a.ket")).toBe("c:/docs/a.ket");
  });

  it("drops one trailing separator", () => {
    expect(pathKey("/docs/a.ket/")).toBe("/docs/a.ket");
    expect(pathKey("C:\\Docs\\a.ket\\")).toBe("c:/docs/a.ket");
  });

  it("leaves the POSIX root unchanged", () => {
    expect(pathKey("/")).toBe("/");
  });

  it("collapses no dot segments", () => {
    expect(pathKey("/docs/./a.ket")).toBe("/docs/./a.ket");
  });
});

describe("findTabByPath", () => {
  it("finds the tab holding the exact path", () => {
    const set = oneOwnedTab();

    expect(findTabByPath(set, WINDOWS_PATH)?.id).toBe("b");
  });

  it("finds the tab through a normalised equivalent path", () => {
    const set = oneOwnedTab();

    expect(findTabByPath(set, "c:/users/jorge/documents/benzene.ket/")?.id).toBe("b");
  });

  it("returns undefined for an unrelated path", () => {
    const set = oneOwnedTab();

    expect(findTabByPath(set, "/home/jorge/Documents/toluene.ket")).toBeUndefined();
  });

  it("returns undefined when no tab carries a path", () => {
    const set = emptyTabSet("a");

    expect(findTabByPath(set, POSIX_PATH)).toBeUndefined();
  });
});

describe("tabOwningPath", () => {
  it("returns the tab owning the path", () => {
    const set = oneOwnedTab();

    expect(tabOwningPath(set, "C:\\Users\\jorge\\Documents\\Benzene.KET")?.id).toBe("b");
  });

  it("skips the excluded tab and still matches another tab", () => {
    let set = addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
    set = addTab(set, createTab("c", { path: POSIX_PATH }));

    expect(tabOwningPath(set, POSIX_PATH, "b")?.id).toBe("c");
    expect(tabOwningPath(set, WINDOWS_PATH, "c")?.id).toBe("b");
  });

  it("returns undefined when the only owner is the excluded tab", () => {
    const set = oneOwnedTab();

    expect(tabOwningPath(set, WINDOWS_PATH, "b")).toBeUndefined();
  });

  it("returns undefined for a free path", () => {
    const set = oneOwnedTab();

    expect(tabOwningPath(set, "/home/jorge/Documents/toluene.ket")).toBeUndefined();
  });
});

describe("resolveOpenTarget", () => {
  it("activates the active tab that owns the path", () => {
    const set = oneOwnedTab();

    expect(resolveOpenTarget(set, WINDOWS_PATH)).toEqual({ kind: "activate", tabId: "b" });
  });

  it("activates another tab that owns the path", () => {
    let set = addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
    set = addTab(set, createTab("c"));
    set = { ...set, activeId: "c" };

    expect(resolveOpenTarget(set, "c:/users/jorge/documents/benzene.ket/")).toEqual({
      kind: "activate",
      tabId: "b",
    });
  });

  it("opens a free path", () => {
    const set = oneOwnedTab();

    expect(resolveOpenTarget(set, POSIX_PATH)).toEqual({ kind: "open" });
  });
});

describe("canSaveToPath", () => {
  it("allows the active tab to save to its own path", () => {
    const set = oneOwnedTab();

    expect(canSaveToPath(set, "C:\\Users\\jorge\\Documents\\Benzene.KET", "b")).toBe(true);
  });

  it("refuses a path owned by another tab", () => {
    const set = oneOwnedTab();

    expect(canSaveToPath(set, WINDOWS_PATH, "a")).toBe(false);
  });

  it("allows a free path", () => {
    const set = oneOwnedTab();

    expect(canSaveToPath(set, POSIX_PATH, "a")).toBe(true);
  });
});

describe("ALREADY_OPEN_MESSAGE", () => {
  it("states the notice sentence exactly", () => {
    expect(ALREADY_OPEN_MESSAGE).toBe("This document is already open.");
  });
});
