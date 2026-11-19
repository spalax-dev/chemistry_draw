/**
 * Backstage → Models: a reserved placeholder (`docs/conventions.md` §6.8).
 *
 * OCSR model management is not implemented yet, so the pane shows only a
 * heading and a muted note: no actions, no list, no invented model data.
 */

import { EMPTY_HINT, SECTION_TITLE } from "./sectionStyles";

export function ModelsSection() {
  return (
    <section aria-labelledby="backstage-models-title">
      <h2 id="backstage-models-title" style={SECTION_TITLE}>
        Models
      </h2>
      <p style={EMPTY_HINT}>OCSR models will be managed here.</p>
    </section>
  );
}
