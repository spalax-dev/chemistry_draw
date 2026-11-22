# 0.x roadmap and backlog

> Durable backlog for the `main` (0.x) line. Stories are coarse; pick one at a
> time and derive activities for it. The 1.x line keeps its own `BACKLOG.md` on
> `develop`.

## US-L10N — Localize the Chemistry Draw chrome (last)

- status: pending
- priority: **last**; after the functional work and the rebranding.
- value: Ketcher already translates its editor, but the app-owned chrome
  (backstage, File menu, dialogs, error copy, model setup, About, tooltips) is
  English. A user who switches Ketcher to 简体中文 gets a half-translated app.
- acceptance:
  - every app-owned string lives in one catalog; components do not hardcode
    copy (no string concatenation for sentences)
  - the language follows the Ketcher selection (`ketcher-language`) and
    persists across launches; at least `en`, `es` and `zh-CN`, matching
    Ketcher's list where sensible
  - switching updates the chrome without a reload; chemistry symbols and
    structures stay Latin
  - pluralization/interpolation and accessibility labels are translated
  - catalog tests plus a manual checklist; no app-owned English left when a
    translation exists
- open questions:
  - the final language set and who reviews each translation;
  - whether sidecar error text is translated in the app or mapped from codes;
  - do we translate the About/licence text or keep the legal copy in English?

## BUG-E1-H — Add/Remove Explicit Hydrogens fails

- status: pending
- value: the Ketcher toolbar action currently errors because the sidecar does
  not implement the endpoint Ketcher 3.21 calls.
- evidence:
  - `ketcher-core@3.21.0` calls
    `POST {apiPath}indigo/convert_explicit_hydrogens`
    (`remoteStructService.toggleExplicitHydrogens`).
  - `src-tauri/sidecar/src/transport/indigo.rs` has no such route, so the
    request fails.
  - Indigo 1.49 exports `indigoFoldHydrogens`, `indigoUnfoldHydrogens`,
    `indigoFoldUnfoldHydrogens` and `indigoCountHydrogens`.
- acceptance:
  - add `POST /v2/indigo/convert_explicit_hydrogens` with the same
    struct/output-format contract as the other Indigo routes
  - toggling implicit ⇄ explicit H on ethanol/benzene preserves the molecule
    and atom count; a second toggle restores the original
  - a sidecar test covers the toggle and an invalid struct; the packaged UI
    action no longer reports an error
- open questions:
  - use `indigoFoldUnfoldHydrogens` directly or count + `Fold`/`Unfold`;
  - should the endpoint be idempotent per call (toggle) or take an explicit
    `mode`?

## DOC-E1-STEREO — Stereochemistry guide and verification

- status: pending
- value: the stereochemistry tools exist and the sidecar CIP endpoint works,
  but there is no worked example and users cannot tell how to test them.
- acceptance:
  - a guide: draw a real stereocenter (four different substituents), add a
    wedge/hash stereo bond, run **Calculate CIP**, and read the R/S labels
  - a committed fixture (lactic acid or a F/Cl/Br/I center) and a sidecar
    `/v2/indigo/calculate_cip` test
  - a manual checklist; explain that identical substituents produce no
    stereocenter and no CIP label
- open questions:
  - which surface is canonical (the stereochemistry panel vs the CIP action);
  - do we document the wedge/hash semantics separately from CIP?
