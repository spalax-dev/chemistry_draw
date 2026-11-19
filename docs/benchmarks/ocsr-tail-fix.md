# OCSR incomplete-tail fix — Phase D follow-up

> **Status: implemented and measured (2026-11-18).** The Phase D model-parity
> pilot found one pathological OCSR decode, `hdm::CDK_Depict_5_82`, that
> alternated `C=` to `max_len = 302` and answered HTTP `422` after **37.3 s**.
> This activity bounds that tail with a **repetition guard** in the greedy loop
> and proves the pilot300 metrics do not move: the row now answers `422` in
> **2.19 s** with **0** per-image differences over the 300 rows. §9 records the
> measured values; `[task c]` placeholders have been replaced.

## 1. Purpose and scope

The parity pilot is complete and its gates passed
(`docs/benchmarks/model-parity.md` §4). It left one **performance** finding, not
a parity failure: a single hand-drawn image drives the greedy decoder into a
short token cycle until `max_len`. The request is answered correctly (`422`, an
incomplete decode is not a result), but it holds the decoder for 37.3 s, about
19× the mean answered-row time, and the app has no earlier stop.

**In scope:** a bounded, deterministic **periodic-tail guard** inside
`greedy_decode`; fake-decoder tests for it; a pilot300 before/after measurement
proving the metrics and per-image decisions are unchanged.

**Out of scope:** changing `max_len`, the model, the start/end ids, the
vocabulary, the confidence threshold, `decimer_ocsr` preprocessing, the `422`
contract, the `/v2/imago` job protocol, or the normal decode path. This is not a
parity rerun gate: the accepted pilot result stands, and this activity only
removes wasted work on a row that is already an error.

## 2. Observed failure

The row is from the frozen hand-drawn pilot300 split (same IDs, same inputs as
the parity pilot; `$TOOLCHAIN` is the external checkout, §2 of
`docs/benchmarks/model-parity.md`).

| Item                    | Value                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Row id                  | `hdm::CDK_Depict_5_82`                                                                                                                                                               |
| Image                   | `$TOOLCHAIN/data/benchmark/handdrawn-hdm/DECIMER_HDM_Dataset_Images/CDK_Depict_5_82.png`                                                                                             |
| Expected SMILES         | `N=[S-](=S=S=S=S=S=S=S=S=S=S=S=[Y]I)O` (canonical: `N=[S-](O)=S=S=S=S=S=S=S=S=S=S=[S]=[Y][I]`)                                                                                       |
| Toolchain reference got | 302-character `C=C=…=` chain (151 `C`, 151 `=`), `valid: false`, `incomplete: true`, cached latency 0 ms                                                                             |
| Sidecar response        | HTTP `422`, no `smiles` field                                                                                                                                                        |
| Sidecar latency         | **37,270.662 ms** HTTP round trip; the sidecar log records `OCSR inference 37239.7 ms: 303 tokens, confidence 0.7944, incomplete`                                                    |
| Decode                  | `max_len = 302` steps consumed: 303 ids including `start_id`; the reference output is the 2-token cycle `C`, `=` repeated 151 times. §9.1 records the exact sidecar ids and pattern. |
| Raw run                 | `target/benchmarks/model-parity/2026-11-18T02-27-34-439Z/details.jsonl`                                                                                                              |
| Reference row           | `$TOOLCHAIN/data/benchmark/pilot/handdrawn.fp32.pilot300.json`, `details[id == "hdm::CDK_Depict_5_82"]`                                                                              |

The image is a long polysulfur drawing. The model never emits `end_id` for it
and settles into the shortest possible SMILES loop; the toolchain reference does
the same, so this is model behaviour on one input, not a port defect. The app
already classifies the row correctly: **invalid, exact failure, not comparable**
in the parity metrics.

**Why `max_len` is not the fix.** The loop already stops at `max_len = 302`; the
cost is that all 302 steps run, and a truncated structure is still an error.
Lowering `max_len` would apply to _every_ image, including legitimate structures
that need a long decode: the pilot's longest complete decode is 192 ids
(191 generated tokens), but the contract and the reference allow up to 302, and
a real structure outside the pilot could use the full budget. Any `max_len`
change changes results for valid inputs and needs its own measured evaluation.
It also would not make the pathological row a success: truncating at 100 or 150
steps returns the same `422` after less work, but silently shrinks the model's
competence for every drawing. The fix therefore keeps `max_len = 302` as the
hard bound and adds only an earlier stop for a **pathological periodic tail**.

## 3. Decode contract (unchanged)

`src-tauri/sidecar/src/service/ml/ocsr_decode.rs`:

1. The encoder runs once per image and produces `enc_out`.
2. The decoder-step graph runs once per emitted token: the whole token sequence
   (start id plus generated ids) and the unchanged `enc_out` go in; the last
   position's `[156]` row holds the next-token probabilities, already softmaxed.
3. `argmax` of that row is appended; its probability is recorded for the
   confidence mean.
4. The loop stops after appending `end_id = 14`, or after `max_len = 302`
   decoding steps.
5. `incomplete` is `true` when the last id is not `end_id`; otherwise `false`.

`start_id` (13), `end_id` (14), `max_len` (302) and `confidence_threshold`
(0.901) come from the manifest and are not part of this change.

Transport consequences:

| Path                            | Behaviour today                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/ocsr/recognize`       | Synchronous. An incomplete decode is `422` with `{"error": "could not finish the structure; try a sharper image"}`, and no `smiles` field. The client waits for the full decode before the error.                                                                                                                                               |
| `POST /v2/imago/uploads` + poll | The worker runs the same decode in `spawn_blocking` with a 120 s `PROCESSING_TIMEOUT`; an incomplete decode (or a confidence below the gate) becomes a `FAILURE` job. The 37.3 s row is inside the 120 s bound, so the bound is **not** a fix: it only converts a slow failure into a later failure, and the direct endpoint has no such bound. |
| Completion                      | Both paths keep their current mapping: the guard never turns an incomplete decode into a result.                                                                                                                                                                                                                                                |

The guard changes only **how many decoder steps run before the existing
`incomplete` decision is made**, so both transports and their error copy stay
byte-identical.

## 4. Guard design

### 4.1 Detection

Inside the greedy loop, after appending a token that is **not** `end_id`, inspect
the emitted suffix (the generated tokens, excluding `start_id`) with a bounded
periodic-tail detector:

- Let `k` be the shortest period such that the last `R · k` emitted tokens are
  exactly `R` consecutive repetitions of the `k`-token cycle. The detector only
  considers `k <= K`, where `K` is the maximum cycle length.
- The guard fires when such a cycle is found with `k <= K` and at least `R`
  complete repetitions. `C`, `=` is the `k = 2` case; `R` is the number of
  repeats required.
- A one-token run (`k = 1`) is a legitimate alkane chain (`C`, `C`, …), so it
  has its own threshold `R₁`, far above the two-token `R`. It still bounds a
  decoder stuck on one id, without cutting a long chain.
- `end_id` is never part of a cycle. If `end_id` arrives before the threshold,
  the decode completes normally and the guard never fires.
- The check is pure and local: no model call, no timing, no I/O, no randomness.
  The same emitted ids always trigger at the same step.

`K`, `R` and `R₁` are module constants owned by the decode module. The measured
pilot300 values (§9) are **`K = 2`, `R = 16`, `R₁ = 32`**: the longest
legitimate two-token cycle is 6 repeats (`hdm::CDK_Depict_1_23`, `O`, `)`), so
`R = 16` has a 2.67× margin; the longest legitimate one-token run is 8 `C`
(`hdm::CDK_Depict_36_181`, octyl), so `R₁ = 32` has a 4× margin and tolerates a
C31 alkane. `K = 2` targets the measured failure exactly; the pilot's
legitimate 3- and 4-token periodic runs (maximum 4 and 3 complete repeats) stay
unguarded, and a future pathological 3-cycle would need raising `K` with a
measured example.

### 4.2 Semantics

When the guard fires:

- the loop breaks **before** another decoder step, and the partial ids and their
  probabilities are returned unchanged;
- the last id is not `end_id`, so `incomplete` stays `true` by the existing
  definition (`ids.last() != Some(&end_id)`);
- `/v2/ocsr/recognize` answers the same `422` with the same message and no
  `smiles`; `/v2/imago` fails the job with the same incomplete message;
- the parity harness classifies the row exactly as before — **invalid, exact
  failure, not comparable** — because a `422` is not a result and the guard
  never emits one.

Invariants:

- `max_len = 302`, the model, the start/end ids, the vocabulary, the thresholds,
  preprocessing and the transport mappings are unchanged.
- A decode without a qualifying periodic tail is unaffected: same steps, same
  ids, same probabilities, same SMILES.
- The guard is deterministic, so fake-decoder tests pin the exact stop step.

### 4.3 Rejected alternatives

| Alternative                          | Why not                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Lower `max_len`                      | Changes every image's budget; risks truncating legitimate long structures; changes model results and needs a separate accuracy evaluation. |
| Wall-clock timeout inside the decode | Non-deterministic, untestable with a fake decoder, still wastes the time, and makes the same input fail differently on different machines. |
| Confidence cutoff on the loop        | Different contract (the threshold is informational for the single-image endpoint) and does not address a high-confidence periodic loop.    |
| Model/threshold/preprocessing change | The reference model shows the same behaviour; this is a bounded-work fix, not a model-quality fix.                                         |
| Per-image blocklist                  | Does not generalise to the next image with the same failure mode and leaks benchmark IDs into production.                                  |

The repetition guard is the only option that is bounded, deterministic, purely
local to the emitted tokens, and invisible to every decode that is not
pathological.

## 5. Test cases (task `b`)

All cases run in the always-run tier against `FakeGraphs`, with no ONNX model
and no runtime (the same fake that pins the greedy loop today). Each test
asserts ids, probability count, `incomplete` and decoder-call count. The
short-cycle cases also pin every token sequence fed to the model; the long runs
assert counts and ids only; the pathological case pins the last prefix.

| Case                                   | Setup                                                                     | Expected                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One-token run                          | The same non-EOS id repeated after `start_id`                             | Guard fires at the configured run length; `incomplete = true`; no `end_id`                             |
| Long alkane run (one-token tier)       | 20 `C` ids then `end_id`                                                  | Guard **does not** fire below `R₁`; the chain is intact and `end_id` completes the decode              |
| Production one-token run               | The same non-`end_id` id repeated every step with the production guard    | Guard fires exactly at `R₁` (33 ids: `start_id` + 32 tokens); `incomplete = true`; `R₁` decoder calls  |
| Two-token cycle                        | `C`, `=` alternation (`k = 2`)                                            | Guard fires early; token count far below 302; `incomplete = true`                                      |
| Legitimate repeated motif below cutoff | A repeated ring/chain motif shorter than the threshold, then `end_id`     | Guard **does not** fire; the decode completes; the motif is intact                                     |
| EOS before the threshold               | A short repeating prefix followed by `end_id` before the required repeats | Normal stop at `end_id`; `incomplete = false`; guard never fires                                       |
| Non-repetitive long decode             | Distinct tokens up to `max_len`, no cycle                                 | Guard never fires; stops at `max_len` with `incomplete = true` (existing behaviour preserved)          |
| Pathological `C=` pattern              | 302 alternating `C`, `=` tokens, as in `hdm::CDK_Depict_5_82`             | Guard fires at the threshold; `incomplete = true`; ids length well below 303; exact stop step asserted |

The production one-token case (`tests/ocsr.rs:1246`, `ocsr_greedy_decode_guard_stops_a_long_single_token_run`)
derives its expected stop from `single_token_repeats`, so it pins the production
threshold instead of the tiny test guard.

**Mutation rule.** The tests must fail when the guard is broken:

- a guard that never fires fails the one-token and `C=` cases;
- a guard that applies the two-token threshold to a one-token run fails the
  long-alkane case;
- a guard that fires on a legitimate repeated motif fails the below-cutoff case;
- a guard that fires before `end_id` or changes normal stopping fails the EOS
  case;
- a guard that replaces/delays the `max_len` stop fails the non-repetitive long
  decode;
- a detector with the wrong cycle length, the wrong repeat count, or a
  boundary error (`R - 1` fires, `R` does not) fails at least one case.

The guard is pure and model-free, so it needs no model-gated test and no
`#[ignore]`; the pathological row itself is covered by the manual pilot check
(`docs/verification.md`) and by task `c`'s measurement, never by a committed
300 MB fixture.

## 6. Measurement protocol (task `c`)

Run on the same machine and the **release** binary as the accepted parity run,
with the pilot prerequisites from `docs/verification.md` §2.

1. **Capture the pre-guard token sequences.** Instrument the pilot300 OCSR run
   (temporary logging or a bench-only dump; the committed code keeps no
   token-sequence log) and record, per row: id, emitted ids, token count and
   status. The pathological row is expected to be `[start, C, =, C, =, …]` with
   151 `C`/`=` cycles after the start id. This was done with a temporary
   `CHEMISTRY_OCSR_TRACE` file append in `ocsr.rs` (one comma-separated id line
   per decode, matched to `details.jsonl` order); the instrumentation was
   removed before the final diff and only the summary below is kept.
2. **Measure the legitimate periodic runs.** Run the same detector offline over
   every captured sequence (period `k <= K`, all `k`) and record the longest
   periodic tail per row, in tokens and in complete cycles, plus the row id and
   pattern. Record the maximum over the 299 answered rows. For context, the
   accepted run's longest complete decode is 192 ids; the 302-cycle row must be
   an outlier by a wide margin.
3. **Choose the guard with margin.** Pick `K` and `R` so the threshold sits
   above the longest legitimate periodic run with a documented margin, and below
   the pathological row (151 cycles). Record `K`, `R`, the largest legitimate
   run, the margin and the rationale in §7/§9. Tune only these constants; never
   `max_len`.
4. **Rerun the pilot300 with the guard** (same split, same sidecar, release
   build, raw output under `target/benchmarks/`):

   ```bash
   node scripts/model-parity.mjs --suite handdrawn --split pilot
   ```

5. **Compare per image.** Diff the new `details.jsonl` against the accepted run
   `target/benchmarks/model-parity/2026-11-18T02-27-34-439Z/details.jsonl` (or
   the pre-guard rerun): status, `got`, exact, canonical and comparable must be
   identical for all 300 rows. Expected difference count: **0**. A different
   `got` on any answered row is a failure, not a tolerance.
6. **Record the aggregate.** Compare with the accepted sidecar result
   (`canonical 211/290`, `exact 122/300`, `valid 299/1`) and the toolchain
   reference (`canonical 210/292`, `exact 121/300`, `valid 299/1`). Any movement
   means a valid row was truncated: raise the threshold and rerun.
7. **Record the pathological row before/after.** Status must stay `422`; record
   the HTTP `latencyMs`, the inference log line (token count and time), the
   guard stop step/cycles and the resulting time. Target: **≤ 5 s**, against
   **37.3 s** before.
8. **Verify no collateral change.** `cargo test -p indigo-server`,
   `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo fmt --all --check` and `node scripts/harness.mjs` stay green; the
   manifest, `max_len`, thresholds and model artifacts are untouched (`git diff`
   shows only the guard, its tests and docs).

## 7. Acceptance

- [x] The pathological row returns `422` in a time **substantially below
      37.3 s** (target **≤ 5 s**), and the record states the measured value,
      token count and guard parameters. Measured **2,186.158 ms** / 33 ids
      (32 steps) with `K = 2`, `R = 16`, `R₁ = 32`.
- [x] The row's parity classification is unchanged: invalid, exact failure, not
      comparable.
- [x] No valid row is truncated: the 299 answered rows keep identical status and
      identical `got` strings against the pre-guard run (0 per-image
      differences), and the aggregate stays `canonical 211/290`,
      `exact 122/300`, `valid 299/1`.
- [x] `max_len`, the model, the start/end ids, the vocabulary and the thresholds
      are unchanged; a non-pathological decode follows the existing path.
- [x] The guard is pure and covered by the fake-decoder cases in §5 (RED before
      implementation, GREEN after) and the mutation rule holds.
- [x] `node scripts/harness.mjs` is green; docs record the measured before/after
      and the residual risk; the working tree stays uncommitted for user
      approval.

## 8. Residual risk and rollback

**Risk.** A legitimate structure whose decode genuinely ends in a periodic tail
longer than `R` cycles (or with a cycle longer than `K`) is cut early and
becomes `422`, although the model might have emitted `end_id` a few steps later.
The pilot300 is the only measured population: the margin is evidence-based, but
it cannot prove that no such drawing exists in the wild. This risk is accepted
because the alternative — unbounded 37 s errors on pathological inputs — is
measured and recurring, while the guarded population is measured to be safe.

**Measured exposure.** The pilot's longest legitimate two-token cycle is 6
repeats (`O`, `)`, a polyol run), so a molecule whose SMILES tail is 16
consecutive `O)`-like token pairs would be cut. The one-token tier accepts up to
31 consecutive `C`; a drawn alkane longer than C31 would be cut, while the
pilot's longest chain is C8. Three- and four-token cycles are not guarded (the
pilot's legitimate maxima are 4 and 3 repeats), so a future pathological
3-cycle would still run to `max_len` and need a measured `K` increase.

**Mitigations.** The threshold has margin above the longest legitimate pilot
run; only the **tail** is inspected, so any motif followed by a different token
is safe; `end_id` always wins; the guard cannot fire before its minimum length;
and the inference log's token count makes the earlier stop observable.

**Rollback.** `K`, `R` and `R₁` are the entire switch. Setting both `R` and
`R₁` above `max_len`, or `K = 0`, restores the pre-fix behaviour exactly,
without touching the loop, the model or the schema. Adjusting only one threshold
leaves the other tier active (zeroing only `R` still stops a 32-token
one-token run). If a real drawing is ever truncated, the response is to raise
the relevant threshold with a recorded example — never to lower `max_len` or the
confidence gate.

## 9. Results (task `c`)

| Item                                           | Before                                | After                                                                                                      |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `hdm::CDK_Depict_5_82` status                  | `422`                                 | `422`                                                                                                      |
| `hdm::CDK_Depict_5_82` HTTP latency            | 37,270.662 ms (37.3 s)                | **2,186.158 ms (2.19 s)**                                                                                  |
| `hdm::CDK_Depict_5_82` inference time / tokens | 37,239.7 ms / 303 ids (302 steps)     | **2,149.5 ms / 33 ids** (32 steps, 16 `C=`)                                                                |
| Guard cycle limit `K`                          | disabled (no guard)                   | **2**                                                                                                      |
| Guard repeats `R` (cycle ≥ 2)                  | disabled (no guard)                   | **16**                                                                                                     |
| Guard repeats `R₁` (one-token runs)            | disabled (no guard)                   | **32**                                                                                                     |
| Longest legitimate periodic run in pilot300    | —                                     | **8** one-token (`C`, `hdm::CDK_Depict_36_181`); **6** two-token cycles (`O`, `)`, `hdm::CDK_Depict_1_23`) |
| Margin over the legitimate maximum             | —                                     | **4×** (one-token); **2.67×** (two-token)                                                                  |
| Canonical (sidecar, comparable)                | 211/290                               | **211/290**                                                                                                |
| Exact (of 300)                                 | 122/300                               | **122/300**                                                                                                |
| Valid / incomplete                             | 299 / 1                               | **299 / 1**                                                                                                |
| Per-image differences vs accepted run          | —                                     | **0** (300 rows: status, `got`, exact, canonical, incomparable)                                            |
| Raw run directory                              | `2026-11-18T02-27-34-439Z` (accepted) | **`2026-11-18T22-58-26-248Z`**                                                                             |

### 9.1 Token-trace statistics

The pre-guard release run `2026-11-18T22-43-16-297Z` captured one id line per
decode (301 lines: warm-up plus 300 rows; the warm-up repeats row 1). For every
generated prefix that ends in a non-`end_id` token, the longest trailing run was
computed per cycle length `k`; the table records the maximum over the 299
answered rows and the row that produced it. The pathological row is listed
separately.

| `k` | Longest valid run  | Row / pattern                                        | Pathological run          | Guarded?       | Margin (`R`/max) |
| --- | ------------------ | ---------------------------------------------------- | ------------------------- | -------------- | ---------------- |
| 1   | 8 tokens (8 reps)  | `CDK_Depict_36_181`, `C`                             | 1 token                   | yes, `R₁ = 32` | 4×               |
| 2   | 12 tokens (6 reps) | `CDK_Depict_1_23`, `O)`                              | **302 tokens (151 reps)** | yes, `R = 16`  | 2.67×            |
| 3   | 12 tokens (4 reps) | `CDK_Depict_7_94`, `OC)` / `CDK_Depict_9_78`, `(Cl)` | 3 tokens (1 rep)          | no             | —                |
| 4   | 12 tokens (3 reps) | `CDK_Depict_1_23`, `O)O)`                            | 300 tokens (75 reps)      | no             | —                |

The pathological row's full trace is `13` (start) followed by `2, 3` repeated
151 times (`C`, `=`; 303 ids including `start_id`). With `K = 2`, `R = 16` the
guard fires after the 32nd generated token (`=`, id 3), before another decoder
step; the returned ids end there, so the decode stays incomplete.

### 9.2 Before/after measurement

- **Pathological row.** Status `422` before and after; HTTP latency
  **37,270.662 → 2,186.158 ms** (17.0× faster). The sidecar log records
  `OCSR inference 2149.5 ms: 33 tokens, confidence 0.7499, incomplete` (before:
  `37239.7 ms: 303 tokens`, confidence 0.7944). The row keeps `valid: false`,
  `exact: false`, `canonical: null`, `incomparable: true`. A pre-guard rerun
  with an instrumented build (`2026-11-18T22-43-16-297Z`: same model artifacts,
  different binary hash) measured 42,839.816 ms HTTP / 42,804.9 ms inference, so
  the machine has ~15% run-to-run spread.
- **No collateral change.** Comparing the guarded `details.jsonl` with the
  accepted run: **0** per-image differences over 300 rows for status, `got`,
  exact, canonical and incomparable; the same 9 raw disagreements
  (`CDK_Depict_47_38`, `20_4`, `47_152`, `35_54`, `19_52`, `19_23`, `2_54`,
  `9_74`, `5_82`); aggregate `canonical 211/290`, `exact 122/300`,
  `valid 299/1`, comparable 290. The 299 answered rows keep the same status and
  `got` strings, so their latencies differ only by machine noise: p50
  **1839.6 ms** (pre-guard rerun 1842.6, accepted 1681.7), p95 **3948.5 ms**
  (pre-guard rerun 3509.4, accepted 3557.0); 59 rows moved by >500 ms, one by
  2.7 s, consistent with the 15% spread above.
- **Guard rule.** After each non-`end_id` token, stop when the generated tail is
  one id repeated 32 times or a two-token cycle repeated 16 times. `end_id`
  always wins; the guard never fires on the end step. `max_len = 302`, the
  model, ids, vocabulary, thresholds and preprocessing are untouched.

**Limitation.** The `K`, `R` and `R₁` values are derived from one measured
population (the frozen pilot300 hand-drawn split) and one pathological row. The
margin protects the measured classes (octyl chains and short `O)`/polyol
motifs); it cannot prove that no drawing outside the pilot ends in a longer
periodic tail. The accepted exposure is a molecule whose SMILES tail repeats a
two-token motif 16+ times or one `C` 32+ times: it would now return `422`
instead of a (possibly complete) decode. Roll back by raising `R`/`R₁` with a
recorded example, never by lowering `max_len` or the confidence gate.
