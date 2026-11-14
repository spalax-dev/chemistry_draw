import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tokens } from "./ui/tokens";

/**
 * The tab strip is a CSS-only React component: this suite runs with
 * `environment: "node"` and has no DOM renderer, and its contract is a handful
 * of inline style values rather than behaviour. These tests therefore scan the
 * token module and the component source, the same contract-test approach as
 * `ui/tokens.test.ts` and `capabilities.test.ts`, instead of rendering it.
 *
 * The rules under test (`docs/conventions.md` section 6.6): the strip keeps its
 * `#eff2f5` background and draws the separator in two layers. The strip's
 * `inset 0 -1px 0 #cad3dd` box shadow covers the left padding, the gaps and the
 * area after the last tab; every **inactive** tab draws its own 1 px
 * `tokens.tab.border` bottom edge, so the line is continuous under the tabs
 * too. The active tab is the white workspace surface, draws no bottom edge and
 * covers the inset line under its width. Tabs sit flush (`gap: 0`) and carry
 * top/left/right edges on every tab.
 */
const STRIP_SOURCE = readFileSync(
  fileURLToPath(new URL("./ui/TabStrip.tsx", import.meta.url)),
  "utf8",
);

/** Source slice of an object literal declaration, ending at its closing `};`. */
function styleBlock(declaration: string): string {
  const start = STRIP_SOURCE.indexOf(declaration);
  if (start === -1) return "";
  const rest = STRIP_SOURCE.slice(start);
  const end = rest.search(/\n\s*\};/);
  return end === -1 ? "" : rest.slice(0, end);
}

/** One property of a style block, up to its trailing comma. */
function declaration(block: string, property: string): string {
  const start = block.indexOf(`${property}:`);
  if (start === -1) return "";
  const end = block.indexOf(",\n", start);
  return end === -1 ? block.slice(start) : block.slice(start, end);
}

const STRIP_STYLE = styleBlock("const STRIP: CSSProperties = {");
const TAB_ITEM_STYLE = styleBlock("const style: CSSProperties = {");
const STRIP_SHADOW = declaration(STRIP_STYLE, "boxShadow");
const TAB_BOTTOM = declaration(TAB_ITEM_STYLE, "borderBottom");

describe("tab strip — active tab accent", () => {
  it("paints the active tab with the white workspace surface, not Ketcher's grey", () => {
    expect(tokens.tab.active).toBe(tokens.color.surface);
    expect(tokens.tab.active.toLowerCase()).toBe("#ffffff");
    expect(JSON.stringify(tokens)).not.toContain("#e1e5ea");
  });
});

describe("tab strip — two separator layers", () => {
  it("draws the free-area separator as an inset shadow on the strip", () => {
    expect(STRIP_STYLE).not.toBe("");
    expect(STRIP_STYLE).toContain("background: tokens.tab.content");
    expect(STRIP_STYLE).not.toContain("borderBottom");
    expect(STRIP_SHADOW).not.toBe("");
    expect(STRIP_SHADOW).toContain("inset 0 -1px 0");
    expect(STRIP_SHADOW).toContain("tokens.tab.border");
    expect(STRIP_SHADOW).not.toContain("-2px");
  });

  it("draws no all-sides tab border", () => {
    expect(TAB_ITEM_STYLE).not.toBe("");
    expect(TAB_ITEM_STYLE).not.toMatch(/(^|\s)border:\s/);
  });

  it("draws top/left/right tab edges on every tab", () => {
    expect(TAB_ITEM_STYLE).toContain("borderTop:");
    expect(TAB_ITEM_STYLE).toContain("borderLeft:");
    expect(TAB_ITEM_STYLE).toContain("borderRight:");
  });

  it("draws the separator under inactive tabs as a 1 px bottom edge", () => {
    expect(tokens.borderWidth).toBe("1px");
    expect(TAB_BOTTOM).not.toBe("");
    expect(TAB_BOTTOM).toContain("tokens.borderWidth");
    expect(TAB_BOTTOM).toContain("tokens.tab.border");
    expect(TAB_BOTTOM).not.toContain("2px");
  });

  it("leaves the active tab as the only tab without the bottom edge", () => {
    // The bottom edge is a single conditional declaration on the shared tab
    // style: `active ? "none" : ...`, so the active tab is the only one skipped.
    expect(TAB_BOTTOM).toMatch(/borderBottom:\s*active\s*\?\s*"none"\s*:/);
    expect(STRIP_SOURCE.match(/borderBottom:/g) ?? []).toHaveLength(1);
  });
});

describe("tab strip — continuous line", () => {
  it("sits tabs flush with no gap", () => {
    expect(STRIP_STYLE).toContain("gap: 0");
    expect(STRIP_STYLE).not.toMatch(/\bgap:\s*[1-9]\d*(?:px)?\s*,/);
  });
});
