# Testing Policy

> How to write tests that actually catch bugs.
> A test's value = its ability to **fail when the code is wrong**.

---

## 0. Delivery order: docs → test → implement → review

Every change follows this order; a test is never written before the docs that
define the contract, and implementation never starts before a failing test
exists.

1. **Docs** — real work, not an afterthought: update `README.md`,
   `docs/architecture.md`, `docs/conventions.md`, `docs/verification.md` or
   `docs/CHECKPOINTS.md` as the change requires, and describe the expected
   behaviour and how it will be verified.
2. **Test** — add the failing test and confirm RED (section 2).
3. **Implement** — write the minimal code to make it pass, confirm GREEN, then
   refactor.
4. **Review** — the reviewer checks the docs, the RED→GREEN evidence, the phase
   order and the harness (`docs/verification.md`).

Enforcement:

- Every task in `activities.json` declares `phase`:
  `docs | test | implement | review`.
- `scripts/lib/activity-policy.mjs` validates the phase order
  (non-decreasing) and the agent mapping. `node scripts/harness.mjs` runs it
  and `scripts/lib/activity-policy.test.mjs` before allowing work to proceed.
- **Docs-only exception**: an activity with `type: "docs"` runs `docs` →
  `review` and must not contain `test` or `implement` tasks.

The reviewer rejects work with no docs task, no failing test before the
implementation, or phases out of order.

---

## 1. Core principle: the mutation mindset

Before writing a test, ask: _"If this function were broken — deleted, returned
the wrong value, or crashed on input X — would this test fail?"_

If the test would still pass, it has no value. Rewrite it or delete it.

---

## 2. Test-first (Red-Green-Refactor)

Backend behaviour is written **test-first**, after the docs task. The test is
the contract; the code is what makes it pass.

1. **Write the test** in `src-tauri/sidecar/src/tests/` — it must fail on the
   current code (or fail to compile because the symbol does not exist yet).
2. **Run it → confirm RED**
   `cargo test -p indigo-server <name>`.
3. **Implement** the minimal code to make it pass.
4. **Run → confirm GREEN**.
5. **Refactor** (tests stay green).

Enforcement:

- A task may be `in_progress` or `done` only when every earlier task in the
  activity is `done` (docs → test → implement → review).
- The reviewer asks: _"would this test have failed before the implementation?"_
  If not, the test was not written first (or is too weak) — reject.

---

## 3. Structure

- **AAA**: Arrange (build the request/state) → Act (call once) → Assert (verify
  the observable outcome).
- **One scenario per test.**
- **Naming**: `test_<unit>_<behavior>_<condition>` — the name states the
  contract (e.g. `corrupted_molfile_returns_400`).

---

## 4. Sidecar test patterns

Tests live in `src-tauri/sidecar/src/tests/`, one module per domain, registered
in `tests/mod.rs`.

```rust
use crate::tests::*;
use axum::http::StatusCode;

#[tokio::test]
async fn health_reports_status_and_port() {
    let app = test_app();
    let (status, body) = fetch_get(&app, "/v2/health").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["port"], 9321);
}
```

Rules:

- Use `test_app()` (full router) for endpoint tests; no sockets, no ports.
- Assert both the **status code** and the meaningful body fields.
- Include the negative path: malformed JSON (422/400), invalid molecule (400),
  unknown upload id (404).
- No real network. Native Indigo/Imago are linked, so chemistry tests are real —
  that is the point.
- Imago integration tests may need fixtures; keep them deterministic and skip
  cleanly when no fixture is available.
- Platform-specific behaviour is tested with `#[cfg(windows)]` modules
  (`tests/windows_no_imago.rs` asserts the empty `imago_versions` list and the
  absent Imago routes). They compile locally via cross-target `cargo check` but
  only run in Windows CI.
- Never test private state (`obj.field`); test behaviour.

---

## 5. Frontend

Frontend correctness is verified by `pnpm exec tsc --noEmit`, `pnpm build`, the
Vitest suite for pure helpers below, and the manual checklist in
`docs/verification.md`.

### 5.1 Vitest scope: pure helpers

Vitest is the frontend test runner. The test task adds it (with the `test`
script and a harness block) before the first helper test is written. Tests live
next to the module as `src/<module>.test.ts` and cover **only** pure functions
and constants from `src/document.ts`, `src/autosave.ts`, `src/saveRoute.ts`,
`src/ui/toolbarIcons.ts` and `src/ui/tokens.ts` — no DOM, no Tauri imports, no
React rendering.

| Helper / module        | Behaviour under test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentTitle`        | `Untitled` with no path; base name without `.ket`; `*` only while dirty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| names                  | `documentName` and `exportFileName`: base name, untitled fallback, Windows paths, export extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| dirty transitions      | an editor change sets dirty; Save and `.ket` Open/New clear it; importing another format marks the document dirty with `path: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| save target            | Save with no path defaults to `untitled.ket`; with a path it reuses it; Save As appends `.ket`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| save vs export mapping | `.ket`/`getKet` for Save; V2000, V3000, SMILES, InChI, SVG, PNG sources and file extensions for Export; Export leaves `path` and `format` untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| saved-blob routing     | `.ket` (any case) routes to document save: existing path, Save As when `path` is `null`; `.mol`/`.smi`/`.inchi`/`.svg`/`.png` route to export save with `path` and `format` unchanged; no Tauri or no registered handler falls back to a download; an unknown or missing extension takes the export route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| saver default filename | an untitled `.ket` document save suggests `untitled.ket`; the export route keeps the filename Ketcher supplied (the app's own Export naming is `exportFileName`, covered by the `names` row)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| autosave scheduling    | debounce coalesces rapid edits; the slow interval writes only while dirty; a clean document never writes; timers reset after a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| recovery decision      | no metadata, `dirty: false`, snapshot older than the last clean save, snapshot newer, unknown or missing original path, unreadable metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| write generation       | a write started before `clearSnapshot()` cannot recreate the snapshot; a stale write removes the shared snapshot files it just committed (metadata, structure, partial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| close-guard decision   | clean allows close; Save closes after saving; Discard closes without saving; Cancel stays open; a cancelled Save As aborts the close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| toolbar icon module    | the exported `imageLink` is a valid, fully transparent SVG data URI (draws nothing); the three button ids and titles stay stable (`chemistry-draw:save`/`Save`, `chemistry-draw:new`/`New`, `chemistry-draw:export`/`Export`); the generated style has exactly one mask rule per `alt` (Save/New/Export) with a `mask-image` data URI; the style contains no literal colour — no hex, no `%23` escape and no named colour such as `black`/`white`/`grey` — only `currentColor`; every glyph is an outline (`fill='none'`, `stroke-width='1.5'`, round caps/joins) whose path centrelines stay inside 5.25-18.75                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| dialog tokens          | the overlay token is exactly `rgba(94,94,94,0.2)` and the pre-fade token is `rgba(94,94,94,0.01)`; the hatch overlay token's data URI decodes to a 10×10 SVG whose path is `M0 10 10 0zm12-2-4 4zM-2 2l4-4z` with `stroke` `#555`, `stroke-width` 2 and `stroke-opacity` 0.02; its repeat and size tokens are `repeat` and `10px 10px`; the old `rgba(94,94,94,0.8)` overlay is gone; the dialog panel tokens resolve to radius `8px`, border `none` and shadow `none`; `tokens.dialog.transition` is `background-color 0.3s` (the transition lives on that token, not on the overlay colour); the generic 3 px `radius` and soft shadow remain for non-dialog surfaces and are asserted non-empty; every in-app dialog gets its overlay and panel styling from these tokens, with no per-dialog colour, radius, border or shadow; `tokens.dialog.backdropPattern` stays a bare `data:image/svg+xml` URI that does not itself start with `url(`, while the `background-image` the overlay applies wraps that token as `url("…")` — the token raw, the CSS function owned by the component |

Rules:

- Assert exact values, not "does not throw"; the tables in `docs/architecture.md`
  §5.3–5.5 are the expected outputs.
- Use `vi.useFakeTimers()` and fixed timestamps. No real timers, no wall clock.
- Mutation check before committing: removing the debounce, writing while clean,
  or returning the Save format for Export must each make a test fail. For the
  saver, routing a `.mol` blob to document save (or a `.ket` blob to export)
  must fail a test. For the dialog tokens, restoring the `rgba(94,94,94,0.8)`
  overlay, dropping the diagonal hatch from the overlay, changing its stroke
  colour/width/opacity or its `repeat`/`10px 10px` size, the `3px` panel radius,
  the `1px` panel border or any panel shadow must each make the token test fail.
  For the hatch, dropping the `url("…")` wrapper from the applied
  `background-image` or pre-wrapping the token itself must each fail a test.
- The dialog-token test asserts the exported `tokens` constants directly; the
  rendered overlay tint, hatch visibility, fade smoothness and panel shape are
  covered by the manual checklist (`docs/verification.md` §2, "In-app dialog
  styling").
- Do not mock Tauri in these tests. The I/O adapters (`appDataDir`,
  `writeTextFile`, `onCloseRequested`) stay thin and are covered manually.
- Clearing `dirty` and the recovery snapshot is **not** part of the pure
  `routeSavedBlob`: `saveRoutedBlob` in `src/App.tsx` writes the blob first and
  then applies the state change. That adapter is not unit-tested.

### 5.2 Manual checklist

The real flows cannot be unit-tested without a WebView and a filesystem, so
`docs/verification.md` §2 is mandatory: "Documents, autosave and recovery"
(Save, Save As, each Export format, crash simulation, the recovery
Restore/Discard prompt, all close-guard paths) and "Toolbar integration" (the
three custom buttons, the hidden native Save As entry, the shortcuts and the
browser fallback).

---

## 6. Assertion quality

### Strong assertions

- Deterministic results → assert the **exact** value/structure.
- Endpoints → status **and** body.
- Errors → assert the message contains the actionable cause.
- Files/render output → assert the format and non-empty payload, not just "no
  crash".

### Forbidden anti-patterns

| Pattern                                       | Why it is weak                      |
| --------------------------------------------- | ----------------------------------- |
| `assert!(true)` / no assertion                | Verifies nothing                    |
| Asserting only "did not crash"                | Says nothing about the outcome      |
| `assert!(result.is_ok())` alone               | Ignores the value under test        |
| Asserting `is_some()`/`is_not_none()` alone   | Almost always true                  |
| Reading private state                         | Tests implementation, not behaviour |
| Tests that depend on order or wall-clock time | Flaky by construction               |

---

## 7. Commands

```bash
# Full harness (typecheck, lint, format, build, clippy, tests)
node scripts/harness.mjs

# Frontend gates
pnpm run check          # typecheck + ESLint + Prettier
pnpm run lint           # ESLint only
pnpm run format:check   # Prettier only
pnpm run format         # apply Prettier

# Rust gates
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings

# Sidecar tests (harness sets LD_LIBRARY_PATH; manually:)
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 cargo test -p indigo-server

# One test
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  cargo test -p indigo-server info_endpoint_returns_version
```
