# Conventions

> Style, naming, docstrings and decision records. Follow exactly.

---

## 1. Language and style

- **Rust 2021 + TypeScript strict** with the project's strictest practical
  settings.
- **Prettier** owns TypeScript/TSX/CSS/JSON/YAML/Markdown formatting;
  **rustfmt** owns Rust. **ESLint**, **Clippy** and **ShellCheck** own quality.
- No `any`/`unknown` leaks across a public API unless documented.
- No dead code, unused imports or unused variables.
- No debug output (`console.log`, `println!`, `dbg!`) except the sidecar startup
  lines the Tauri host parses.
- No TODOs without context (owner + why + next step).
- **100 columns** (`.prettierrc.json`); rustfmt defaults.

Format: `pnpm run format`, `cargo fmt --all`. Check: `pnpm run format:check`,
`cargo fmt --all --check`. Lint: `pnpm run lint`,
`cargo clippy --workspace --all-targets -- -D warnings`,
`shellcheck --severity=warning scripts/*.sh`; zero warnings. Never disable a
rule ad hoc; change the config, document it here.

---

## 2. Naming

| Element         | Convention                 | Example                            |
| --------------- | -------------------------- | ---------------------------------- |
| Rust module     | `snake_case`               | `indigo_ops.rs`, `health.rs`       |
| Rust type       | `PascalCase`               | `AppState`, `IndigoRequest`        |
| Rust function   | `snake_case`               | `post_render`, `get_health`        |
| TypeScript file | `kebab-case` / module name | `model-setup.ts`, `saveRoute.ts`   |
| TS component    | `PascalCase`               | `ModelSetupDialog`                 |
| TS function     | `camelCase`                | `resolveApiBase`, `initLogging`    |
| Constant        | `UPPER_SNAKE_CASE`         | `PORT_SCAN_RANGE`, `SIMPLE_ERRORS` |
| Shell script    | `kebab-case.sh`            | `build-appimage.sh`                |
| Test file       | colocated spec             | `saveRoute.test.ts`                |

Names state the contract. A reader should understand the purpose without opening
the file.

---

## 3. Docstrings — the documentation source

The project's documentation is generated from code. That makes docstrings part
of the build, not a courtesy.

- Every exported symbol has a docstring: purpose, parameters, return value,
  thrown/returned errors and one usage note when it is not obvious.
- Rust modules start with `//!`; public items use `///`. TypeScript exported
  symbols use JSDoc.
- Document the **why** and the contract; do not restate the signature.
- Keep them current in the same change that changes the behavior.
- The linter/docblock policy enforces presence: Rust `cargo doc`/`missing_docs`
  and the TypeScript docblock rules. If a rule is off, turn it on before
  claiming the policy.
- Legacy files that fail a new rule get a visible baseline in
  `docs/harness/docblock-baseline.txt` and a backlog story; never a silent skip.
  `node scripts/check-docblocks.mjs` fails only on new or changed undocumented
  symbols. The baseline and its burn-down are documented in
  `docs/harness/docstring-debt.md`.
- Generated output is never edited by hand.

Example (language-agnostic shape):

```text
/** Issues an access token for valid credentials.
 *  @param credentials - email and plain password.
 *  @returns token and expiry.
 *  @throws InvalidCredentials when the pair does not match.
 */
```

---

## 4. Decision records (ADRs)

- Any decision that changes the foundation, a contract or a flow gets an ADR in
  `docs/planning/adr/`.
- One decision per file, sequential numbering, indexed in `README.md`.
- Write it in the activity's `DOCUMENT` step, before the implementation.
- Update the affected planning document or PlantUML diagram in the same change.
- A superseded ADR stays; it gets `status: superseded by NNNN`.

A decision without an ADR is a future argument.

---

## 5. Layout

- Frontend: `src/`. Tauri host: `src-tauri/src/`. Sidecar:
  `src-tauri/sidecar/src/` (`transport/`, `service/`, `service/ml/`, `ffi/`,
  `tests/`).
- Planning docs in `docs/planning/`; harness docs in `docs/harness/`; harness in
  `scripts/`.
- Tests: sidecar tests in `src-tauri/sidecar/src/tests/`; pure frontend tests
  colocated as `src/*.test.ts`; packaging contracts in `scripts/lib/*.test.mjs`.
  Never two homes for the same test.
- Native libs in `src-tauri/lib/<platform>/` (generated, ignored); models in
  `models/` (downloaded, ignored); ONNX Runtime in `.ort/` (fetched, ignored).
- Scripts are not part of the shipped artifact.
- A new top-level folder requires a `docs/planning/structure.md` update first.

---

## 6. Imports and dependencies

- Direction: frontend → HTTP → `transport/` → `service/` → `ffi/`.
- The Tauri host does no chemistry; it owns lifecycle only.
- No cycles, no cross-layer shortcuts (`transport/` never calls `ffi/`).
- Prefer the standard library and existing dependencies.
- A new foundational dependency needs an ADR and a lockfile update (`pnpm` or
  `Cargo.lock`, never both package managers).

---

## 7. Errors and comments

- Fail fast at boundaries; return typed errors for expected failures
  (`AppError` for HTTP, `anyhow` with context inside services).
- Do not swallow errors; log with context at the boundary.
- Comments explain **why**, not what. Delete comments that restate the code.
- Public API errors are part of the contract; document them.
- `unsafe` stays confined to `src-tauri/sidecar/src/ffi/`.

---

## 8. Product rules that code must not break

- **Documents are `.ket`.** Save/Save As write `.ket` only; Export is the sole
  route to Molfile, SMILES, InChI, SVG and PNG and never changes the document
  path or format.
- **Recognition path.** Ketcher's compatibility route is a shim over the local
  filter → OCSR → Indigo pipeline; no Imago backend ships.
- **Delivery.** Native Indigo comes from `task libs`; ONNX Runtime from the
  pinned NuGet package; models are downloaded, never bundled.
- **Branches.** `main` is 0.x support, `develop` is 1.x; no worktrees, no
  cross-merges.

---

## 9. Documentation map

- `docs/planning/*` — product foundation (hand written).
- `docs/harness/architecture.md` — how the harness works.
- `docs/harness/development.md` — stages and story workflow.
- `docs/harness/testing.md` — test policy.
- `docs/harness/verification.md` — gates, steps, commands.
- `docs/harness/structure.md` — where harness files live.
- `docs/harness/git-tracking.md` — tracked vs ignored.
- `docs/harness/CHECKPOINTS.md` — final state evaluation.

Docs are part of the contract. If a change makes a doc wrong, the change is not
done.
