import type { ButtonsConfig } from "ketcher-react";

/**
 * Native top-toolbar entries this app replaces with its own commands
 * (`docs/conventions.md` §6.5). Hiding `recognize` drops the structure
 * recognizer; hiding `save` drops Ketcher's own "Save as..." button and its
 * `Mod+s` action, so the File menu (§5.9) owns Save and Save As.
 *
 * Ketcher's native **Open** stays visible on purpose: it loads a structure into
 * the current canvas without adopting a name or path, while File → Open… opens
 * a `.ket` project and owns names, paths and the recent list
 * (`docs/architecture.md` §5.9).
 *
 * The cast is required because Ketcher's `ButtonName` union omits `save`, while
 * its runtime reads `options.buttons.save.hidden` (`isHidden`) and
 * `hiddenButtons.includes('save')` (`FileControls`). `ButtonsConfig` is only a
 * mapped type over that incomplete union, so the entry is real at runtime and
 * invisible to the type. The literal is asserted to `ButtonsConfig`; no `any`
 * is used.
 */
export const EDITOR_BUTTONS = {
  recognize: { hidden: true },
  save: { hidden: true },
} as ButtonsConfig;
