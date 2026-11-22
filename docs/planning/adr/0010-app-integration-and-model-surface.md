# 0010 — Integrate the backstage workflow with the 1.x ML surface

- **Status:** accepted
- **Date:** 2026-11-21
- **Activity:** ACT-05 (US-01, app-model-integration)
- **Deciders:** Repository owner
- **Base line:** `develop` (1.x)

## Context

ADR 0009 ports the `main` 0.1.8 workflow onto the 1.x line. ACT-03 landed the
pure workflow models and the presentational backstage, tab strip, File menu and
templates. The remaining work is the single integration point: `src/App.tsx`,
the Models dialog and the Ketcher toolbar.

The two lines still differ where the integration happens:

- `develop` has one document, the local ONNX filter/OCSR recognizer, the
  `/v2/imago/uploads` compatibility shim, model download/verify/repair, the
  Models toolbar control and the real `ModelSetupDialog`.
- `main` has the backstage, the tab set, the File menu, per-tab recovery and a
  placeholder Models rail entry; its `App.tsx` has no recognizer or model setup.

Replacing `develop`'s `App.tsx` with `main`'s would delete the ML surface.
Keeping both Apps is not possible: the window has one Ketcher instance and one
command dispatcher.

## Decision

1. **Start from the 1.x `App.tsx` and port `main`'s workflow into it.** The
   result keeps develop's `StaleSafeStructServiceProvider`, the `/v2/info`
   capability sync, the model status/action/poll loop and the real
   `ModelSetupDialog`; it takes main's backstage, tabs, file commands, close
   guard and recovery snapshots. Imago product code is not imported.
2. **One command path, two entry points.** The File menu is the complete
   document command surface. The 1.x top toolbar keeps its **Save**, **New**,
   **Export** and **Models** controls: the first three dispatch the same
   tab-aware commands as the File menu, and **Models** opens the real setup
   dialog. No toolbar command reimplements a save, open or export rule.
3. **The Models rail routes to the real dialog.** `Backstage` receives
   `onOpenModels`; the rail button opens `ModelSetupDialog` above the overlay
   instead of rendering a fake model list. The overlay stays behind the dialog,
   so closing setup returns to the backstage. A clean install still auto-opens
   the setup dialog once, now above the Welcome pane; it is not suppressed.
4. **No native message boxes.** The 1.x policy is in-app dialogs
   (`contracts.md` §5). Recognition and editor errors use `ErrorDialog` with
   `describeError`; already-open paths use `NoticeDialog`; save/export failures
   use `ErrorDialog`. No `@tauri-apps/plugin-dialog` `message` call is added.
5. **Silent tab restore replaces the single-document recovery prompt.**
   `readTabSet` loads the tab set before the editor is ready and the active tab
   is loaded behind the loading flag. `RecoveryDialog` and the single-document
   `autosaveStore` flow leave `App.tsx`; the per-tab `tabStore` is the only
   snapshot writer. An imported structure is serialized with `getKet` before
   its snapshot is written, so the `.ket` snapshot validator can restore it on
   the next launch.
6. **Dialogs block document shortcuts.** The backstage, Models setup, Export,
   the close prompt, an error and a notice all count as an open dialog for the
   capture-phase shortcut handler. The File popup is dismissed by the first
   matched combination and consumes it. `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O`,
   `Ctrl+N`, `Ctrl+W`, `Ctrl+T` and `Ctrl+Tab` never reach Ketcher; `Ctrl+W`
   closes the active tab and `Ctrl+Tab` cycles the strip.
7. **The close guard is the tab matrix from `contracts.md` §5.** No dirty tab
   closes; one dirty active tab offers Save/Discard/Cancel; one dirty inactive
   tab or several dirty tabs offer Discard/Cancel. Discard removes only the
   dirty snapshots and rewrites the index with the clean survivors.

## Alternatives considered

| Alternative                                             | Why not                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Replace `develop`'s `App.tsx` with `main`'s             | Drops the recognizer, model setup and sidecar capability sync, reversing ADR 0002/0009                         |
| Keep `main`'s placeholder Models rail entry             | Ships a fake model surface next to the real one and contradicts ADR 0009                                       |
| Hide the 1.x Save/New/Export toolbar buttons            | Removes working 1.x controls; the File menu is additive, not a replacement for the toolbar                     |
| Keep the single-document recovery prompt alongside tabs | Two snapshot formats and two launch flows; `main` restores the tab set silently                                |
| Use native `message()` for errors as `main` does        | The 1.x in-app dialog policy is documented in `contracts.md` §5; native boxes break the Ketcher-styled surface |

## Consequences

- **Positive:** 1.x launches into the real backstage, gains the complete file
  workflow and keeps its ML capability, Models dialog and sidecar contract
  unchanged. One command dispatcher owns saves, tab switches, shortcuts and the
  close guard, so the File menu and the toolbar cannot drift.
- **Negative:** Save/New/Export exist both in the File menu and on the toolbar;
  both call the same command, but the duplication must be reviewed if the
  toolbar is redesigned. The single-document `autosaveStore.ts` and
  `shouldOfferRecovery` remain exported without a caller after the port and
  need a cleanup activity.
- **Follow-up:** ACT-06 runs the story gates and the GUI checklist. Removing the
  unused single-document recovery module is a separate cleanup; it is not
  deleted here because it is outside this activity's `touches`.

## References

- [`0009`](0009-update-1x-from-main-baseline.md) — the port and its conflict
  rule.
- [`0002`](0002-remove-imago-and-recognize-locally.md),
  [`0003`](0003-dynamic-onnx-runtime-loading.md),
  [`0004`](0004-hugging-face-model-delivery.md),
  [`0006`](0006-ocsr-single-model-parity.md) — the ML decisions that stay.
- `docs/planning/architecture.md` §5.1, §5.3, §5.4.
- `docs/planning/contracts.md` §5.
- `docs/planning/sequences/backstage-file-workflow.puml`.
