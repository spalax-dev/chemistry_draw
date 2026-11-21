# 0001 — Record architecture decisions

- **Status:** accepted
- **Date:** 2026-11-21
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

The 1.x line already had substantial architecture prose: `docs/architecture.md`
describes the shell, the sidecar, the model pipeline and the packaging in detail,
and `docs/ROADMAP.md` records phases and measured results. What it did not have
was a decision record. Why Imago was removed, why ONNX Runtime is loaded
dynamically, why models are downloaded instead of bundled, and why the repository
keeps two lines were facts spread across prose, commit history and memory.

Reconstruction from the code on 2026-11-21 made the gap concrete: several
decisions are load-bearing but have no single page that states the alternatives
and consequences.

## Decision

Record every decision that changes the foundation, a contract or a flow as a
numbered ADR under `docs/planning/adr/`.

- One decision per file, numbered sequentially, indexed in `README.md`.
- `0001` is this record and is never renumbered.
- A superseded ADR stays in place with `status: superseded by NNNN`.
- An ADR written after the fact is marked "reconstructed from the code on
  <date>"; it records the decision honestly, including open risks.
- The ADR is written in the same activity that takes or discovers the decision,
  together with the affected planning document or diagram.

## Alternatives considered

| Alternative                                   | Why not                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Keep decisions only in `docs/architecture.md` | The reference describes the current state; it does not preserve rejected options or the cost accepted |
| Keep decisions in commit messages             | Discoverable only with git archaeology, and rewritten by history hygiene                              |
| One large decisions document                  | Grows into a second architecture document and cannot be superseded per decision                       |

## Consequences

- **Positive:** a new contributor can see why the system is shaped this way, and a
  later change has to argue against a recorded alternative instead of silently
  reversing it.
- **Negative:** writing an ADR is extra work in the activity that takes the
  decision, and reconstructed ADRs carry the risk of rationalising the past.
- **Follow-up:** keep the index complete. A story that changes architecture
  without an ADR is a review finding.

## References

- `docs/planning/adr/README.md` — index and rules.
- `docs/planning/architecture.md` — current shape of the 1.x line.
- `docs/architecture.md` — detailed reference.
