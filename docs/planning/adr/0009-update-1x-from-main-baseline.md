# 0009 — Update the 1.x line from the `main` 0.1.8 baseline

- **Status:** accepted
- **Date:** 2026-11-21
- **Activity:** ACT-01 (US-01, sync-foundation-docs)
- **Deciders:** Repository owner
- **Base line:** `develop` (1.x); the source material is `main` (0.x) at 0.1.8

## Context

US-01 brings the product workflow users already have on the 0.x line into the
1.x line. The two lines diverged deliberately (ADR 0007):

- **`main` (0.1.8)** carries the backstage welcome/Open/Models/About shell and
  home button, the real Structure Library template cards, recent structures and
  recent documents, project opens versus imports, the File menu, document tabs,
  the close/discard flows, per-tab snapshot recovery, the `build/` consolidation,
  the backstage/editor screenshots and the release-please release policy. It also
  carries Imago/OpenCV as the recognition backend on Linux.
- **`develop` (1.x)** carries the Imago removal, the native Indigo sidecar, the
  local ONNX filter, OCSR, the Ketcher compatibility shim, B3 model delivery, the
  NuGet ONNX Runtime source and the Phase D parity work. Its editor is one
  document without the backstage or the tab/file workflow.

Both lines share the Tauri shell, the sidecar boundary and the `.ket` document
format, but they are not interchangeable. A naive merge would either re-cut
0.1.8 as a 1.x release and import Imago, or drop the workflow from 1.x. The
update must be deliberate and must preserve the 1.x ML surface.

## Decision

Update the 1.x line from the `main` 0.1.8 baseline inside US-01, as a sequence of
ordinary commits on a 1.x story branch. It is **not** a `git merge` and it is
**not** a cross-merge between the product lines.

1. **The 1.x line takes `main`'s product workflow.** Backstage, real templates,
   recent structures, project Open versus Import, the File menu, document tabs,
   close/discard, per-tab recovery snapshots, path uniqueness and the recent
   documents list become 1.x behavior. The 1.x UI keeps the application shell,
   tokens and the single Ketcher instance; it does not copy a second editor.
2. **The 1.x line keeps its ML and sidecar contract.** The local ONNX filter and
   OCSR pipeline, the Ketcher `/v2/imago/uploads` compatibility shim, model
   download/verify/repair, the bundled catalog and manifest, the NuGet ONNX
   Runtime and the `/v2` HTTP contract are unchanged. ADRs 0002–0006 remain in
   force.
3. **The 0.1.8 baseline is an input, not a release.** Version files, package and
   release configuration, the `build/` layout, the screenshots and the release
   policy are reconciled into 1.x. The version files may read `0.1.8` as the
   baseline, but release-please computes the launch version from the 1.x
   breaking change, so the launch stays **1.0.0**. `develop` does not re-cut a
   0.x release.
4. **Imago product code is not imported.** The Imago backend, OpenCV and its
   native dependencies, the Imago packaging and job protocol, the bundled-image
   recognition copy and the Linux-only/Windows-without-recognition product
   claims stay on `main`. The 1.x recognition remains the local ONNX pipeline.
5. **Ketcher stays 3.18 for this port.** The workflow is ported onto the 1.x
   `ketcher-react`/`ketcher-core` 3.18 dependency. The E1 Ketcher/Indigo/language
   upgrade is not imported from `main`; US-07 redoes it on `develop` and
   re-validates the tab, template and backstage APIs.
6. **Conflicts are resolved per surface, never by deleting one side:**

   | Surface                                                                 | Winner                              | Rule                                                                                                                             |
   | ----------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
   | Backstage, templates, recent structures, File menu, tabs, close/discard | `main`'s behavior and test contract | Port and adapt to the 1.x shell; `.ket` save/Save As/Export/autosave contracts do not change                                     |
   | Recognition, model setup, sidecar routes, catalog, manifest             | `develop`                           | Untouched; the ML toolbar and Models dialog remain the real setup surface                                                        |
   | Backstage "Models" rail entry                                           | `develop`'s real Models dialog      | The placeholder list is not shipped as a fake model picker; integration decides whether the rail entry routes to the real dialog |
   | Version files and release policy                                        | `main`'s policy, 1.x version        | release-please and SemVer; the 1.x launch is 1.0.0, no 0.x re-cut                                                                |
   | Planning and harness docs                                               | `develop`                           | `main`'s detailed content is merged section by section; the 1.x foundation is not replaced wholesale                             |

7. **No cross-merge.** Port individual fixes with a cherry-pick when needed and
   preserve each line's content. The two-line model (ADR 0007) stays in force
   until the user explicitly retires `main`; US-01 is the 1.x update, not the
   retirement.
8. **Anything unresolved stays visible.** A workflow command that cannot meet
   the 1.x ML surface becomes a story or an open question; it is not dropped
   silently and the ML contract is not weakened to make the UI pass.

## Alternatives considered

| Alternative                                         | Why not                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `git merge main` into a 1.x branch                  | Reintroduces Imago and 0.x packaging; resolves UI/ML conflicts mechanically and loses the deliberate separation |
| Keep the backstage and tabs on `main` only          | 1.x users would launch into a bare editor and lose the workflow the story exists to deliver                     |
| Re-cut 0.1.8 and publish it from `develop`          | `develop` is not a 0.x release line; the launch is 1.0.0 and would be blocked behind finished ML work           |
| Import Imago as well to match `main` exactly        | Reverses ADR 0002, restores OpenCV/Imago packaging and the Windows/Linux recognition split                      |
| Rewrite the workflow from scratch against `develop` | Duplicates tested behavior and drifts from the contract users already have on 0.1.8                             |

## Consequences

- **Positive:** 1.x gains the real product UX (backstage, templates, recents,
  File menu, tabs, recovery) while keeping the HTTP/ML contract. 0.x users are
  unaffected and no 0.x release is re-cut. The conflict rule is explicit, so a
  later port can be reviewed against it.
- **Negative:** the 1.x frontend grows substantially and must be reviewed for
  duplicate commands (File menu versus ML toolbar), shortcut interception and
  backstage/Models reachability. Two copies of the workflow exist until `main`
  is retired. The detailed `docs/architecture.md` needs the same reconciliation
  as the port lands.
- **Follow-up:** ACT-02 ports the failing workflow tests, ACT-03 the UI, ACT-04
  the version/build/release/screenshot baseline, ACT-05 the App/toolbar/Models
  integration and ACT-06 the story verification. The launch remains 1.0.0 after
  US-05 rebranding; retiring the 0.x line is still a separate launch decision.

## References

- [`0007`](0007-two-line-repository-model.md) — the two-line model this update
  preserves.
- [`0002`](0002-remove-imago-and-recognize-locally.md),
  [`0003`](0003-dynamic-onnx-runtime-loading.md),
  [`0004`](0004-hugging-face-model-delivery.md),
  [`0005`](0005-ketcher-parametrizeurl-patch.md),
  [`0006`](0006-ocsr-single-model-parity.md) — the 1.x ML decisions that stay.
- `BACKLOG.md` US-01 — the story and its acceptance criteria.
- `main` commits `55720a0`…`8e5099a` (backstage, templates, recents, File menu,
  tabs) and `2b7373d` (release 0.1.8).
- `docs/planning/overview.md` §6, `architecture.md` §5 and
  `contracts.md` §5 — the reconciled 1.x foundation.
