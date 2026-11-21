# 0005 — Patch Ketcher per version through pnpm

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code on 2026-11-21; decided during 0.1.x)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

Chemistry Draw consumes Ketcher as published `dist/` bundles. Two upstream
defects affect the app:

1. **`parametrizeUrl`** in `ketcher-core` 3.18.0 turns the port in
   `127.0.0.1:9321` into a placeholder, so the editor's API calls cannot reach
   the sidecar. Upstream fixed it in
   [epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552), but no
   release containing the fix was published when the app adopted 3.18.
2. **`ReBond` render crash.** When a bond references a half-bond no longer in
   `restruct.molecule.halfBonds` (invalid-valence edits, undo of deletions),
   `ReBond.getSelectionPoints` dereferences `undefined` and throws every frame.
   The guard mirrors [epam/ketcher#11165](https://github.com/epam/ketcher/pull/11165).

The webview cannot fix either bug from `src/`: it is inside Ketcher's bundled
code. Editing `node_modules/` by hand is not reproducible and disappears on the
next install.

## Decision

Patch Ketcher through pnpm's `patchedDependencies`, never by editing
`node_modules/` or forking the editor:

1. **One patch file per package version:**
   `patches/ketcher-core@3.18.0.patch`, registered in `pnpm-workspace.yaml`. A new
   Ketcher version gets a new file; an existing one is never renamed or widened.
2. **Mirror every hunk for both bundles** (`dist/**/*.js` and
   `dist/**/*.modern.js`), because the app may resolve either build.
3. **Every hunk cites its origin** — the upstream issue/PR and the exact `dist/`
   file — and a removal plan.
4. **Add a regression test** with the patch: the patch-contract test asserts the
   patch file and the installed bundle carry the guard.
5. **Remove the hunk when the upstream release lands:** bump, delete the hunk
   (and the file when empty), drop the `patchedDependencies` entry if unused, run
   `pnpm install` and the patch-contract test.

The manual reproduction and removal procedure for `parametrizeUrl` live in
`docs/KETCHER-BUG-parametrizeUrl.md`.

## Alternatives considered

| Alternative                                           | Why not                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Edit files under `node_modules/`                      | Not reproducible, lost on install, invisible in review                                                                                    |
| Fork `ketcher-core`/`ketcher-react` in the repository | A permanent fork to maintain, build and publish; far more than two guards                                                                 |
| Wait for the upstream release before shipping         | The port bug makes the app unusable; 0.x users need a working build now                                                                   |
| Avoid a numeric port in the API URL                   | The sidecar must bind a real TCP port; there is nothing to rewrite the URL to                                                             |
| Build and vendor a custom `ketcher-react` tarball     | The parked E1 work contains such a tarball, but it is not adopted: it adds a build and a supply-chain surface that would need its own ADR |

## Consequences

- **Positive:** the app is reproducible from the lockfile, every patch is
  reviewable with its upstream reference, and a Ketcher upgrade has an explicit
  removal checklist.
- **Negative:** a patch is a maintenance debt tied to a version; every upgrade
  must re-check both bundles and the patch-contract test. The 3.18 patch is not
  the long-term fix.
- **Follow-up:** US-07 adopts Ketcher 3.21 and Indigo 1.49.0, which removes the
  `parametrizeUrl` hunk; the prototype branch already carries a
  `patches/ketcher-core@3.21.0.patch` and must not be merged as-is.

## References

- `docs/KETCHER-BUG-parametrizeUrl.md`.
- `docs/planning/architecture.md` §11 "Temporary workarounds".
- `docs/conventions.md` §12 "Vendored Ketcher patches".
- `patches/ketcher-core@3.18.0.patch`, `pnpm-workspace.yaml`.
- Related ADRs: 0007 (line model, because E1 is main-only).
