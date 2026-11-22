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

/**
 * One path belongs to at most one tab (`docs/planning/contracts.md` §5):
 * Open and a recent entry activate the owning tab, Save As refuses a foreign
 * path, and no file is read or written on a refusal.
 */

const POSIX_PATH = "/home/jorge/Documents/benzene.ket";
const WINDOWS_PATH = "C:\\Users\\jorge\\Documents\\Benzene.KET";

function oneOwnedTab(): TabSet {
  return addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
}

describe("pathKey", () => {
  it("keeps POSIX case so two differently cased documents stay distinct", () => {
    expect(pathKey("/docs/A.ket")).toBe("/docs/A.ket");
    expect(pathKey("/docs/a.ket")).not.toBe(pathKey("/docs/A.ket"));
  });

  it("folds a Windows drive-letter path to lower case", () => {
    expect(pathKey("C:\\Docs\\A.ket")).toBe("c:/docs/a.ket");
    expect(pathKey("c:/docs/a.ket")).toBe("c:/docs/a.ket");
  });

  it("unifies and collapses separators", () => {
    expect(pathKey("C:\\Docs\\a.ket")).toBe(pathKey("C:/Docs/a.ket"));
    expect(pathKey("/docs//a.ket")).toBe("/docs/a.ket");
    expect(pathKey("C:\\\\Docs\\\\\\a.ket")).toBe("c:/docs/a.ket");
  });

  it("drops one trailing separator", () => {
    expect(pathKey("/docs/a.ket/")).toBe("/docs/a.ket");
    expect(pathKey("C:\\Docs\\a.ket\\")).toBe("c:/docs/a.ket");
  });

  it("leaves the POSIX root unchanged and collapses no dot segments", () => {
    expect(pathKey("/")).toBe("/");
    expect(pathKey("/docs/./a.ket")).toBe("/docs/./a.ket");
  });
});

describe("findTabByPath", () => {
  it("finds the tab holding the exact path", () => {
    expect(findTabByPath(oneOwnedTab(), WINDOWS_PATH)?.id).toBe("b");
  });

  it("finds the tab through a normalised equivalent path", () => {
    expect(findTabByPath(oneOwnedTab(), "c:/users/jorge/documents/benzene.ket/")?.id).toBe("b");
  });

  it("returns undefined for an unrelated or absent path", () => {
    expect(findTabByPath(oneOwnedTab(), POSIX_PATH)).toBeUndefined();
    expect(findTabByPath(emptyTabSet("a"), POSIX_PATH)).toBeUndefined();
  });
});

describe("tabOwningPath", () => {
  it("returns the tab owning the path", () => {
    expect(tabOwningPath(oneOwnedTab(), "C:\\Users\\jorge\\Documents\\Benzene.KET")?.id).toBe("b");
  });

  it("skips the excluded tab and still matches another tab", () => {
    let set = addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
    set = addTab(set, createTab("c", { path: POSIX_PATH }));

    expect(tabOwningPath(set, POSIX_PATH, "b")?.id).toBe("c");
    expect(tabOwningPath(set, WINDOWS_PATH, "c")?.id).toBe("b");
  });

  it("returns undefined when the only owner is excluded or the path is free", () => {
    expect(tabOwningPath(oneOwnedTab(), WINDOWS_PATH, "b")).toBeUndefined();
    expect(tabOwningPath(oneOwnedTab(), POSIX_PATH)).toBeUndefined();
  });
});

describe("resolveOpenTarget", () => {
  it("activates the tab that owns the path", () => {
    expect(resolveOpenTarget(oneOwnedTab(), WINDOWS_PATH)).toEqual({
      kind: "activate",
      tabId: "b",
    });
  });

  it("activates a non-active tab that owns the path", () => {
    let set = addTab(emptyTabSet("a"), createTab("b", { path: WINDOWS_PATH }));
    set = addTab(set, createTab("c"));
    set = { ...set, activeId: "c" };

    expect(resolveOpenTarget(set, "c:/users/jorge/documents/benzene.ket/")).toEqual({
      kind: "activate",
      tabId: "b",
    });
  });

  it("opens a free path", () => {
    expect(resolveOpenTarget(oneOwnedTab(), POSIX_PATH)).toEqual({ kind: "open" });
  });
});

describe("canSaveToPath", () => {
  it("allows the active tab to save to its own path", () => {
    expect(canSaveToPath(oneOwnedTab(), "C:\\Users\\jorge\\Documents\\Benzene.KET", "b")).toBe(
      true,
    );
  });

  it("refuses a path owned by another tab", () => {
    expect(canSaveToPath(oneOwnedTab(), WINDOWS_PATH, "a")).toBe(false);
  });

  it("allows a free path", () => {
    expect(canSaveToPath(oneOwnedTab(), POSIX_PATH, "a")).toBe(true);
  });
});

describe("ALREADY_OPEN_MESSAGE", () => {
  it("states the notice sentence exactly", () => {
    expect(ALREADY_OPEN_MESSAGE).toBe("This document is already open.");
  });
});
