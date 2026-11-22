/**
 * Backstage → Models: a route to the real model setup, never a fake picker
 * (`docs/architecture.md` §5.1, ADR 0009).
 *
 * The 1.x line keeps the Models toolbar entry and `ModelSetupDialog` as the only
 * model surface. This pane renders one honest action when `App` wires
 * `onOpenModels` (ACT-05) and a muted hint otherwise: no model list, no fake
 * counters and no download controls of its own.
 */

import { Button } from "../Button";
import { EMPTY_HINT, SECTION_TITLE } from "./sectionStyles";

/** Props of the Models pane; the real dialog is owned by `App`. */
export interface ModelsSectionProps {
  /** Opens `ModelSetupDialog`; absent until ACT-05 wires the App handler. */
  onOpenModels?: () => void;
}

/**
 * The Models rail pane. It only routes to the existing model-setup dialog and
 * never renders model data, so it cannot drift from the real setup surface.
 */
export function ModelsSection({ onOpenModels }: ModelsSectionProps) {
  return (
    <section aria-labelledby="backstage-models-title">
      <h2 id="backstage-models-title" style={SECTION_TITLE}>
        Models
      </h2>
      {onOpenModels === undefined ? (
        <p style={EMPTY_HINT}>
          Use the Models entry in the editor toolbar to manage the OCSR models.
        </p>
      ) : (
        <>
          <p style={EMPTY_HINT}>
            Download, verify and repair the local OCSR models in the model setup dialog.
          </p>
          <Button onClick={onOpenModels}>Open model setup</Button>
        </>
      )}
    </section>
  );
}
