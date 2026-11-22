# Structure

> The physical shape of the repository. A new top-level folder is an architecture
> change, not a convenience.
>
> **Reconstructed from the working tree on 2026-11-21** (branch `develop`).
> Updated with the US-01 backstage/file-workflow and 0.1.8 baseline targets
> (ADR 0009). Paths are relative to the repository root.

## 1. Tree

```text
.
├── AGENTS.md                     harness navigation map
├── BACKLOG.md                    coarse user stories
├── Cargo.toml                    workspace: src-tauri + src-tauri/sidecar
├── Cargo.lock
├── Taskfile.yml                  task libs / run / packages / harness
├── index.html                    Vite entry
├── package.json                  frontend manifest and scripts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml           patchedDependencies (Ketcher)
├── opencode.json                 agent permissions and MCP config
├── activities.schema.json        shape of the derived activity plan
├── typedoc.json                  TypeDoc entry points and output
├── tsconfig.json                 app config
├── tsconfig.node.json            Vite config type-check
├── vite.config.ts                React, node polyfills, file-saver alias
├── vitest.config.ts              node environment, src/**/*.test.ts
├── eslint.config.js
├── .prettierrc.json / .prettierignore
├── .opencode/                    agent roles and the harness-guard plugin
├── .harness/                     stage and schedule state (ignored)
├── patches/
│   └── ketcher-core@3.18.0.patch
├── public/
│   └── raphael.min.js
├── src/                          frontend source and colocated tests
│   ├── App.tsx                   composition: startup, backstage, tabs, file commands, dialogs
│   ├── main.tsx
│   ├── backstage.ts              backstage section model and default
│   ├── tabs.ts                   pure tab model, titles, close-guard decisions
│   ├── tabStore.ts               per-tab snapshot and index I/O
│   ├── fileMenu.ts               pure File menu item model
│   ├── recent.ts                 recent-documents list (localStorage)
│   ├── recentDetails.ts          size, date, validation and preview keys
│   ├── recentStructures.ts       recent-structures table rows
│   ├── previewCache.ts           Indigo SVG thumbnail cache
│   ├── templateLibrary.ts        real Ketcher Structure Library mapping
│   ├── templates.ts              legacy curated descriptors (fallback only)
│   ├── document.ts               pure document state and save/export mapping
│   ├── autosave.ts               per-tab scheduling and recovery decision
│   ├── autosaveStore.ts          single-document snapshot I/O (legacy; no caller after ADR 0010)
│   ├── saveRoute.ts              blob routing by extension
│   ├── fileSaver.ts              file-saver alias target
│   ├── logging.ts                console/error forwarding to the host log
│   ├── recognizeErrors.ts        recognition error unwrapping and copy
│   ├── modelSetup.ts             model status, actions and HTTP adapters
│   ├── ketcherOptions.ts         Ketcher runtime seams: provider, API base, library, options
│   ├── overrides.css             hides Ketcher's unused version label
│   ├── ui/                       presentational components and tokens
│   │   ├── Backstage.tsx         backstage overlay, rail and sections
│   │   ├── TabStrip.tsx          tabs, File button slot, home button, close
│   │   ├── FileMenu.tsx          File popup, recent section and keyboard
│   │   ├── HomeButton.tsx        strip button that opens the backstage
│   │   ├── backstage/            Welcome/Open/Models/About sections, cards, table
│   │   └── ...                   Dialog, Button, DocumentDialogs, ModelSetupDialog (+ hook)
│   └── *.test.ts                 Vitest suites, next to their module
├── src-tauri/
│   ├── src/
│   │   ├── main.rs               binary entry
│   │   └── lib.rs                host lifecycle: port, spawn, env, logs
│   ├── sidecar/                  indigo-server crate
│   │   ├── Cargo.toml
│   │   ├── build.rs
│   │   ├── fixtures/             images used by recognition tests
│   │   └── src/
│   │       ├── lib.rs            router and module map
│   │       ├── main.rs           bind, CORS, watchdog, INDIGO_PORT
│   │       ├── error.rs          AppError → HTTP status
│   │       ├── state.rs          shared port, model root, job store
│   │       ├── transport/        axum handlers per domain
│   │       ├── service/          indigo_ops, recognition, jobs, ml/
│   │       ├── service/ml/       runtime, registry, catalog, download,
│   │       │                     preprocessing, classifier, OCSR, paths
│   │       ├── ffi/              extern "C" Indigo bindings
│   │       └── tests/            one module per sidecar domain
│   ├── capabilities/
│   │   └── default.json          the webview's only permission source
│   ├── icons/
│   ├── tauri.conf.json           common config
│   ├── tauri.linux.conf.json
│   ├── tauri.windows.conf.json
│   └── lib/                      generated native libs (gitignored)
│       ├── linux-x86_64/
│       └── windows-x86_64/
├── docs/
│   ├── architecture.md           detailed reference (authoritative)
│   ├── conventions.md            style, tooling and project rules
│   ├── testing.md                test policy and per-domain patterns
│   ├── verification.md           manual and packaged verification
│   ├── DEVELOPMENT.md            toolchain, native libs, packaging
│   ├── ROADMAP.md                phases and the release backlog
│   ├── RELEASING.md              SemVer and line rules
│   ├── commit-policy.md
│   ├── CONTRIBUTING.md
│   ├── CHECKPOINTS.md
│   ├── KETCHER-BUG-parametrizeUrl.md
│   ├── assets/                   backstage.png and editor-tabs.png (0.1.8 baseline)
│   ├── benchmarks/               model parity and OCSR tail reports
│   ├── harness/                  the harness contract: stage, gates, docblock baseline
│   └── planning/                 this foundation (hand written)
│       ├── overview.md
│       ├── architecture.md
│       ├── stack.md
│       ├── structure.md
│       ├── contracts.md
│       ├── c4/                   context, container, component
│       ├── sequences/            recognition, model setup, backstage/file workflow
│       └── adr/                  decisions 0001-0009
├── scripts/                      harness, packaging, native-lib tooling
│   ├── harness.mjs / harness-lib.mjs / build_harness.mjs
│   ├── docsgen.sh                TypeDoc + rustdoc
│   ├── check-docblocks.mjs
│   ├── build-libs.sh / build-image.sh / fetch-onnxruntime.sh
│   ├── fetch-windows-libs.ps1
│   ├── build-packages.sh / build-deb.sh / build-rpm.sh
│   ├── build-appimage.sh / make-appimage.sh
│   ├── check-native-libs.sh / check-libs.sh / check-deps.sh
│   ├── repack-native-payload.sh / bundle-libs.sh
│   ├── model-parity.mjs          Phase D parity harness
│   └── lib/                      Node contract tests and policy logic
├── progress/
│   ├── history.md                durable session record (tracked)
│   └── current.md                live state (ignored)
├── models/                       downloaded models (ignored)
├── .ort/                         developer ONNX Runtime (ignored)
├── docs/generated/               generated API docs (ignored)
├── build/                        packages and benchmark output (ignored)
├── dist/                         Vite output (ignored)
└── target/                       cargo output (ignored)
```

## 2. What lives where

| Folder                              | Holds                                                                    | Does not hold                                    |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `src/`                              | React/Ketcher integration, pure helpers, in-app dialogs, colocated tests | native calls, Node-only APIs, a second test tree |
| `src-tauri/src/`                    | Tauri host: lifecycle, commands, log wiring                              | cheminformatics or inference                     |
| `src-tauri/sidecar/`                | the whole HTTP service and its ML/native layers                          | UI code, packaging scripts                       |
| `src-tauri/sidecar/src/transport/`  | HTTP parsing, media-type and body-cap validation, status codes           | business logic, direct FFI                       |
| `src-tauri/sidecar/src/service/`    | orchestration, domain errors, the job store                              | HTTP types                                       |
| `src-tauri/sidecar/src/service/ml/` | ONNX sessions, registry, catalog, downloader, preprocessing              | HTTP handlers, `unsafe`                          |
| `src-tauri/sidecar/src/ffi/`        | `extern "C"` bindings, the only `unsafe` code                            | HTTP or ML logic                                 |
| `src-tauri/sidecar/src/tests/`      | sidecar integration tests, one module per domain                         | fixtures outside `fixtures/`                     |
| `scripts/`                          | harness, packaging, native-lib tooling, Node contract tests              | product logic, inline CI-only scripts            |
| `docs/planning/`                    | foundation documents and diagrams (hand written)                         | feature changelogs, generated output             |
| `docs/assets/`                      | backstage and editor screenshots used by the README                      | generated or benchmark output                    |
| `docs/benchmarks/`                  | measured model reports and their protocols                               | generated benchmark JSON (lives under `build/`)  |
| `patches/`                          | one Ketcher patch per package version                                    | edits under `node_modules/`                      |

### 2.1 Build and release layout

The 0.1.8 baseline and the 1.x line share one generated-artifact layout:

| Path               | Holds                                                                | Tracked |
| ------------------ | -------------------------------------------------------------------- | ------- |
| `build/`           | `packages`, `appimage` scratch, `verify` extraction and `libs` build | no      |
| `target/`          | Cargo output                                                         | no      |
| `dist/`            | Vite output                                                          | no      |
| `src-tauri/lib/`   | Native Indigo/ONNX Runtime payload, generated by `task libs`         | no      |
| `models/`, `.ort/` | Downloaded models and the developer ONNX Runtime                     | no      |

Consolidating `target/` and `dist/` under `build/` is still the Phase 2/E4
option, not part of this layout. Releases are GitHub Releases driven by
release-please from Conventional Commits; the 1.x launch is 1.0.0 regardless of
the 0.1.8 input (ADR 0009).

## 3. Naming

| Element            | Convention                                                      | Example                           |
| ------------------ | --------------------------------------------------------------- | --------------------------------- |
| Rust module        | `snake_case`                                                    | `indigo_ops.rs`, `ocsr_decode.rs` |
| Rust type          | `PascalCase`                                                    | `AppState`, `IndigoRequest`       |
| Rust function      | `snake_case`                                                    | `post_render`, `get_health`       |
| Rust test          | `test_<unit>_<behavior>_<condition>`                            | `corrupted_molfile_returns_400`   |
| TS component       | `PascalCase` file and symbol                                    | `ModelSetupDialog.tsx`            |
| TS function        | `camelCase`                                                     | `resolveApiBase`, `setupView`     |
| TS test            | colocated `*.test.ts`                                           | `src/modelSetup.test.ts`          |
| Constant           | `UPPER_SNAKE_CASE`                                              | `MAX_BODY_BYTES`                  |
| Shell script       | `kebab-case.sh`                                                 | `build-appimage.sh`               |
| Documentation file | `kebab-case.md` inside folders, `UPPER_CASE.md` at `docs/` root | `docs/planning/contracts.md`      |

## 4. Dependency direction

```text
src/ui  →  src/*.ts  →  React / Tauri APIs
src/App.tsx  →  src/ui, src/*.ts

transport/  →  service/  →  ffi/
                   └────→  service/ml/  →  ort, filesystem, HTTP client
```

- No cycles between layers.
- `transport/` never calls `ffi/` directly; it goes through a service.
- `service/` never imports axum types.
- `service/ml/` contains no `unsafe`; `ort` owns the FFI boundary.
- `src/` pure helpers import neither Tauri nor the DOM, so Vitest can run them in
  a Node environment. Tauri calls stay in thin adapters (`App.tsx`,
  `autosaveStore.ts`, `fileSaver.ts`).
- A cross-package import requires an explicit export in that package's manifest.

## 5. Generated documentation

- Path: `docs/generated/api` (TypeDoc) and Cargo's `target/doc` (rustdoc for the
  host and the sidecar). Both are gitignored.
- Produced by: `scripts/docsgen.sh` (TypeDoc 0.28.20 + rustdoc), run by the
  harness `docsgen` gate.
- Never edited by hand and never committed. The source of truth is the docblock
  in the code: `//!` module docs and `///` public items in Rust, TSDoc where a
  module has a contract.
- Legacy docstring debt is tracked in `docs/harness/docblock-baseline.txt`; the
  gate fails on new or changed symbols, not on the baseline.

## 6. Adding a file or folder

1. Update this document and `docs/planning/architecture.md` in the same activity.
2. Add the test in the documented location: `src/<module>.test.ts` for a pure
   helper, `src-tauri/sidecar/src/tests/<domain>.rs` for a sidecar behaviour.
3. Implement in the documented home.
4. Update `docs/planning/contracts.md` when the change touches a boundary.
5. Run the activity gate.

If the file does not fit, the architecture is wrong, not the folder.

## 7. Forbidden

- Generated files inside source directories.
- A second test tree next to the documented one.
- A new top-level folder without a docs update and an ADR when it changes a
  boundary.
- Committing `src-tauri/lib/`, `target/`, `dist/`, `build/`, `models/`, `.ort/`,
  `docs/generated/`, session state or any `.so`/DLL.
- Editing `node_modules/` or a published Ketcher bundle outside `patches/`.
- Secrets, environment files or model weights in the tree.
