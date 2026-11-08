# Commit policy

> Conventional Commits are mandatory, but the **type must reflect who is
> affected**. Releases and the changelog are for people using Chemistry Draw,
> not for repository plumbing.

Release automation (release-please) is configured so that **only `feat` and
`fix` (including breaking changes)** drive version bumps/releases. Even so, you
must choose commit types honestly: a wrong `fix`/`feat` pollutes release notes
and misleads users.

## Use product types only for product changes

| Type                                   | Use when                                                                                                 | Examples                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `feat`                                 | A new **user-visible or shipped** capability in Chemistry Draw                                           | editor/sidecar behavior, supported format, packaging that changes what users get  |
| `fix`                                  | A bug fix in **product behavior** (app, sidecar, native integration, shipped packaging/runtime behavior) | rendering bug, wrong conversion, sidecar crash, bundled lib issue affecting users |
| `feat!` / `fix!` or `BREAKING CHANGE:` | A breaking change for users of the product                                                               | removed/changed behavior, incompatible config/format/contract users rely on       |

**Do not** use `fix` or `feat` for CI, GitHub Actions, release workflow config,
agent harness/tooling, issue templates, contribution docs, or internal developer
scripts unless the change actually alters shipped product behavior.

## Use non-release / internal types for repository work

| Type       | Typical scope                             | Use when                                                                                                                                |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chore`    | `chore(ci):`, `chore(release):`, `chore:` | CI/workflows, release automation config, repo maintenance, dependency bumps that don't change product behavior                          |
| `build`    | `build:`                                  | Build system/packaging scripts/config changes that are internal to producing artifacts (not a user-facing fix/feature by themselves)    |
| `docs`     | `docs:`                                   | Documentation, README, contributing guides, policy docs                                                                                 |
| `refactor` | `refactor:`                               | Internal restructuring with no behavior change                                                                                          |
| `perf`     | `perf:`                                   | Performance improvement in **product** behavior (use carefully; if it doesn't affect users/shipped behavior, prefer `chore`/`refactor`) |
| `test`     | `test:`                                   | Tests only                                                                                                                              |

## Quick rule

Before using `fix:` or `feat:`, ask: **“Would a Chemistry Draw user care about
this in the changelog?”** If the answer is no, it is not a `fix`/`feat`.

## Changelog and releases

- Do not hand-edit `CHANGELOG.md` (release-please owns it).
- Release/changelog content should describe **product** changes (`feat`/`fix`).
- Keep commits focused; explain _why_ in the message body when useful.
