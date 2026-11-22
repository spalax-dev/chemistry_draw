# Testing Policy

> TDD applies to the story being built, not to the whole repository.
> A test's value is its ability to **fail when the code is wrong**.

Stack: **Rust `cargo test`** for the sidecar, **Vitest** for pure frontend
helpers, **Node's test runner** for harness and packaging contracts.

---

## 1. Story-scoped TDD

```text
story selected
  -> activities derived
    -> tests activity (write RED)
      -> implementation activity (turn GREEN)
```

Why not global test-first:

- Requirements are often vague when the backlog is written. A test written
  against a guessed contract locks in the wrong idea.
- The backlog is coarse on purpose; the test is written when the story starts
  and the questions are answered.
- Inside the story, the rule is strict: the tests activity comes before its
  implementation activity.

A test task is `in_progress` only once its test exists. A test that passes before
the implementation asserts nothing. For a bug fix, the failing regression test
is the first artifact.

---

## 2. The mutation mindset

Before writing a test, ask: _"If this unit were deleted, returned the wrong
value, or crashed on input X, would this test fail?"_

If not, the test has no value. Rewrite or delete it.

---

## 3. Structure

- **AAA**: Arrange → Act → Assert.
- One scenario per test.
- Naming: `should <behavior> when <condition>`; Rust tests use
  `test_<unit>_<behavior>_<condition>`.
- Assert the observable contract, not a private side effect.
- Fixtures are realistic; never encode the implementation in the fixture.

Test locations:

| Area                        | Location                                                     | Runner                        |
| --------------------------- | ------------------------------------------------------------ | ----------------------------- |
| Sidecar behavior            | `src-tauri/sidecar/src/tests/`, registered in `tests/mod.rs` | `cargo test -p indigo-server` |
| Pure frontend helpers       | `src/*.test.ts` (colocated)                                  | `pnpm test` (Vitest)          |
| Packaging/harness contracts | `scripts/lib/*.test.mjs`                                     | `node --test`                 |
| Harness scheduling logic    | `scripts/harness-lib.spec.mjs`                               | `node --test`                 |

Vitest covers pure helpers and constants; it does not render React, mount
Tauri, or touch the network. The `.ket`/export routing, model-setup parsing,
recognition error copy and capability constants are the kind of units it owns.
There is no committed Playwright suite; browser flows are recreated for an
activity and reported as evidence, not checked in.

---

## 4. Assertion quality

Strong:

- exact values for deterministic output;
- negative paths: missing, malformed, not found, unauthorized;
- boundaries: empty, null, unicode, limits;
- rendered output: a specific element/attribute/text;
- Rust endpoints: status code **and** meaningful body fields.

Weak:

| Pattern                              | Why                                |
| ------------------------------------ | ---------------------------------- |
| `toBeTruthy()` as the only assertion | Passes for almost any value        |
| "did not throw"                      | Says nothing about the outcome     |
| `toHaveBeenCalled()` only            | Asserts a call, not the contract   |
| Reading private internals            | Tests implementation, not behavior |
| Snapshot as the only assertion       | Accepts any change wholesale       |

---

## 5. Mocking

- Mock only at boundaries: network, filesystem, clock, random, third parties.
- Never mock the unit's own logic.
- Prefer fakes over mocks when the contract is simple.
- Tests never depend on the developer's machine, network or time of day.
- Do not mock Tauri in Vitest; keep the I/O adapters thin and cover the rendered
  behavior in the manual checklist.

---

## 6. Domain-specific rules

### Sidecar

- Use `test_app()` with the full router for endpoint tests; no sockets, no
  ports.
- Native Indigo is linked, so chemistry tests are real. Assert the returned
  molfile/SMILES, not a mock.
- Cover the negative path for every new route: malformed body, unsupported
  image, missing model, unknown id.
- The Ketcher compatibility route (`/v2/imago/uploads`) is a shim over the local
  filter → OCSR → Indigo path; it is not an Imago backend.

### Model-gated inference

- Tests that need weights or the ONNX Runtime are `#[ignore]` or
  `--include-ignored` gated; they run only when `models/manifest.json` and a
  loadable `ORT_DYLIB_PATH` exist.
- The harness sets `CHEMISTRY_MODELS_DIR` and `ORT_DYLIB_PATH`; when they are
  absent it reports `[SKIP]` and names the missing piece.
- Thresholds and preprocessing invariants are contract values: pin them.

### Packaging and native libraries

- `scripts/lib/*.test.mjs` pin the packaging rules: no repack regressions,
  the pinned ONNX Runtime version/hashes, `cp -a` copies, the repack call, no
  `imago`/`opencv` payload, no `libstdc++`/`libgcc_s` shipped.
- Removing any one check must make the contract test fail.

### Contracts

When an activity changes `docs/planning/contracts.md` or the sidecar's public
shape:

- add or update a contract test that validates the published shape;
- the test fails if a required field disappears or an error shape changes;
- generated docs are not evidence; the contract test is.

### Backstage, tabs and file workflow (1.x)

The US-01 port adds these colocated Vitest suites. Each owns one unit of the
workflow adopted from `main` 0.1.8 (ADR 0009) and fails until its module exists,
which is the story-scoped TDD order.

| Suite                      | Unit under test                                                       |
| -------------------------- | --------------------------------------------------------------------- |
| `backstage.test.ts`        | rail sections, default Welcome, unknown-id guard, declared version    |
| `fileMenu.test.ts`         | command order, Open versus Import, recent section, popup wiring       |
| `recent.test.ts`           | recent-documents list and the `localStorage` adapter                  |
| `recentDetails.test.ts`    | size/date labels, Indigo check badge, preview content hash            |
| `recentStructures.test.ts` | Recent structures rows and their degraded placeholders                |
| `tabs.test.ts`             | tab creation/activation/close, titles, import, close-guard matrix     |
| `pathUniqueness.test.ts`   | `pathKey`, owner lookup, Open activation and Save As refusal          |
| `tabStore.test.ts`         | per-tab snapshot files, index, restore dedupe and discard cleanup     |
| `templateLibrary.test.ts`  | real Structure Library mapping, SGroup-free preview, four-card sample |

Rules:

- The suites stay pure or source contracts: Vitest still does not render React.
  Structural rules (the rail is built from the model, an unknown id renders
  Welcome, the overlay owns no editor, the popup renders the model) are asserted
  against the component source, as §3 allows.
- `tabStore.test.ts` replaces the Tauri fs/path adapters with an in-memory
  filesystem so the write/clear queue and the discard index are exercised
  without a WebView. That is a boundary fake under §5, not a mocked unit.
- 1.x adaptations from `main`: the Models rail entry is not asserted to be an
  empty placeholder (ACT-05 settles the real dialog route), the legacy curated
  `src/templates.ts` pool is not a product input and is not re-tested, and the
  tab suite does not assume `main`'s `document.ts` name parameter. Imago, OpenCV
  and the OCSR path stay outside these suites and keep their own tests.
- The tab strip's token and layout contract stays with the UI activity; these
  suites cover tab semantics, not pixels.

---

## 7. Commands

```bash
# Frontend helpers
pnpm test

# Sidecar (the harness sets LD_LIBRARY_PATH for you)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 cargo test -p indigo-server

# One sidecar test
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server <test_name>

# Model-gated tests
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  ORT_DYLIB_PATH=$PWD/.ort/linux-x86_64/libonnxruntime.so \
  CHEMISTRY_MODELS_DIR=$PWD/models \
  cargo test -p indigo-server -- --include-ignored

# Packaging/harness contracts
node --test scripts/lib/*.test.mjs

# Harness logic
node --test scripts/harness-lib.spec.mjs
```

Run targeted tests during the activity and the full suite at story close.

---

## 8. Flakiness and coverage

- Coverage is a signal, not a target.
- No arbitrary sleeps; use fake timers or await the condition.
- No order-dependent tests.
- A flaky test is a bug: fix it or delete it. Never retry it.
