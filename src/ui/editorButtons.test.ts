import { describe, expect, it } from "vitest";

import { EDITOR_BUTTONS } from "./editorButtons";

type ButtonEntry = { hidden?: boolean };

/**
 * Ketcher types `ButtonsConfig` with its own `ButtonName` union, which does not
 * list the native `save` button (`docs/conventions.md` §6.5). Widen the config
 * here so the assertions can look every key up by name.
 */
const config = EDITOR_BUTTONS as unknown as Record<string, ButtonEntry | undefined>;

const HIDDEN_BUTTONS = ["save"];

describe("EDITOR_BUTTONS", () => {
  it("hides the native Save As button", () => {
    expect(config.save?.hidden).toBe(true);
  });

  it("keeps Ketcher's built-in Recognize button visible", () => {
    expect(config.recognize).toBeUndefined();
  });

  it("hides nothing else", () => {
    expect(Object.keys(EDITOR_BUTTONS).sort()).toEqual([...HIDDEN_BUTTONS].sort());
  });

  it("only sets hidden and neither restyles nor disables a button", () => {
    const entries = Object.entries(config);

    expect(entries).toHaveLength(HIDDEN_BUTTONS.length);
    for (const [name, entry] of entries) {
      expect(Object.keys(entry ?? {}), name).toEqual(["hidden"]);
      expect(entry?.hidden, name).toBe(true);
    }
  });

  it("is a plain object Ketcher can read", () => {
    expect(typeof EDITOR_BUTTONS).toBe("object");
    expect(EDITOR_BUTTONS).not.toBeNull();
  });
});
