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
  is the sanctioned exception (§6.5).
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

## 6. In-app dialogs and document UI

Every dialog this app adds — recovery prompt, close guard, save/export errors —
is an **in-app HTML component**, never a Tauri native
`message` / `confirm` / `ask`. The native error dialogs already in `App.tsx` may
stay; new work must not add more. The same ban applies to browser
`alert()` / `confirm()`.

### 6.1 Primitives

| Module              | Export   | Responsibility                          |
| ------------------- | -------- | --------------------------------------- |
| `src/ui/Dialog.tsx` | `Dialog` | overlay, panel, title, action row       |
| `src/ui/Button.tsx` | `Button` | `primary`, `secondary`, `danger` styles |
| `src/ui/tokens.ts`  | `tokens` | the palette below, as typed constants   |

- The caller owns open/close state; one dialog per decision.
- Buttons are real `<button type="button">` elements with visible labels.
- Dialogs render above the editor without unmounting Ketcher.
- Use `danger` only for destructive choices (Discard), never for the default.

### 6.2 Ketcher design tokens

| Token          | Value                                                                                                                                                                       | Use                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Accent         | `#167782`                                                                                                                                                                   | primary buttons, focus ring     |
| Accent hover   | `#00838f`                                                                                                                                                                   | primary button hover            |
| Accent active  | `#005662`                                                                                                                                                                   | primary button pressed, links   |
| Error          | `#ff4a4a`                                                                                                                                                                   | destructive actions, error text |
| Error wash     | `rgba(255,74,74,0.08)`                                                                                                                                                      | danger button hover             |
| Text           | `#333`                                                                                                                                                                      | body copy                       |
| Secondary text | `#585858`                                                                                                                                                                   | labels, secondary actions       |
| Muted          | `#7c7c7f`                                                                                                                                                                   | hints, disabled controls        |
| Border         | `#cad3dd`                                                                                                                                                                   | 1px dividers and control edges  |
| Subtle surface | `#eff2f5`                                                                                                                                                                   | action row / footer             |
| Page           | `#f5f5f5`                                                                                                                                                                   | page background                 |
| Overlay        | `rgba(94,94,94,0.2)` wash + 10×10 diagonal hatch (`#555`, width 2, opacity 0.02), `background-repeat: repeat`, `background-size: 10px 10px`, fade `background-color` `0.3s` | dialog backdrop                 |
| Surface        | `#ffffff`                                                                                                                                                                   | dialog panel                    |
| Radius         | `3px`                                                                                                                                                                       | buttons, inputs, inner controls |
| Dialog radius  | `8px`                                                                                                                                                                       | dialog panel corners            |
| Border width   | `1px`                                                                                                                                                                       | everywhere a divider is drawn   |
| Dialog border  | `none`                                                                                                                                                                      | dialog panel edge               |
| Font           | Roboto                                                                                                                                                                      | 14px titles, 12px body          |
| Dialog shadow  | `none`                                                                                                                                                                      | dialog panel elevation          |

No gradients, no second shadow, no colours outside this palette.

**Raw token values, CSS functions in components.** A token stores the raw value
only: a plain colour (`rgba(94,94,94,0.2)`), a plain length (`10px 10px`) or the
bare data URI of the hatch (`tokens.dialog.backdropPattern`, starting
`data:image/svg+xml`). The component owns the CSS function and wraps the token at
the point of use, e.g. `Dialog` sets
`` backgroundImage: `url("${tokens.dialog.backdropPattern}")` ``. Never pre-wrap
the value in the token and never inline the URI string in a component — the token
stays the single source of truth. A bare data URI assigned to `background-image`
is not a valid CSS value, so the declaration is dropped **silently**: no image,
no error in the console, and the backdrop falls back to a flat 20 % wash with no
hatch. Ketcher's own overlay uses `background-image: url("data:…")` for the same
reason.

**Native parity.** The overlay and panel values mirror Ketcher's own modals: the
overlay tint is the editor's `--color-background-overlay` (`rgba(94,94,94,0.2)`)
with the same `10px 10px` diagonal hatch Ketcher paints over it, and it fades in
over `0.3s` from the pre-fade wash `rgba(94,94,94,0.01)`
(`tokens.color.overlayHidden`, `tokens.dialog.transition`), and the panel frame
is a white, borderless, shadowless `8px`-radius box with no padding of its own —
the header, body and action row inside it own the spacing, as in Ketcher. Every
in-app dialog (Export, close guard, recovery, errors) inherits these values from
`tokens` and `Dialog`; per-dialog overrides are not allowed.

**Intentional divergence.** Parity covers the overlay tint, its `10px 10px`
diagonal hatch and its `0.3s` fade, plus the panel frame only. The panel does not
reproduce Ketcher's transform/opacity entrance animation. The overlay is also
`position: fixed` above the whole app (`tokens.zIndex.overlay`) rather than
`absolute` with `z-index: 40` inside the editor, because the app's dialogs
outlive the canvas.

### 6.3 Accessibility

- Container: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing
  at the dialog title.
- Focus moves into the dialog on open (the safe primary action) and is trapped:
  `Tab` / `Shift+Tab` cycle inside it. Focus returns to the trigger on close.
- `Escape` takes the least-destructive explicit choice: **Cancel** in the close
  guard and **Discard** in the recovery prompt. It never triggers Save.
- Every control has a visible label; icon-only controls need an `aria-label`.
- The focus ring uses the accent token and stays visible against every surface.

### 6.4 Pure helpers

Decision logic lives in pure functions that import neither Tauri nor the DOM,
so Vitest can exercise them (`docs/testing.md` §6.1):

- state, title and dirty formatting (`src/document.ts`);
- save vs export format mapping and the close-guard decision;
- saved-blob routing by extension and document state (`src/saveRoute.ts`);
- autosave scheduling and the recovery decision (`src/autosave.ts`).

React components and Tauri calls stay thin adapters around those helpers; do
not put decisions inline in JSX or in an event handler.

### 6.5 Toolbar commands

- **No app-owned toolbars or docks.** Do not render a fixed control group, a
  second toolbar or a floating dock over the canvas. App-level commands belong
  in Ketcher's own top toolbar.
- **Hide, never restyle.** Native toolbar entries the app replaces are hidden
  through the `Editor` `buttons` config: `buttons.<name>.hidden = true`
  (`src/ui/editorButtons.ts`). Cast to `ButtonsConfig` only where Ketcher's
  `ButtonName` union is incomplete (`save`), and justify the cast in a comment.
  Never hide native UI with CSS `display: none`, a DOM query or a Ketcher source
  edit. Ketcher's built-in **Recognize** entry stays visible: the app uses it
  for the ONNX/OCSR flow; only the native Save As entry is replaced.
- Register them through the `Editor` `customButtons` prop and handle them as
  `CUSTOM_BUTTON_PRESSED` custom actions. Button ids are namespaced
  `chemistry-draw:<command>`; one listener dispatches by id.
- Titles use sentence case (`Save`, `New`, `Export`), not Title Case, and double
  as the tooltip.
- Icons are fully transparent `imageLink` data URIs whose glyph is painted by a
  CSS `mask-image`, so it inherits the toolbar button colour. No icon files and
  no hard-coded icon colours; see §6.5.1.
- **Third-party overrides.** The Vite `resolve.alias` mapping `file-saver` to
  `src/fileSaver.ts` is the only sanctioned override of a third-party module.
  It must be documented where it is added (`vite.config.ts`) and in
  `docs/architecture.md` §5.7. Never edit files under `node_modules/`, and do
  not add another alias without the same treatment.

#### 6.5.1 Toolbar icon styling

Ketcher renders every `customButtons` entry as
`<img src={imageLink} alt={title}>` inside the toolbar button. The button's `color` drives the sibling inline-SVG
icons through `currentColor`, but an `<img>` cannot inherit `currentColor`, so a
coloured glyph baked into `imageLink` keeps a fixed colour and ignores hover and
press states. The app therefore paints the glyph with CSS instead of drawing it
in the image.

- `imageLink` is a valid, fully **transparent** SVG data URI. It only reserves
  the `<img>` box; it draws nothing.
- The visible glyph is a `mask-image` on that `<img>`, combined with
  `background-color: currentColor`. The mask uses the alpha channel, so the
  button's `currentColor` shows through the glyph shape and follows the default,
  hover and active states exactly.
- Selectors are keyed by the `alt` text Ketcher sets from our titles:
  `img[alt="Save"]`, `img[alt="New"]`, `img[alt="Export"]`, each scoped to
  `.Ketcher-root`. The ids and titles stay stable; no other attribute is
  guaranteed.
- The style string is generated in `src/ui/toolbarIcons.ts` and rendered once by
  the app **scoped to** `.Ketcher-root` — the `<style>` element is a sibling of
  the `Editor`, not a descendant of the Ketcher root, so the scope comes from
  the selector and never from DOM nesting. Ketcher source is never edited and no
  DOM query selects the buttons.
- **No hard-coded icon colours.** The style carries `currentColor` only: the
  glyph inherits Ketcher's `#333333` default, `#167782` hover and the active
  state colour from the button. A literal colour in the icon module is a bug.

Metrics and glyphs are Ketcher's own: the toolbar button is 28/32/40 px with
2/4/5 px padding (compact/default/large) and the icon fills the content box
(`width/height: 100%`). Glyphs are **outline** drawings on that 24 unit grid:
`fill="none"`, a 1.5 unit stroke, `stroke-linecap="round"` and
`stroke-linejoin="round"`, with all artwork (strokes included) confined to a
**15x15 live area centred in the box**, i.e. inset 4.5 units (path centrelines
stay within 5.25-18.75 so the 0.75 half-stroke lands on 4.5-19.5). Solid fills
are not used: a filled glyph reads far heavier than the neighbouring outline
family, whose native icons keep their ink inside the same ~15x15 area at a
comparable 1.5 unit stroke. `stroke` is `currentColor`, which inside an SVG
image resolves to the initial opaque colour, so the mask reads full alpha
without naming a colour. `fill` is never set to `currentColor`: the
mask uses the glyph's alpha, so the shape is the source of truth and the colour
comes from `background-color`. Save must stay visually distinct from a floppy
disk glyph.

---

## 7. Commits and releases

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

## 8. Sidecar contracts

- Every handler logs its route at `info`.
- Status codes: 400 invalid input, 404 unknown id, 413 payload too large, 500
  backend failure, 503 model unavailable (missing, corrupt or contract
  mismatch).
- `/v2/info` must report the **actual bound port** in `api_path`.
- Keep the sidecar stateless: a process-lifetime inference-session cache is an
  accelerator, never request state.

---

## 9. Native libraries and packaging

- Never vendor `.so` files. `task libs` / the Docker builder generate them.
- Never ship `libstdc++` or `libgcc_s`.
- Test packaging changes with `task packages` before declaring done.
- The AppImage is assembled by `scripts/make-appimage.sh`; do not reintroduce
  Tauri's linuxdeploy AppImage path.

---

## 10. ML models and inference

- Models are **never** committed or bundled. `models/` is gitignored; the model
  root is resolved first match wins: `CHEMISTRY_MODELS_DIR`, then an existing
  `<repo>/models`, then `models` in the working directory. The debug host passes
  the absolute `<repo>/models` as `CHEMISTRY_MODELS_DIR`.
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
- Activity 7 (`ship-onnx-runtime`) **ships** the pinned `libonnxruntime` 1.31.0
  through the Linux builder image and the Windows fetch script; the host points
  `ORT_DYLIB_PATH` at the bundled copy. Loading stays dynamic, and no model file
  is ever bundled.
- Bound image decoding (`image::Limits`) before trusting dimensions: 12,000 px
  per side and 128 MiB of decoder allocations. Over-limit input is `400`.

---

## 11. Tauri capabilities and filesystem scope

- `src-tauri/capabilities/default.json` is the single source of truth for what
  the webview may do. Never widen access from Rust, and never bypass
  `plugin-fs` with a host command.
- Every capability or scope change is justified in `docs/architecture.md`
  section 5.6.1 and guarded by the capability contract test
  (`docs/testing.md` section 4.1). An unjustified scope change is a review
  finding.
- Scope entries are absolute paths or `$VAR` roots (`$APPDATA/**`,
  `$HOME/**`). A bare `**` does not match absolute paths and is never an
  acceptable entry.
- Programmatic paths — autosave, recovery, restored documents — never pass
  through a dialog, so each needs an explicit static scope. Only dialog-picked
  paths get the plugin's runtime grant; do not rely on it for app-written
  files.
- Grant no permission the app does not call. Keep the fs command list in sync
  with the `@tauri-apps/plugin-fs` functions used in `src/`.

---

## 12. Vendored Ketcher patches

Ketcher is consumed as published `dist/` bundles; a bug we cannot fix in `src/`
is patched through `pnpm`'s `patchedDependencies` mechanism.

- **One patch file per package version**: `patches/<package>@<version>.patch`,
  registered in `pnpm-workspace.yaml` under `patchedDependencies`. A new
  Ketcher version gets a new file; never rename or widen an existing one.
- **Never edit `node_modules/`.** The patch file is the only source of the
  change, and `pnpm install` must reapply it from a clean store.
- **Every hunk cites its origin** in the patch context: the upstream
  issue/PR and the exact `dist/` file the hunk touches. A hunk without an
  upstream reference or a removal plan is a review finding.
- **Mirror every hunk for both bundles**: `dist/**/*.js` and
  `dist/**/*.modern.js`. The app may resolve either build, so a guard in only
  one of them is unpatched behaviour.
- **Add a regression test** with the patch: a patch-contract test asserts the
  patch file and the installed `dist/` carry the guard
  (`docs/testing.md` §4.3). The manual reproduction stays in
  `docs/verification.md`.
- **Remove the hunk when the upstream release lands.** Bump to the release that
  contains the fix, delete the hunk (and the patch file when it becomes empty),
  drop the `patchedDependencies` entry if unused, then run `pnpm install` and
  the patch-contract test. The removal plan lives beside the upstream reference
  in `docs/architecture.md` §11 and, for `parametrizeUrl`, in
  `docs/KETCHER-BUG-parametrizeUrl.md#removing-the-patch`. An applied hunk whose
  upstream fix has shipped is a review finding.
