import { describe, expect, it } from "vitest";

import { CUSTOM_BUTTONS, TOOLBAR_ICON_STYLES, TRANSPARENT_ICON } from "./toolbarIcons";

const ALTS = ["Save", "New", "Export"] as const;

const EXPECTED_BUTTONS = [
  { id: "chemistry-draw:save", title: "Save" },
  { id: "chemistry-draw:new", title: "New" },
  { id: "chemistry-draw:export", title: "Export" },
];

const selectorFor = (alt: (typeof ALTS)[number]): string => `img[alt="${alt}"]`;

const ruleFor = (alt: (typeof ALTS)[number]): string => {
  const selector = selectorFor(alt);
  const match = TOOLBAR_ICON_STYLES.match(new RegExp(`[^{}]*\\[alt="${alt}"\\][^{}]*\\{[^}]*\\}`));
  return match?.[0] ?? selector;
};

const maskUris = (): string[] =>
  Array.from(
    TOOLBAR_ICON_STYLES.matchAll(/(?<!-webkit-)mask-image:\s*url\("([^"]+)"\)/g),
    (match) => match[1],
  );

/** The `d` attributes of the glyph paths inside one mask data URI. */
const maskPaths = (uri: string): string[] =>
  Array.from(uri.matchAll(/ d='([^']+)'/g), (match) => match[1]);

describe("TRANSPARENT_ICON", () => {
  it("is an inline SVG data URI", () => {
    expect(TRANSPARENT_ICON).toMatch(/^data:image\/svg\+xml/);
  });

  it("draws no glyph and sets no stroke colour", () => {
    const icon = TRANSPARENT_ICON.toLowerCase();
    expect(icon).not.toContain("<path");
    expect(icon).not.toContain("%3cpath");
    expect(icon).not.toContain("stroke");
  });
});

describe("CUSTOM_BUTTONS", () => {
  it("has exactly the three stable ids and titles", () => {
    expect(CUSTOM_BUTTONS).toHaveLength(3);
    expect(CUSTOM_BUTTONS.map((button) => button.id)).toEqual(EXPECTED_BUTTONS.map((b) => b.id));
    expect(CUSTOM_BUTTONS.map((button) => button.title)).toEqual(
      EXPECTED_BUTTONS.map((button) => button.title),
    );
  });

  it("uses the transparent icon for every button", () => {
    expect(CUSTOM_BUTTONS.map((button) => button.imageLink)).toEqual([
      TRANSPARENT_ICON,
      TRANSPARENT_ICON,
      TRANSPARENT_ICON,
    ]);
  });
});

describe("TOOLBAR_ICON_STYLES", () => {
  it("is scoped to Ketcher's root", () => {
    expect(TOOLBAR_ICON_STYLES).toContain(".Ketcher-root");
  });

  it("has exactly one selector per alt", () => {
    for (const alt of ALTS) {
      expect(TOOLBAR_ICON_STYLES.split(selectorFor(alt)).length - 1).toBe(1);
    }
  });

  it("paints each glyph with currentColor through a mask", () => {
    for (const alt of ALTS) {
      const rule = ruleFor(alt);
      expect(rule).toContain(selectorFor(alt));
      expect(rule).toContain("background-color: currentColor");
      expect(rule).toContain('mask-image: url("data:image/svg+xml');
      expect(rule).toContain('-webkit-mask-image: url("data:image/svg+xml');
    }
  });

  it("contains no literal colour", () => {
    expect(TOOLBAR_ICON_STYLES).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(TOOLBAR_ICON_STYLES).not.toMatch(/%23[0-9a-f]{3}/i);
    expect(TOOLBAR_ICON_STYLES).not.toMatch(/\b(?:black|white|red|blue|green|grey|gray|silver)\b/i);
    expect(TOOLBAR_ICON_STYLES).not.toContain("525252");
  });

  it("draws outline glyphs inside the 15x15 live area", () => {
    for (const uri of maskUris()) {
      expect(uri).toContain("fill='none'");
      expect(uri).toContain("stroke-width='1.5'");
      expect(uri).toContain("stroke-linecap='round'");
      expect(uri).toContain("stroke-linejoin='round'");

      const coordinates = maskPaths(uri).flatMap(
        (d) => d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [],
      );
      expect(coordinates.length).toBeGreaterThan(0);
      for (const value of coordinates) {
        expect(value).toBeGreaterThanOrEqual(5.25);
        expect(value).toBeLessThanOrEqual(18.75);
      }
    }
  });

  it("parses into three rules with three distinct mask data URIs", () => {
    expect(TOOLBAR_ICON_STYLES.match(/(?<!-webkit-)mask-image:/g)).toHaveLength(3);
    expect(TOOLBAR_ICON_STYLES.match(/\{[^}]*\}/g)).toHaveLength(3);

    const uris = maskUris();
    expect(uris).toHaveLength(3);
    expect(new Set(uris).size).toBe(3);
  });
});
