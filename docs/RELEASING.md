# Releases and SemVer

Chemistry Draw follows **Semantic Versioning**. release-please computes the next
version from Conventional Commits; do not hand-edit `CHANGELOG.md`.

## Bump rules

- **MAJOR (`X.0.0`)** — a breaking change: an incompatible public API/behaviour,
  a removed feature (including deprecated ones), or a fundamental
  architecture/UX redesign. Mark the commit with `feat!`/`fix!` or a
  `BREAKING CHANGE:` footer.
- **MINOR (`X.Y.0`)** — a new backwards-compatible feature. The patch resets to
  zero. Example: `1.5.3 → 1.6.0`.
- **PATCH (`X.Y.Z`)** — a backwards-compatible bug fix or security fix.
  Example: `1.5.3 → 1.5.4`.

The configuration disables the pre-1.0 shortcuts
(`bump-minor-pre-major: false`, `bump-patch-for-minor-pre-major: false`), so a
feature bumps **MINOR** even before `1.0.0`; it is never hidden in a PATCH bump.

Examples: fix `0.1.8 → 0.1.9`; feature `0.1.9 → 0.2.0`; breaking
`0.2.0 → 1.0.0`.

## Lines and commits

- `main` is the **0.x maintenance/support** line; `develop` is the **1.x
  integration** line. The rules apply to both; the branch model is in
  `AGENTS.md` and `docs/conventions.md` section 7.
- Only `feat`/`fix` and breaking commits drive releases. `chore`, `docs`,
  `build`, `test` and `refactor` do not.
- Release notes and the changelog are release-please-owned.

## Baseline reconciliation: `0.1.8` on the 1.x line

`main` released `0.1.8` (tag `chemistry-draw-v0.1.8`) while `develop` still
carried `0.1.7`. The 1.x line reconciles that released baseline once; it does
not merge or cherry-pick the `main` product line.

**Version carriers.** All of them now name the last released version:

| Carrier                         | Value   |
| ------------------------------- | ------- |
| `package.json`                  | `0.1.8` |
| `src-tauri/tauri.conf.json`     | `0.1.8` |
| `src-tauri/Cargo.toml`          | `0.1.8` |
| `src-tauri/sidecar/Cargo.toml`  | `0.1.8` |
| `Cargo.lock` (workspace crates) | `0.1.8` |
| `.release-please-manifest.json` | `0.1.8` |

**Why `0.1.8` and not `1.0.0`.** The launch version is not hand-set. release-please
computes it from the breaking commit that ships the 1.x line, so the manifest
must hold the version that was actually released last. Leaving it at `0.1.7`
would make release-please propose `0.1.8` again and collide with the published
tag; setting it to `1.0.0` would make release-please treat the launch as already
released and compute the next version from there. `0.1.8` keeps the baseline
truthful and lets the launch resolve to `1.0.0` on its own.

**No 0.x release is re-cut.** The release workflow runs release-please only on
`main`; `develop` is integration-only and never publishes. The reconciled
`0.1.8` is a baseline, not a new 0.x release. Do not create a tag or release by
hand.

**What is taken from `main`.** The released baseline, not its product code: the
version carriers above, the backstage and editor-tab screenshots
(`docs/assets/`), the README features and screenshots, and the release/build
layout (deb/rpm/AppImage plus the NSIS installer, generated artifacts under
`build/`).

**What is deliberately not taken.** Imago is not part of 1.x: no
`imago-worker` binary, no OpenCV/BLAS/LAPACK build dependencies, no Imago
routes or smoke assertions, and no `main` description text that advertises
Imago. The 1.x line keeps its ONNX Runtime, model download/setup and OCSR
recognition path.
