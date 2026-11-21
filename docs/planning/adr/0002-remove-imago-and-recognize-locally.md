# 0002 — Remove Imago and recognize locally

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code on 2026-11-21; decided in Phase A)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

The 0.1.0 builds recognized structures through Imago: a bundled
`imago-worker`, `libimago.so` and three OpenCV libraries. That stack was large,
native, and duplicated what Ketcher already requested over HTTP. Phase A removed
it end to end, which temporarily removed recognition until the local pipeline
landed. The repository now ships no Imago library, worker or native dependency,
and `/v2/health` has no Imago fields.

The easy part was deleting code. The hard part is the boundary: Ketcher 3.18's
built-in **Recognize Molecule** control hardcodes the Imago job protocol
(`POST {apiPath}imago/uploads`, then `GET {apiPath}imago/uploads/:id`), and it
disables the control when `/v2/info` returns an empty `imago_versions` list. A
recognition feature therefore has to satisfy a client protocol named after a
backend it no longer uses.

## Decision

Remove Imago completely and recognize with a local, on-device pipeline:

1. Delete the Imago worker, library, routes, job format, native dependencies,
   packaging steps, CI checks and docs.
2. Replace recognition with two ONNX models: a binary structure filter (B1) and a
   hand-drawn OCSR model (B2), both from the model store.
3. Serve Ketcher's hardcoded job protocol as a **compatibility shim**:
   `transport/imago.rs` + `service/recognition.rs` implement the routes, states
   and `metadata.mol_str`, backed by filter → OCSR → Indigo.
4. Advertise one synthetic `imago_versions` entry (`local-ocsr`) only when the
   model artifacts are installed. It is capability advertisement for Ketcher, not
   an Imago build; `/v2/health` exposes no Imago data.
5. Keep the Ketcher boundary at the existing `parametrizeUrl` patch only; do not
   fork Ketcher to call a new endpoint.

The pipeline order is the contract: filter gate, OCSR (with incomplete and
confidence gates), SMILES → V2000 molfile through the same Indigo conversion the
editor uses.

## Alternatives considered

| Alternative                                         | Why not                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Keep Imago and add ONNX beside it                   | Two recognition stacks, OpenCV still shipped, and the reason for Phase A remains                      |
| Patch Ketcher to call `/v2/ocsr/recognize` directly | A second permanent fork and a new API; the shim keeps the Ketcher boundary at one patch               |
| Reimplement recognition in the webview (WASM)       | The product's premise is native Indigo and a small webview; WASM reintroduces the backend it replaced |
| Hide Recognize permanently                          | Removes a core feature the roadmap had already promised to restore                                    |

## Consequences

- **Positive:** no Imago/OpenCV in installers; the 0.1.0 → 0.1.6 comparison
  measured `.deb` 34,340,202 → 19,829,342 B (−42.26%) and AppImage 21,645,816 →
  16,955,896 B (−21.67%) on the same packaging pass (the delta also includes
  other changes since 0.1.0, so it is not purely Imago). Recognition runs offline
  with no cloud service.
- **Negative:** the removal was a breaking change: recognition was unavailable
  between Phase A and B2. The route names still say `imago`, and the synthetic
  capability is easy to misread as an Imago dependency.
- **Follow-up:** a Ketcher release that stops hardcoding the Imago protocol would
  let the shim retire; until then, a Ketcher upgrade must re-check the shim. The
  confidence gate and the OCSR quality are ADR 0006 and the parity work.

## References

- `docs/planning/architecture.md` §5.2 and §7, "Recognize Molecule compatibility
  flow".
- `docs/planning/sequences/recognition-flow.puml`.
- `docs/ROADMAP.md` Phase A and B2, including the measured package sizes.
- Related ADRs: 0004 (model delivery), 0006 (OCSR model).
