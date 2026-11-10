# Contributing to Chemistry Draw

Thanks for your interest in contributing! Chemistry Draw is a community-maintained
desktop packaging of [Ketcher](https://github.com/epam/ketcher) (EPAM, Apache
2.0). Bug reports, feature ideas, documentation improvements, and code changes
are all welcome.

## Ways to contribute

- **Report a bug** — open an issue with what you expected, what happened, your
  OS, and the app version. Logs help a lot (see
  [docs/DEVELOPMENT.md#logs-and-diagnostics](docs/DEVELOPMENT.md#logs-and-diagnostics)).
- **Suggest an improvement** — open an issue describing the problem you want to
  solve or the workflow you want to improve.
- **Improve docs** — clarify setup steps, fix mistakes, or add examples.
- **Submit code** — fix a bug or implement an agreed change.

For larger changes, please open an issue first so we can align on the approach.

## Development setup

See **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** for prerequisites, platform
notes (Linux and Windows), how to build native libraries, run the app, and read
diagnostics.

Quick start (Linux):

```bash
pnpm install
task libs   # builds Indigo libs via Docker; required for the sidecar
task dev
```

## Project workflow

This repository follows a **docs → test → implement → review** flow for changes:

1. **Docs** — describe the intended behavior in `README.md` and/or `docs/`.
2. **Test** — add or update tests that cover the change (confirm they fail for
   the right reason before implementing).
3. **Implement** — make the smallest change that satisfies the tests and docs.
4. **Review** — verify the change against
   [docs/verification.md](docs/verification.md) and
   [docs/CHECKPOINTS.md](docs/CHECKPOINTS.md).

The verification gate is:

```bash
node scripts/harness.mjs
```

It must pass before a change is considered ready. For faster local iteration you
can use `node scripts/harness.mjs --fast` (skips the frontend build, uses
`cargo check` instead of Clippy, and skips sidecar tests), but the full run is
required before opening/submitting the change. The harness runs policy/tests,
typecheck, lint/format checks, Rust formatting/Clippy, sidecar tests, and
ShellCheck as configured by the project.

## Coding and commit conventions

- Follow [docs/conventions.md](docs/conventions.md) for style, layout, and
  project rules.
- Use **[Conventional Commits](https://www.conventionalcommits.org/)** and the
  project's **[commit policy](docs/commit-policy.md)**. `feat`/`fix` are for
  **product changes** that affect Chemistry Draw users and appear in
  releases/changelog; CI, Actions, agent harness, and repo tooling use
  `chore(ci)`, `build`, `docs`, etc.
- Keep commits focused; explain _why_ in the message.
- Do not commit generated/binary artifacts such as `src-tauri/lib/`, `target/`,
  `dist/`, or `dist-packages/`.

## Pull requests

- Base your work on the current `main` branch.
- Keep PRs small and scoped to one change when possible.
- Include tests or a clear verification note for behavior changes.
- Update docs when behavior, setup, or user-facing output changes.
- Make sure `node scripts/harness.mjs` passes locally (or explain any
  environment-specific limitation).

## Getting help

If you're unsure where to start, open an issue describing what you'd like to do.
For architecture context, see [docs/architecture.md](docs/architecture.md).
