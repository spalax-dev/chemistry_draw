# 0006 — One hand-drawn OCSR model with a parity gate

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code on 2026-11-21; decided in B2 and Phase D)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

Recognition needs an optical chemical structure recognition (OCSR) model that
turns a filter-approved image into SMILES. Two DECIMER v2 exports were available:
a hand-drawn FP32 model and a printed model. A drawing app sees both hand-drawn
and printed input, so the choice is a compromise, not a domain match.

Measured canonical accuracy from the integration report:

| Evaluation set       | Hand-drawn FP32      | Printed model |
| -------------------- | -------------------- | ------------- |
| Hand-drawn canonical | **0.7300 (711/974)** | 0.677         |
| Printed canonical    | 0.694                | **0.704**     |

The hand-drawn model gives up 1.0 pp on printed images; the printed model loses
5.3 pp on hand-drawn input. A per-style router would add a second failure mode
and another model to download, with no measured win. CPU latency is p50 1115 ms /
p95 2156 ms.

Two further defects shaped the contract:

- A greedy decode can fall into a short token cycle and run to `max_len = 302`
  (one observed case took 37.3 s). Returning that partial SMILES would hand the
  editor a structure the model never finished.
- The confidence threshold is a measurement, not a preference: 0.901 is the
  in-domain hand-drawn value and has not been calibrated on real Chemistry Draw
  inputs.

## Decision

Pin **one** OCSR model, `ocsr-handdrawn-fp32` (provenance
`ocsr-handdrawn@zenodo:10781330`, CC-BY-4.0, 315,824,273 B across encoder,
decoder and vocabulary), with no router and no ensemble, and define the decode
contract around it:

1. **Greedy decode.** One encoder run produces `[1, 256, 512]` features; the
   decoder runs once per token from `start_id = 13` until `end_id = 14`, at most
   `max_len = 302` steps. The decoder output is already softmaxed; `argmax` is
   taken directly.
2. **Repetition guard.** After each non-end token, a pure bounded detector stops a
   two-token cycle repeated 16 times or one token repeated 32 times. The one-token
   tier is high because a repeated `C` is a legitimate alkane chain. The guard
   never truncates a result: the last id is not `end_id`, so the decode is
   `incomplete`.
3. **Incomplete is an error.** `POST /v2/ocsr/recognize` answers `422`; the
   compatibility job resolves `FAILURE`. A truncated SMILES is never returned.
4. **Confidence.** The single-image endpoint returns the mean chosen-token
   probability and does not gate on it. The Recognize compatibility flow gates on
   `confidence_threshold` from the manifest (`0.901`, provisional). Changing it
   requires a measured delta, a manifest update and a docs update.
5. **Preprocessing is frozen.** `decimer_ocsr` is a byte-compatible port of the
   toolchain pipeline; the classifier keeps its separate `runtime_default`. A
   change needs a measured evaluation delta, not a visual preference.
6. **Parity is the release evidence.** The Phase D `pilot300` run compares the
   shipped models with the toolchain's frozen predictions. The 2026-11-17 run
   passed both gates (classifier 0.7281, 166/228; OCSR canonical 0.7276, 211/290)
   and retained `0.000089` and `0.901`.

## Alternatives considered

| Alternative                                            | Why not                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Use the printed model only                             | Loses 5.3 pp on hand-drawn input, the primary use case of a drawing app                                                     |
| Route between hand-drawn and printed models            | A second model to download and a new misclassification failure mode, for a 1.0 pp printed gain                              |
| Return the partial SMILES when decoding stalls         | An unfinished structure is not a result; the editor would receive a wrong molecule                                          |
| Rely on a global timeout instead of a repetition guard | The 37.3 s decode is a detectable cycle; a timeout is a blunt bound and loses the actionable `incomplete` outcome           |
| Gate the single-image endpoint on confidence           | Callers that want the raw result (recalibration, parity) would lose it; the compatibility flow is where the UX gate belongs |
| Recalibrate the threshold in the same phase            | No real-input evidence yet; changing it without a measured delta violates the model rule                                    |

## Consequences

- **Positive:** one model serves every filter-approved image; the printed-domain
  loss is bounded to 1.0 pp; the guard bounds the pathological decode at 2.19 s
  with the same `422` semantics and zero per-image differences on the pilot300
  rerun; parity is reproducible.
- **Negative:** 0.7300 canonical accuracy is the ceiling on hand-drawn input;
  the ~316 MB pair must be downloaded; the threshold is provisional; the filter's
  multi-molecule false negatives still apply (146 of 250, ~58%), so "no molecule"
  is not proof.
- **Follow-up:** calibrate `0.901` on real Chemistry Draw inputs before treating
  it as final, and add performance baselines (US-02). Any geometry, vocabulary or
  guard change is a new ADR.

## References

- `docs/planning/architecture.md` §7 "OCSR inference contract" and "Recognize
  Molecule compatibility flow".
- `docs/benchmarks/model-parity.md`, `docs/benchmarks/ocsr-tail-fix.md`.
- `docs/planning/contracts.md` §3.4 and §4.
- Related ADRs: 0002 (local recognition), 0004 (model delivery).
