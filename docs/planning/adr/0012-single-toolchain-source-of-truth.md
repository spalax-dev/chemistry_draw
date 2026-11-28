# 0012 — One toolchain source of truth: `.nvmrc` and `packageManager`

- **Status:** accepted
- **Date:** 2026-11-28
- **Activity:** ACT-01 (US-10, toolchain-policy)
- **Deciders:** Repository owner
- **Base line:** `develop` (1.x)

## Context

The repository declares its toolchain twice, and the copies disagree:

- `.nvmrc` pins Node `24.20.0` and `package.json` declares
  `engines.node: ">=24.20.0 <25"` and `packageManager: "pnpm@12.21.0"`.
- `.github/actions/setup/action.yml` and `.github/actions/windows-build/action.yml`
  install Node `22` and pnpm `11`. `ci.yml` and `release.yml` call them.
- `.github/workflows/quality.yml` asks for `node-version: 24` (a floating major)
  and pnpm `12.21.0`.
- `scripts/Dockerfile` uses NodeSource `setup_24.x` and an unpinned
  `npm install -g pnpm`.

A workflow can therefore build with a Node/pnpm pair that the lockfile and the
Ketcher 3.21 floor (ADR 0011) do not support, and the builder image can install
a different pnpm on every rebuild. The drift is invisible until a lockfile or a
native dependency fails on a runner that looked green a week earlier.

## Decision

`.nvmrc` and `packageManager` are the **only** toolchain declarations:

1. **Node comes from `.nvmrc` (`24.20.0`).** Every workflow and composite action
   installs it with `actions/setup-node` and `node-version-file: .nvmrc`; no
   workflow pins a Node major or a floating `24`.
2. **pnpm comes from `packageManager` (`12.21.0`).** Corepack and
   `pnpm/action-setup` resolve the field; no action pins an unrelated major and
   no Dockerfile installs an unversioned pnpm.
3. **The `chemistry-builder` image pins the same pair.** It installs Node 24 and
   the exact pnpm `12.21.0`, so `task libs` and `task packages` run the
   toolchain CI validated.

`ci.yml` runs the build/test suite on `develop` pushes and pull requests as well
as `main`, so the `develop` line is covered by the same gate. ACT-02 lands the
workflow, action, Dockerfile and capability changes; this ADR and the docs in
ACT-01 are their contract.

## Alternatives considered

| Alternative                                               | Why not                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Keep per-workflow pins and fix them one at a time         | The next dependency bump repeats the drift; the source of truth is still ambiguous                             |
| Use `node-version: 24` everywhere                         | A floating major picks up 24.x minors that `.nvmrc` and `engines` do not promise, so CI can diverge from local |
| Use a `.tool-versions` or a custom action to install both | Adds a second declaration file; `.nvmrc` and `packageManager` already exist and are read by standard actions   |
| Let the builder float the latest pnpm                     | `pnpm-lock.yaml` and Corepack expect one version; a floating pnpm can rewrite or reject the lockfile           |
| Run `ci.yml` on `main` only                               | The `develop` line is where 1.x work lands, so it would merge untested builds                                  |

## Consequences

- **Positive:** local development, CI, the composite actions and the builder
  image run the same Node/pnpm pair; one edit to `.nvmrc` or `packageManager`
  moves every consumer; `develop` gets the build/test suite.
- **Negative:** every consumer now depends on the file reads, so a new workflow
  that hardcodes a version is a regression caught by the toolchain-alignment
  contract test (`scripts/lib/toolchain-alignment.test.mjs`, ACT-02).
- **Follow-up:** ACT-02 aligns the actions, `quality.yml`, `ci.yml` and
  `scripts/Dockerfile`. The unused `dialog:allow-message` grant is removed in the
  same story; that is an application of the in-app dialog policy in ADR 0010, not
  a second toolchain decision.

## References

- `docs/planning/stack.md` §1 and §4 — runtime floor, CI and tooling.
- `docs/DEVELOPMENT.md` — local and Windows toolchain prerequisites.
- `docs/harness/verification.md` §3.1 — the `ci.yml` gate and its coverage.
- Related ADRs: 0011 (Node 24.20.0 floor and Corepack), 0010 (no native message
  boxes).
