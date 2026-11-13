import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tokens } from "./tokens";

const DIALOG_SOURCE = readFileSync(fileURLToPath(new URL("./Dialog.tsx", import.meta.url)), "utf8");

/** Serialized tokens catch stale palette values without pinning the object shape. */
const SERIALIZED_TOKENS = JSON.stringify(tokens);

/** Ketcher's `.Modal-module_modalOverlay` hatch, escaped exactly as Ketcher ships it. */
const KETCHER_BACKDROP =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Cpath d='M0 10 10 0zm12-2-4 4zM-2 2l4-4z' stroke='%23555' stroke-width='2' stroke-opacity='.02'/%3E%3C/svg%3E";

/** The decoded SVG, or `""` when the token is absent/malformed, so assertions report cleanly. */
const BACKDROP_SVG = (() => {
  const pattern = tokens.dialog.backdropPattern;
  if (typeof pattern !== "string") return "";
  const comma = pattern.indexOf(",");
  return comma === -1 ? "" : decodeURIComponent(pattern.slice(comma + 1));
})();

describe("tokens — dialog palette", () => {
  it("uses Ketcher's translucent overlay wash and drops the old opaque one", () => {
    expect(tokens.color.overlay).toBe("rgba(94,94,94,0.2)");
    expect(tokens.color.overlayHidden).toBe("rgba(94,94,94,0.01)");
    expect(SERIALIZED_TOKENS).not.toContain("rgba(94,94,94,0.8)");
  });

  it("exposes the dialog surface tokens", () => {
    expect(tokens.dialog.radius).toBe("8px");
    expect(tokens.dialog.border).toBe("none");
    expect(tokens.dialog.shadow).toBe("none");
    expect(tokens.dialog.transition).toBe("background-color 0.3s");
  });

  it("keeps generic radius and shadow for non-dialog surfaces", () => {
    expect(typeof tokens.radius).toBe("string");
    expect(tokens.radius.length).toBeGreaterThan(0);
    expect(typeof tokens.shadow).toBe("string");
    expect(tokens.shadow.length).toBeGreaterThan(0);
  });
});

describe("tokens — dialog backdrop hatch", () => {
  it("exposes Ketcher's 10×10 diagonal hatch as a decodable SVG data URI", () => {
    const pattern = tokens.dialog.backdropPattern;
    expect(pattern).toBe(KETCHER_BACKDROP);
    expect(pattern).toMatch(/^data:image\/svg\+xml/);
    expect(BACKDROP_SVG).toContain("width='10' height='10'");
    expect(BACKDROP_SVG).toContain("d='M0 10 10 0zm12-2-4 4zM-2 2l4-4z'");
    expect(BACKDROP_SVG).toContain("stroke='#555'");
    expect(BACKDROP_SVG).toContain("stroke-width='2'");
    expect(BACKDROP_SVG).toContain("stroke-opacity='.02'");
  });

  it("tiles the hatch at its native 10px size on repeat", () => {
    expect(tokens.dialog.backdropRepeat).toBe("repeat");
    expect(tokens.dialog.backdropSize).toBe("10px 10px");
  });

  it("keeps the 10×10 tile and the translucent overlay wash unchanged", () => {
    expect(BACKDROP_SVG).toContain("width='10'");
    expect(BACKDROP_SVG).toContain("height='10'");
    expect(tokens.color.overlay).toBe("rgba(94,94,94,0.2)");
  });
});

/** `url("${tokens.dialog.backdropPattern}")` — a bare data URI is dropped by CSS. */
const CSS_URL_WRAPPER = /url\(\s*["'`]\s*\$\{tokens\.dialog\.backdropPattern\}\s*["'`]\s*\)/;

describe("tokens — dialog backdrop is CSS-ready", () => {
  it("keeps the raw data URI token so callers own the CSS url() wrapper", () => {
    const pattern = tokens.dialog.backdropPattern;
    expect(pattern).toMatch(/^data:image\/svg\+xml/);
    expect(pattern.startsWith("url(")).toBe(false);
  });

  it("wraps the token in url() at the Dialog overlay", () => {
    expect(DIALOG_SOURCE).toMatch(CSS_URL_WRAPPER);
    expect(DIALOG_SOURCE).not.toContain("backgroundImage: tokens.dialog.backdropPattern");
  });

  it("keeps repeat and size on the same token-driven overlay", () => {
    expect(DIALOG_SOURCE).toContain("backgroundRepeat: tokens.dialog.backdropRepeat");
    expect(DIALOG_SOURCE).toContain("backgroundSize: tokens.dialog.backdropSize");
  });
});

describe("Dialog — single source of styling", () => {
  it("imports its palette from the tokens module", () => {
    expect(DIALOG_SOURCE).toContain('from "./tokens"');
  });

  it("paints the hatch overlay from the token, not a duplicated literal", () => {
    expect(DIALOG_SOURCE).toContain("tokens.dialog.backdropPattern");
    expect(DIALOG_SOURCE).not.toContain("data:image/svg+xml");
  });

  it("hardcodes no hex or rgba colour literal", () => {
    expect(DIALOG_SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(DIALOG_SOURCE).not.toMatch(/\brgba?\s*\(/);
  });
});
