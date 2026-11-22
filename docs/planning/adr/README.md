# Architecture Decision Records

> Every decision that changes the foundation, a contract or a flow gets one
> numbered file here. The index is the source of truth.

## Rules

1. One decision per file: `NNNN-kebab-title.md`, zero-padded and sequential.
2. `0001` records that ADRs exist; never renumber it.
3. A superseded ADR stays in place with `status: superseded by NNNN`.
4. The file is written in the activity that takes the decision, in its
   documentation step, and the index row is added in the same change.
5. An ADR that describes existing behaviour says so: "reconstructed from the code
   on YYYY-MM-DD". It is a record, not evidence that the decision was reviewed
   when it was first taken.

## Index

| ADR                                                | Title                                           | Status   | Date       |
| -------------------------------------------------- | ----------------------------------------------- | -------- | ---------- |
| [0001](0001-record-architecture-decisions.md)      | Record architecture decisions                   | accepted | 2026-11-21 |
| [0002](0002-remove-imago-and-recognize-locally.md) | Remove Imago and recognize locally              | accepted | 2026-11-21 |
| [0003](0003-dynamic-onnx-runtime-loading.md)       | Load ONNX Runtime dynamically                   | accepted | 2026-11-21 |
| [0004](0004-hugging-face-model-delivery.md)        | Deliver models from Hugging Face on demand      | accepted | 2026-11-21 |
| [0005](0005-ketcher-parametrizeurl-patch.md)       | Patch Ketcher per version through pnpm          | accepted | 2026-11-21 |
| [0006](0006-ocsr-single-model-parity.md)           | One hand-drawn OCSR model with a parity gate    | accepted | 2026-11-21 |
| [0007](0007-two-line-repository-model.md)          | Maintain two repository lines                   | accepted | 2026-11-21 |
| [0008](0008-adopt-two-stage-harness.md)            | Adopt the two-stage harness                     | accepted | 2026-11-21 |
| [0009](0009-update-1x-from-main-baseline.md)       | Update 1.x from the main 0.1.8 baseline         | accepted | 2026-11-21 |
| [0010](0010-app-integration-and-model-surface.md)  | Integrate the backstage with the 1.x ML surface | accepted | 2026-11-21 |

ADRs 0002–0007 were reconstructed from the code, the manifests and the existing
documentation on 2026-11-21. Their dates record the reconstruction, not the
original decision date; the original decisions were made during Phases A–D of
`docs/ROADMAP.md`.

## Template

Copy `adr-template.md` to `NNNN-<title>.md` and fill every section. Do not leave
a section as "TBD": an unanswered question is either an open question with an
owner or a reason the decision is not ready.
