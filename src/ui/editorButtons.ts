import type { ButtonsConfig } from "ketcher-react";

/**
 * Native top-toolbar entries this app replaces with its own commands
 * (`docs/conventions.md` §6.5). Hiding `save` drops Ketcher's own "Save as..."
 * button and its `Mod+s` action, so the app's `chemistry-draw:save` command
 * owns both.
 *
 * `recognize` is deliberately **not** hidden: the app uses Ketcher's built-in
 * Recognize Molecule dialog for the local ONNX/OCSR flow. The unused Imago
 * version selector inside that dialog is hidden by `src/overrides.css`.
 *
 * The cast is required because Ketcher's `ButtonName` union omits `save`, while
 * its runtime reads `options.buttons.save.hidden` (`isHidden`) and
 * `hiddenButtons.includes('save')` (`FileControls`). `ButtonsConfig` is only a
 * mapped type over that incomplete union, so the entry is real at runtime and
 * invisible to the type. The literal is asserted to `ButtonsConfig`; no `any`
 * is used.
 */
export const EDITOR_BUTTONS = {
  save: { hidden: true },
} as ButtonsConfig;
