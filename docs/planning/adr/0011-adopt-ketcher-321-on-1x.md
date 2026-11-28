# 0011 — Adopt Ketcher 3.21.0 and Indigo 1.49.0 on the 1.x line

- **Status:** accepted
- **Date:** 2026-11-28
- **Activity:** ACT-01 (US-07, ketcher-policy)
- **Deciders:** Repository owner
- **Base line:** `develop` (1.x)

## Context

The 1.x line still runs `ketcher-react`/`ketcher-core` 3.18.0 with a two-hunk
patch (`parametrizeUrl` and `ReBond`) and pins Indigo 1.46.0 on Windows while
the Linux builder does not pin a tag. The `main` 0.x line completed the E1
Ketcher/Indigo/language upgrade separately. Its work exists in the parked
`wip/e1-develop-based` prototype and the main-line E1 branch, but both were
built against `main` and carry assumptions the 1.x line does not share.

Ketcher 3.21.0 is the current stable release. It requires Node `>=24.20.0` for
both `ketcher-core` and a multi-language `ketcher-react` build, and it contains
the upstream `ReBond` fix ([epam/ketcher#11165](https://github.com/epam/ketcher/pull/11165)).
It does **not** contain the `parametrizeUrl` fix: [epam/ketcher#12552](https://github.com/epam/ketcher/pull/12552)
ships in `3.22.0-rc.1`, a prerelease, while `3.21.0` is the latest stable. The
published `ketcher-react` bundle is English-only and has no language picker, so
the language selector requires a source build.

The dependency decisions must be recorded before the dependency activity, so the
implementation follows a documented shape instead of rebuilding a parked
prototype.

## Decision

1. **Adopt exactly `ketcher-core` 3.21.0 and `ketcher-react` 3.21.0 on the 1.x
   line.** The upgrade is redone on `develop`; the parked `wip/e1-develop-based`
   prototype and the main-line E1 branch are reference only and are never
   merged.
2. **`ketcher-react` comes from the committed multi-language tarball**
   `vendor/ketcher-react/ketcher-react-3.21.0-multi.tgz`. It is a sanctioned
   source build from the `v3.21.0` tag with `KETCHER_MULTI_LANGUAGE_BUILD=true`,
   reproducible with the pnpm-only `scripts/build-ketcher-react.sh` (ACT-02).
   The tarball is committed; the build checkout never enters the app's
   dependency graph.
3. **The 3.18 patch is replaced by `patches/ketcher-core@3.21.0.patch`, narrowed
   to `parametrizeUrl` only.** The ReBond hunk is dropped because that fix is
   upstream in 3.21.0. 3.21.0 stable still has the `parametrizeUrl` bug, so the
   narrowed patch stays until a stable `3.22.0` publishes the upstream fix.
4. **Indigo is pinned to `indigo-1.49.0` on both platforms.** Linux builds from
   the `indigo-1.49.0` tag in the builder with a version guard; Windows downloads
   the 1.49.0 ZIP and verifies its SHA-256 in `scripts/fetch-windows-libs.ps1`.
5. **Node 24.20.0 is the floor.** `.nvmrc` pins `24.20.0`, the supported range is
   `>=24.20.0 <25`, and pnpm is provisioned through Corepack with
   `packageManager` as the single source of truth.

The patch principle of ADR 0005 is unchanged: one patch file per package
version, registered in `pnpm-workspace.yaml`, with every hunk citing its upstream
origin and removal plan.

**Implementation note (ACT-02).** The lockfile was regenerated with
`pnpm install --no-frozen-lockfile` and confirmed with
`pnpm install --frozen-lockfile`. Corepack resolves the pnpm version pinned in
`packageManager`, so the install does not depend on a globally installed pnpm.
The option-store adapter needed for 3.21 landed in the same activity (the
former ACT-03 was merged into ACT-02); its checks are the `src/ketcherOptions`
Vitest suite and the temporary browser flow in `docs/testing.md` §6.2.

## Alternatives considered

| Alternative                                             | Why not                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay on Ketcher 3.18.0 with the two-hunk patch          | Keeps a patch hunk that 3.21.0 already fixes, keeps an older editor, has no language selector, and leaves 1.x behind the 0.x line on the same dependency  |
| Adopt `3.22.0-rc.1` to avoid the `parametrizeUrl` patch | A prerelease is not the stable editor this line ships; the patch is small and already reviewed, and stable 3.22.0 is the removal trigger                  |
| Merge or cherry-pick the parked E1 prototype            | Built against `main`, includes an npm-based tarball build and Imago-era assumptions; not reproducible on 1.x and not the documented shape this line needs |
| Use the published npm `ketcher-react` 3.21.0            | English-only, no language picker, so the language selector cannot ship                                                                                    |
| Patch `ketcher-react` as well                           | The multi-language build is a sanctioned source build, not a patch; patching the published bundle would keep two divergence points instead of one         |

## Consequences

- **Positive:** one patch instead of two concerns, a narrower removal checklist,
  the language selector from the committed tarball, Indigo parity with the 0.x
  line, and a documented Node floor that Ketcher itself declares.
- **Negative:** the `parametrizeUrl` patch remains maintenance debt until stable
  `3.22.0`; the multi-language tarball must be regenerated when Ketcher moves;
  the Node 24.20.0 floor raises the local development baseline.
- **Follow-up:** ACT-01 records the policy (this ADR); ACT-02 adopts the
  dependencies, the patch and the tarball and adapts the option store (the
  former separate option-store activity was merged into it); ACT-04 moves Indigo
  to 1.49.0; ACT-05 records the verification. A future Ketcher bump must
  re-check, before the dependency moves:
  - the patch shape and its two `remoteStructService` hunks, plus the
    patch-contract tests split across two files: the manifest-level check in
    `scripts/lib/e1-ketcher.test.mjs` (patch text, installed regex and one
    hunk per dist file) and the executed installed-bundle check in
    `src/ketcherPatch.test.ts` (the patched helper keeps the explicit port and
    leaves undeclared placeholders literal);
  - the option-store adapter in `src/ketcherOptions.ts`, which reaches into
    Ketcher's React fiber and Redux store rather than the public
    `editor.options()` API;
  - the language selector: the multi-language build guard, the locale list
    (English and Simplified Chinese) and the persisted
    `localStorage["ketcher-language"]`;
  - the Ketcher peer ranges, the Node floor and the `/v2/imago/uploads`
    protocol.

## References

- `docs/KETCHER-BUG-parametrizeUrl.md` — the bug, its patch and the removal
  procedure.
- `docs/planning/stack.md` §1–§3 and §9 — runtime floor, dependencies and the
  ADR index.
- `docs/planning/contracts.md` §3.5 and §7 — the Ketcher job protocol and the
  version-bound compatibility rules.
- `docs/planning/c4/container.puml`, `docs/planning/c4/context.puml`.
- `docs/architecture.md` §11 — the temporary workaround.
- `docs/testing.md` §4.3 — the Ketcher patch contract tests (manifest-level and
  executed bundle).
- Related ADRs: 0005 (patch per version; superseded in part by this ADR),
  0007 (line model), 0009 (1.x baseline).
