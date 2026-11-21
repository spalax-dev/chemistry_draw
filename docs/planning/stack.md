# Stack

> What the 1.x line is built with, and why. Choosing the stack is PLANNING;
> changing it afterwards is an ADR.
>
> **Reconstructed from the manifests and lockfiles on 2026-11-21.** Versions are
> the dependencies declared in this repository, not a promise about the next
> release.

## 1. Runtime and language

- **Frontend language:** TypeScript ~5.6.2, `strict` on, bundled by Vite 6.0.3
  and type-checked with `tsc --noEmit`.
- **Systems language:** Rust, edition 2021, stable toolchain (`dtolnay/rust-toolchain@stable`
  in CI). The workspace is the repository root: `src-tauri` and
  `src-tauri/sidecar`.
- **JavaScript runtime:** Node.js 22 in CI. pnpm 11 in CI (`pnpm/action-setup@v4`);
  a newer local pnpm still resolves the committed `pnpm-lock.yaml`, and CI is
  the authoritative version.
- **Style:** one formatter and one linter per language, enforced by the harness —
  Prettier 3.9.10 + ESLint 10.14 (typescript-eslint 8.72, react-hooks 7.1) for
  TypeScript/TSX/CSS/JSON/YAML/Markdown; rustfmt + Clippy `-D warnings` for Rust;
  ShellCheck for shell scripts. No warnings allowed.

## 2. Frameworks and libraries

| Concern           | Choice                                                                                       | Why                                                                                                   | ADR  |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- |
| Desktop shell     | Tauri v2 (host crate `2`, CLI and JS API `2.12.4`)                                           | Small native shell over the system WebView; Rust host for process supervision                         | —    |
| UI framework      | React 18.3.1 + React DOM 18.3.1                                                              | Ketcher is a React component tree; matching its major version avoids duplicate React copies           | —    |
| Chemical editor   | `ketcher-react` / `ketcher-core` 3.18.0 (patched)                                            | The product is a Ketcher packaging; the patch carries the `parametrizeUrl` fix and the `ReBond` guard | 0005 |
| Build tool        | Vite 6.0.3, `@vitejs/plugin-react` 4.3, `vite-plugin-node-polyfills`                         | Ketcher's bundles expect a few browser globals; the alias keeps saves on Tauri's filesystem           | —    |
| HTTP sidecar      | axum 0.7 + tokio 1 (full)                                                                    | Small, typed HTTP surface on a loopback port; async keeps Indigo responsive during ML work            | —    |
| HTTP middleware   | tower-http 0.5 (`cors`, `trace`)                                                             | The webview origin differs from the loopback server; trace logs every route                           | —    |
| Serialization     | serde 1 + serde_json 1                                                                       | JSON for the Indigo API, model status and error envelope                                              | —    |
| Native chemistry  | Indigo and Indigo Renderer via C FFI                                                         | The product replaces Ketcher's WASM backend with the native library                                   | 0002 |
| ONNX binding      | `ort` 2.0.0-rc.15, `default-features = false`, `std` + `api-31` + `load-dynamic`             | No link-time dependency; the shipped runtime is selected at process start                             | 0003 |
| Inference runtime | ONNX Runtime 1.31.0 (CPU)                                                                    | Pinned, shipped, SHA-256 verified; no Python or TensorFlow at runtime                                 | 0003 |
| Image decoding    | `image` 0.25 (png, jpeg, webp only)                                                          | The three accepted upload formats; bounded decoder limits are part of the contract                    | —    |
| Model download    | reqwest 0.12 (`rustls-tls`, `stream`) + futures-util 0.3                                     | Streaming bodies for progress and cancellation; rustls avoids an OpenSSL link dependency              | 0004 |
| Checksums         | sha2 0.10                                                                                    | Artifact and manifest verification                                                                    | 0004 |
| Disk preflight    | fs2 0.4                                                                                      | Cross-platform free-space probe before a download                                                     | 0004 |
| Logging           | `tracing` 0.1 + `tracing-subscriber` 0.3 (sidecar), `log` 0.4 + `tauri-plugin-log` (host/UI) | One rotating file plus stdout; the host forwards sidecar output                                       | —    |

Rule: a new runtime dependency needs a reason and a lockfile update. A new
_foundational_ dependency (a framework, a runtime, a protocol client) needs an
ADR.

## 3. Native libraries and data

- **Native libraries are generated, never vendored.** Linux builds Indigo and
  Indigo Renderer inside `chemistry-builder` (Debian 12) and copies them with
  `task libs` into `src-tauri/lib/linux-x86_64/` (gitignored). Windows downloads
  the pinned Indigo 1.46.0 archive with `scripts/fetch-windows-libs.ps1`.
- **ONNX Runtime** is shipped as 1.31.0 on both platforms, fetched from the
  official `Microsoft.ML.OnnxRuntime` NuGet package (the GitHub release assets
  are gone), SHA-256 verified, and loaded dynamically.
- **The support floor is glibc 2.36**, set by `libindigo.so`; the builder image
  is Debian 12. `libstdc++`, `libgcc_s`, fontconfig, freetype, expat, libpng and
  libbrotli are host-provided on purpose, so a bundled fontconfig cannot reject a
  newer distro configuration.
- **Primary store:** the filesystem. `.ket` documents and exports for the user,
  `<app_data>/models` for the model store, `<app_data>/recovery` for autosave,
  the app log directory for logs. There is no database, no ORM and no migration
  tool; JSON and `.ket` schemas are documented in `docs/planning/contracts.md`.
- **No cache or queue service.** A model download is a resumable `.part` file; a
  recognition job is an in-memory map with a TTL.

## 4. Tooling

| Purpose         | Tool                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| Package manager | pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); Rust builds with cargo                  |
| Frontend tests  | Vitest 3.2.7, Node environment, `src/**/*.test.ts`                                      |
| Backend tests   | `cargo test -p indigo-server`, with `LD_LIBRARY_PATH` pointing at the native libs       |
| Contract tests  | Node's built-in test runner, `node --test scripts/lib/*.test.mjs`                       |
| Documentation   | `scripts/docsgen.sh`: TypeDoc 0.28.20 for the frontend, rustdoc for both Rust crates    |
| Build           | `pnpm build` (tsc + Vite); `cargo build --release -p indigo-server`; `pnpm tauri build` |
| Packaging       | Tauri bundler (`.deb`, `.rpm`, NSIS) plus the custom AppDir script for AppImage         |
| CI              | GitHub Actions: `ci.yml`, `quality.yml`, `release.yml`; Windows build composite action  |
| Task runner     | `Taskfile.yml` (`task libs`, `task run`, `task packages`, `task harness`)               |

Generated documentation is build output: TypeDoc writes `docs/generated/api`
(gitignored), rustdoc writes into Cargo's target directory. The source of truth
is the docblock in the code.

## 5. Environments

| Environment            | Purpose                                                        | Data                                                        |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Local development      | `task run` / `pnpm tauri dev`; browser fallback via `pnpm dev` | Developer's `models/` and `.ort/`; real filesystem          |
| Packaged clean install | Release validation, including the B3 download flow             | Fresh `<app_data>` root; no models until the user downloads |
| Packaged upgrade       | Catalog update/repair on an existing install                   | Existing `<app_data>/models`; no rollback in v1             |

There is no staging or production service. CI builds the sidecar, runs tests and
produces artifacts; a release publishes the same installers CI validated.

## 6. Hosting and operations

- Distribution is GitHub Releases: `.deb`, `.rpm`, AppImage and the Windows NSIS
  `.exe`. Version bumps are driven by release-please from Conventional Commits;
  `CHANGELOG.md` is not hand-edited.
- Configuration is environment-based (`INDIGO_PORT`, `CHEMISTRY_MODELS_DIR`,
  `CHEMISTRY_MODEL_CATALOG`, `ORT_DYLIB_PATH`). There are no secrets in the
  repository or the app.
- Every failure has a support signal: `GET /v2/health`, `GET /v2/models`, and the
  rotating log file. Panics are logged with their location.
- A release is gated on Phase D and Phase E of `docs/ROADMAP.md`; the rebuilt
  0.1.7 artifacts are internal verification builds, not a release.

## 7. Deliberate omissions

- **Imago and OpenCV** — removed end to end; the recognition control is served by
  the local pipeline behind a compatibility shim (ADR 0002).
- **Python, TensorFlow and a GPU provider** — the toolchain used them offline to
  produce the models; the app does not ship them.
- **Bundled model weights** — the installers would grow by ~324 MB and every user
  would pay for a feature they may not use (ADR 0004).
- **A database** — there is no multi-user data; files and a manifest are enough.
- **Cloud accounts, telemetry and a hosted recognition API** — privacy and
  offline-first are product decisions, not missing features.
- **A macOS package** — out of scope for now (no bundle or CI). Android is a
  possible future target, not planned.
- **OpenSSL** — the downloader uses rustls, so the sidecar does not link OpenSSL.

## 8. Pending decisions

- **Ketcher 3.21 and Indigo 1.49.0 on 1.x** — US-07. Stable 3.21.0 does **not**
  contain the upstream `parametrizeUrl` fix, so a narrowed patch remains; the
  ReBond fix is upstream. The source-built multi-language `ketcher-react`
  tarball needs its own ADR. Redo on `develop`; the parked
  `wip/e1-develop-based`/`phase-e1-ketcher-indigo` prototypes are reference only.
- **Documentation generator pinning** — the generator is wired through
  `scripts/docsgen.sh`, which prefers a local TypeDoc and falls back to a pinned
  `npx` version. Whether TypeDoc becomes a `devDependency` is a harness decision.
- **Performance budgets** — the measured latencies exist (classifier p50/p95
  49/206 ms, OCSR 1115/2156 ms) but no regression thresholds gate a release.
  This is US-02.
- **Final identity** — name, icon, bundle identifier and app-data path are
  provisional. Rebranding is **US-05, part of 1.x**, sequenced after the
  functional product and before launch. It is independent of model delivery, and
  any app-data/path move is a separate packaging decision.
- **Line unification** — at the official launch the 1.x line updates from
  `main` (0.1.8 baseline, backstage, layout and release policy) and cuts 1.0.0.
  The detailed migration and user/app-data consequences need a launch ADR, not a
  silent merge.

## 9. Reverse ADRs for baked-in choices

These decisions were already in the code when the foundation was reconstructed.
They are recorded as accepted with their reconstruction date:

| ADR                                                    | Decision                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| [0002](adr/0002-remove-imago-and-recognize-locally.md) | Remove Imago and recognize through a local ONNX pipeline        |
| [0003](adr/0003-dynamic-onnx-runtime-loading.md)       | Load ONNX Runtime dynamically and ship the runtime, not weights |
| [0004](adr/0004-hugging-face-model-delivery.md)        | Deliver models from Hugging Face on demand (B3)                 |
| [0005](adr/0005-ketcher-parametrizeurl-patch.md)       | Patch Ketcher per version through pnpm, never `node_modules`    |
| [0006](adr/0006-ocsr-single-model-parity.md)           | One hand-drawn OCSR model with a calibrated parity gate         |
| [0007](adr/0007-two-line-repository-model.md)          | Maintain two repository lines                                   |
