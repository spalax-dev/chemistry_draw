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
  `AGENTS.md` and `docs/conventions.md` §7.
- Only `feat`/`fix` and breaking commits drive releases. `chore`, `docs`,
  `build`, `test` and `refactor` do not.
- Release notes and the changelog are release-please-owned.
