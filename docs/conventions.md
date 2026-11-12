# Conventions

> Style rules, naming, and structure. Follow exactly.

---

## 0. Tooling

One formatter and one linter per language, all enforced by
`node scripts/harness.mjs`:

| Language               | Formatter                    | Linter                                                     |
| ---------------------- | ---------------------------- | ---------------------------------------------------------- |
| Rust                   | `cargo fmt --all` (rustfmt)  | `cargo clippy -- -D warnings`                              |
| TypeScript / TSX / CSS | `pnpm run format` (Prettier) | `pnpm run lint` (ESLint + typescript-eslint + react-hooks) |
| JSON / YAML / Markdown | `pnpm run format` (Prettier) | —                                                          |
| Shell                  | — (no shfmt requirement)     | `shellcheck --severity=warning`                            |

- `pnpm run check` = typecheck + ESLint + Prettier for the frontend.
- Never hand-format code to satisfy a linter; run the tool.
- Prettier config: `.prettierrc.json` (100 columns, double quotes, semicolons,
  trailing commas). Ignored paths: `.prettierignore`.
- ESLint flat config: `eslint.config.js`.
- Rust formatting is rustfmt defaults; do not add a `rustfmt.toml` without a
  reason.

---

## 1. Delivery order: docs → test → implement → review

Every activity task declares `phase` in `activities.json`:

| Phase       | Purpose                                       | Agent         |
| ----------- | --------------------------------------------- | ------------- |
| `docs`      | Update README/docs describing the contract    | `implementer` |
| `test`      | Add the failing test; confirm RED             | `implementer` |
| `implement` | Minimal code to pass; confirm GREEN; refactor | `implementer` |
| `review`    | Verify docs, test, code and green harness     | `reviewer`    |

Rules:

- Phases are non-decreasing in task order:
  `docs` (0) → `test` (1) → `implement` (2) → `review` (3). Several
  `implement` tasks may follow each other, but a phase may not move backwards.
- Non-`docs` activities must contain **all four** phases.
- Docs-only activities (`type: "docs"`) contain `docs` → `review` and no
  `test`/`implement` tasks.
- `review` tasks use the `reviewer` agent; every other phase uses
  `implementer`.
- `done` activities have only `done` tasks; `in_progress` activities have
  exactly one `in_progress` task.
- A task may be `in_progress` or `done` only when every earlier task in the
  activity is `done` (sequential status, not just phase order).
- `node scripts/harness.mjs` runs `scripts/lib/activity-policy.mjs` and its
  tests; any violation fails the harness.

---

## 2. Rust style

- Edition 2021, formatted with `rustfmt` defaults (`cargo fmt --all`).
- `cargo clippy --workspace --all-targets` should stay clean; do not add new
  warnings.
- **Module docs** (`//!`) at the top of every module, explaining its role.
- **Public items** (`pub fn`, `pub struct`, `pub enum`) get a `///` doc comment
  saying what they do, not how.
- Errors:
  - HTTP-facing code returns `Result<_, AppError>` (`sidecar/src/error.rs`).
  - Service/FFI internals use `anyhow::Result` and `.context(...)`.
- Logging: `tracing::info!/warn!/error!` in the sidecar, `log::info!/...` in the
  host. **No `println!`/`eprintln!`** except startup lines the host parses
  (`INDIGO_PORT=`) and the immediate panic hook.
- Do not `.unwrap()` on request data or filesystem input; return an error.
  Lock poisoning may use `unwrap_or_else(|e| e.into_inner())` as elsewhere.
- Keep `unsafe` confined to `src-tauri/sidecar/src/ffi/`.
- No TODOs without a reason and an owner.

---

## 3. TypeScript style

- TypeScript `strict` is on; `noUnusedLocals`/`noUnusedParameters` are errors.
- 2-space indentation, double quotes, semicolons (as in `src/App.tsx`).
- React function components only; no class components.
- Keep the Ketcher boundary thin: `App.tsx` owns the provider, `logging.ts` owns
  log forwarding.
- No Node-only APIs in `src/` (the webview is not Node). The `file-saver` shim
  is the sanctioned exception.
- Do not log sensitive data; `console.*` is now persisted.

---

## 4. Naming

| Element      | Convention         | Example                            |
| ------------ | ------------------ | ---------------------------------- |
| Rust module  | `snake_case`       | `indigo_ops.rs`, `health.rs`       |
| Rust type    | `PascalCase`       | `AppState`, `IndigoRequest`        |
| Rust fn      | `snake_case`       | `post_render`, `get_health`        |
| TS component | `PascalCase`       | `App`                              |
| TS function  | `camelCase`        | `resolveApiBase`, `initLogging`    |
| Constant     | `UPPER_SNAKE_CASE` | `PORT_SCAN_RANGE`, `SIMPLE_ERRORS` |
| Script       | `kebab-case.sh`    | `build-appimage.sh`                |

---

## 5. Project layout

```text
src/                     React + Ketcher integration, logging
src-tauri/src/           Tauri host: lifecycle, commands
src-tauri/sidecar/src/   indigo-server crate
  transport/             axum handlers
  service/               orchestration
    ml/                  ONNX runtime, model registry, preprocessing
  ffi/                   native bindings
  tests/                 sidecar integration tests
scripts/                 harness, packaging, libs
docs/                    architecture, conventions, testing, verification
progress/                session state (harness)
```

Rules:

- New endpoint → `transport/<domain>.rs` + route in `lib.rs`; logic in
  `service/`.
- New native call → `ffi/` only.
- New inference code → `service/ml/`; handlers only validate input and map
  errors.
- New packaging behaviour → a script under `scripts/`, never inline in CI YAML.
- Do not commit `src-tauri/lib/`, `target/`, `dist/`, `dist-packages/`.

---

## 6. Commits and releases

- **Conventional Commits** are mandatory. See
  **[commit-policy.md](commit-policy.md)** for the full rule.
- Use `feat`/`fix` (and breaking markers) **only for product changes** that
  affect Chemistry Draw users and belong in the changelog. CI, Actions, release
  config, agent harness, templates, and internal tooling use `chore(ci)`,
  `build`, `docs`, `refactor`, etc.
- release-please is configured to drive releases from `feat`/`fix` (and breaking
  changes), not from `chore`/`docs`/`refactor`/`perf`.
- One logical change per commit; the message explains _why_.
- Do not hand-edit `CHANGELOG.md` (release-please owns it).
- Update `docs/` in the same commit when behaviour changes.

---

## 7. Sidecar contracts

- Every handler logs its route at `info`.
- Status codes: 400 invalid input, 404 unknown id, 413 payload too large, 500
  backend failure, 503 model unavailable (missing, corrupt or contract
  mismatch).
- `/v2/info` must report the **actual bound port** in `api_path`.
- Keep the sidecar stateless: a process-lifetime inference-session cache is an
  accelerator, never request state.

---

## 8. Native libraries and packaging

- Never vendor `.so` files. `task libs` / the Docker builder generate them.
- Never ship `libstdc++` or `libgcc_s`.
- Test packaging changes with `task packages` before declaring done.
- The AppImage is assembled by `scripts/make-appimage.sh`; do not reintroduce
  Tauri's linuxdeploy AppImage path.

---

## 9. ML models and inference

- Models are **never** committed or bundled. `models/` is gitignored; the model
  root comes from `CHEMISTRY_MODELS_DIR` (debug default: `<repo>/models`).
- A model is usable only when `manifest.json` verifies: artifact path,
  `artifact_sha256`, provenance id, input/output names, shapes and dtype.
  Validation failure is `AppError::ServiceUnavailable` (503), never a fallback
  and never a panic.
- Sessions load lazily and are cached for the process lifetime. The sidecar must
  start and serve Indigo with no models present.
- CPU execution provider only, one intra-op thread. No GPU paths.
- No `unsafe` in `service/ml/`; the `ort` crate owns the FFI boundary.
- Preprocessing changes require a measured evaluation delta, not a visual
  preference. Never auto-invert, histogram-equalize, sharpen or autocontrast in
  the default path.
- Do not change the classifier threshold (`0.000089`) or the score direction
  without recording the calibration evidence in the manifest and docs.
- Keep preprocessing byte-compatible with DECIMER `runtime_default`; parity is
  the contract, not an implementation detail.
- `libonnxruntime` is loaded **dynamically** (`ort` feature `load-dynamic`); the
  sidecar must never link it. `default-features = false` plus `std`, `api-31` and
  `load-dynamic`; no `download-binaries`, `copy-dylibs`, GPU providers or
  `ndarray`. The dev runtime is fetched by `scripts/fetch-onnxruntime.sh` into
  gitignored `.ort/<platform>/` and selected with `ORT_DYLIB_PATH`.
- `libonnxruntime` packaging is its own activity. B1 may use the developer's
  runtime but must not bundle it or any model file; release packaging stays
  runtime-free until that activity lands.
- Bound image decoding (`image::Limits`) before trusting dimensions: 12,000 px
  per side and 128 MiB of decoder allocations. Over-limit input is `400`.
