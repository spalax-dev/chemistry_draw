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

## BUG-EXP — Export formats error or write the wrong file

- status: pending
- value: Export is the only route to Molfile/SMILES/InChI/SVG/PNG; a failed or
  wrong export loses a deliverable the user cannot recover from the `.ket`.
- scope: `main` (0.x), Ketcher 3.21 + Indigo 1.49.
- acceptance:
  - reproduce every format from (a) benzene, (b) an imported `.mol`/`.smi`,
    (c) an untitled document and (d) a reaction (if the format is supported)
  - each export writes a non-empty file with the right extension and MIME:
    V2000/V3000 open in Indigo/Ketcher, SMILES/InChI are canonical, SVG/PNG
    render at the expected size
  - Export never changes the tab's path, format or dirty flag; the file name
    follows the tab precedence; the `.ket` is never overwritten
  - cancel writes nothing; an error names the format and is actionable
  - the Tauri save dialog can write to any path the app supports (the current
    capability scope is `$HOME/**` and `$APPDATA/**`; a user-chosen path
    outside it must fail with a clear message or be supported deliberately)
  - tests: `document.ts` export requests/names, a fake-Ketcher integration test
    for each source, plus the packaged manual checklist
- known suspects:
  - `getMolfile` throws for reaction arrows (expected; decide whether to offer
    RXN/SDF/RXN V3000 instead)
  - SVG goes through `writeTextFile` and PNG through `writeFile`; check the
    Blob MIME, extension and save-dialog filter
  - Ketcher 3.21 API: `getSmiles(isExtended)`, `getInchi(withAuxInfo)`,
    `getMolfile(format)`, `generateImage(ket, { outputFormat })`
  - server mode must be applied before export (the option-store adapter)
- open questions:
  - which format(s) fail, and what is the exact error/console output?
  - defaults: V2000 vs V3000, InChI with/without AuxInfo, SMILES extended?
  - is reaction export in scope (RXN/SDF) or explicitly out?
  - is the failure format-specific or the Tauri save path/scope?

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
