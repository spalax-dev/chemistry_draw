import { describe, expect, it } from "vitest";

import {
  activateTab,
  activeTab,
  addTab,
  closeTab,
  commitEditor,
  createTab,
  decideTabsCloseGuard,
  dirtyTabs,
  EMPTY_KET,
  emptyTabSet,
  importedTab,
  isKetDocument,
  isUntouchedTab,
  tabTitle,
  updateTab,
  type TabSet,
} from "./tabs";

const BENZENE = "/home/jorge/Documents/benzene.ket";
const WINDOWS_BENZENE = "C:\\Users\\jorge\\Documents\\benzene.ket";

function threeTabs(): TabSet {
  let set = emptyTabSet("a");
  set = addTab(set, createTab("b", { path: BENZENE }));
  set = addTab(set, createTab("c", { path: WINDOWS_BENZENE }));
  return set;
}

function dirty(set: TabSet, id: string): TabSet {
  return commitEditor(set, id, '{"root":{}}');
}

describe("createTab", () => {
  it("creates an empty clean untitled tab", () => {
    expect(createTab("t1")).toEqual({
      id: "t1",
      path: null,
      ket: "",
      dirty: false,
    });
  });

  it("applies the partial init", () => {
    expect(createTab("t1", { path: BENZENE, ket: "{}", dirty: true })).toEqual({
      id: "t1",
      path: BENZENE,
      ket: "{}",
      dirty: true,
    });
  });

  it("does not let init override the id", () => {
    expect(createTab("t1", { path: BENZENE }).id).toBe("t1");
  });
});

describe("emptyTabSet", () => {
  it("holds one clean active tab", () => {
    const set = emptyTabSet("a");

    expect(set.activeId).toBe("a");
    expect(set.tabs).toHaveLength(1);
    expect(set.tabs[0]).toEqual({ id: "a", path: null, ket: "", dirty: false });
  });
});

describe("activateTab", () => {
  it("activates a known tab", () => {
    expect(activateTab(threeTabs(), "b").activeId).toBe("b");
  });

  it("keeps the active tab unchanged for an unknown id", () => {
    const set = threeTabs();

    expect(activateTab(set, "missing")).toEqual(set);
  });
});

describe("addTab", () => {
  it("appends the tab and activates it", () => {
    const set = addTab(threeTabs(), createTab("d", { path: BENZENE }));

    expect(set.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c", "d"]);
    expect(set.activeId).toBe("d");
  });
});

describe("updateTab", () => {
  it("patches the matching tab only", () => {
    const set = updateTab(threeTabs(), "b", { path: null, ket: "{}" });

    expect(set.tabs[1]).toEqual({
      id: "b",
      path: null,
      ket: "{}",
      dirty: false,
    });
    expect(set.tabs[0].path).toBeNull();
    expect(set.tabs[2].path).toBe(WINDOWS_BENZENE);
  });

  it("returns the set unchanged for an unknown id", () => {
    const set = threeTabs();

    expect(updateTab(set, "missing", { dirty: true })).toEqual(set);
  });
});

describe("commitEditor", () => {
  it("stores the content and keeps the tab dirty", () => {
    const set = commitEditor(threeTabs(), "b", '{"root":{"nodes":[]}}');

    expect(set.tabs[1].ket).toBe('{"root":{"nodes":[]}}');
    expect(set.tabs[1].dirty).toBe(true);
  });

  it("does not touch the other tabs", () => {
    const set = commitEditor(threeTabs(), "b", "{}");

    expect(set.tabs[0].ket).toBe("");
    expect(set.tabs[2].ket).toBe("");
  });
});

describe("closeTab", () => {
  it("activates the right neighbour when the active tab closes", () => {
    const set = closeTab(activateTab(threeTabs(), "b"), "b", "fresh");

    expect(set.tabs.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(set.activeId).toBe("c");
  });

  it("falls back to the left neighbour for the last tab", () => {
    const set = closeTab(activateTab(threeTabs(), "c"), "c", "fresh");

    expect(set.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(set.activeId).toBe("b");
  });

  it("keeps the active tab when another tab closes", () => {
    const set = closeTab(activateTab(threeTabs(), "b"), "a", "fresh");

    expect(set.tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
    expect(set.activeId).toBe("b");
  });

  it("yields a fresh empty tab when the last one closes", () => {
    expect(closeTab(emptyTabSet("a"), "a", "fresh")).toEqual(emptyTabSet("fresh"));
  });
});

describe("tabTitle", () => {
  it("shows Untitled without a path", () => {
    expect(tabTitle(createTab("a"))).toBe("Untitled");
  });

  it("shows the base name without .ket for a POSIX path", () => {
    expect(tabTitle(createTab("a", { path: BENZENE }))).toBe("benzene");
  });

  it("shows the base name without .ket for a Windows path", () => {
    expect(tabTitle(createTab("a", { path: WINDOWS_BENZENE }))).toBe("benzene");
  });

  it("marks a dirty tab with an asterisk", () => {
    expect(tabTitle(createTab("a", { path: BENZENE, dirty: true }))).toBe("benzene*");
  });

  it("marks a dirty untitled tab with an asterisk", () => {
    expect(tabTitle(createTab("a", { dirty: true }))).toBe("Untitled*");
  });
});

describe("activeTab", () => {
  it("returns the active tab", () => {
    expect(activeTab(activateTab(threeTabs(), "c")).id).toBe("c");
  });
});

describe("dirtyTabs", () => {
  it("returns only the dirty tabs", () => {
    const set = dirty(dirty(threeTabs(), "a"), "c");

    expect(dirtyTabs(set).map((tab) => tab.id)).toEqual(["a", "c"]);
  });

  it("returns no tabs when everything is clean", () => {
    expect(dirtyTabs(threeTabs())).toEqual([]);
  });
});

describe("isKetDocument", () => {
  it("allows an empty or blank string as the untouched tab", () => {
    expect(isKetDocument("")).toBe(true);
    expect(isKetDocument("   \n")).toBe(true);
  });

  it("accepts a JSON object carrying a root", () => {
    expect(isKetDocument(EMPTY_KET)).toBe(true);
    expect(isKetDocument('{"root":{"nodes":[{"type":"molecule"}]}}')).toBe(true);
  });

  it("rejects malformed JSON", () => {
    expect(isKetDocument('{"root":')).toBe(false);
    expect(isKetDocument("not json")).toBe(false);
  });

  it("rejects JSON without a root object", () => {
    expect(isKetDocument("{}")).toBe(false);
    expect(isKetDocument("[]")).toBe(false);
    expect(isKetDocument('"root"')).toBe(false);
    expect(isKetDocument("null")).toBe(false);
  });
});

describe("isUntouchedTab", () => {
  it("accepts a path-less clean tab with an empty structure", () => {
    expect(isUntouchedTab(createTab("a"))).toBe(true);
    expect(isUntouchedTab(createTab("a", { ket: EMPTY_KET }))).toBe(true);
    expect(isUntouchedTab(createTab("a", { ket: `  ${EMPTY_KET}\n` }))).toBe(true);
  });

  it("rejects a saved, dirty or non-empty tab", () => {
    expect(isUntouchedTab(createTab("a", { path: BENZENE }))).toBe(false);
    expect(isUntouchedTab(createTab("a", { dirty: true }))).toBe(false);
    expect(isUntouchedTab(createTab("a", { ket: '{"root":{"nodes":[1]}}' }))).toBe(false);
  });
});

describe("importedTab", () => {
  it("becomes a dirty tab without a path", () => {
    expect(importedTab("b", "C1=CC=CC=C1")).toEqual({
      id: "b",
      path: null,
      ket: "C1=CC=CC=C1",
      dirty: true,
    });
  });
});

describe("decideTabsCloseGuard", () => {
  it("closes when nothing is dirty, for every choice", () => {
    const set = threeTabs();

    expect(decideTabsCloseGuard(set, null)).toEqual({ action: "close" });
    expect(decideTabsCloseGuard(set, "save")).toEqual({ action: "close" });
    expect(decideTabsCloseGuard(set, "discard")).toEqual({ action: "close" });
    expect(decideTabsCloseGuard(set, "cancel")).toEqual({ action: "close" });
  });

  it("prompts for a dirty set without a choice", () => {
    expect(decideTabsCloseGuard(dirty(threeTabs(), "b"), null)).toEqual({
      action: "prompt",
    });
  });

  it("stays on cancel", () => {
    expect(decideTabsCloseGuard(dirty(threeTabs(), "b"), "cancel")).toEqual({
      action: "stay",
    });
  });

  it("discards on discard", () => {
    expect(decideTabsCloseGuard(dirty(threeTabs(), "b"), "discard")).toEqual({
      action: "discard",
    });
  });

  it("saves a single dirty active tab", () => {
    const set = dirty(activateTab(threeTabs(), "b"), "b");

    expect(decideTabsCloseGuard(set, "save")).toEqual({ action: "save" });
  });

  it("stays when the only dirty tab is not active", () => {
    const set = dirty(threeTabs(), "a");

    expect(decideTabsCloseGuard(set, "save")).toEqual({ action: "stay" });
  });

  it("stays when several tabs are dirty", () => {
    const set = dirty(dirty(threeTabs(), "a"), "b");

    expect(decideTabsCloseGuard(set, "save")).toEqual({ action: "stay" });
  });

  it("stays on save with several dirty tabs where only one is active", () => {
    const set = dirty(dirty(threeTabs(), "b"), "c");

    expect(decideTabsCloseGuard(set, "save")).toEqual({ action: "stay" });
  });
});
