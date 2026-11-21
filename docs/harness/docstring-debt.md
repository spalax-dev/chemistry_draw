# Docstring debt — baseline and policy

Status: active debt, tracked
Owner: Chemistry Draw maintainers (the maintainer who owns the burn-down story)
Generated: 2026-11-21

Documentation is the source of truth: the docblocks in the code are the API
documentation, and `docs/` explains decisions. The generator and the docblock
gate enforce that rule without disabling it for the legacy code.

## Generator

| Half                                  | Tool            | Config                | Output                             |
| ------------------------------------- | --------------- | --------------------- | ---------------------------------- |
| Frontend (`src/`)                     | TypeDoc 0.28.20 | `typedoc.json`        | `docs/generated/api/` (gitignored) |
| Tauri host (`src-tauri/src/`)         | rustdoc         | `cargo doc --no-deps` | `target/doc/` (gitignored)         |
| Indigo sidecar (`src-tauri/sidecar/`) | rustdoc         | `cargo doc --no-deps` | `target/doc/` (gitignored)         |

`bash scripts/docsgen.sh` runs all three and fails on any generator error. The
harness engine calls that script (`--activity`, `--story`). TypeDoc is pinned in
the script and is not a `package.json` dependency, so the script prefers
`node_modules/.bin/typedoc` and falls back to `npx typedoc@0.28.20`.

TypeDoc's `validation.notDocumented` is deliberately off in `typedoc.json`: the
generator must build the legacy tree, and the docblock gate below owns the
baseline. Enabling it would fail the generator on the same debt instead of
reporting it as a budget.

## Docblock gate

`node scripts/check-docblocks.mjs` scans deterministically, without network:

- every non-test `.ts`/`.tsx` file under `src/`: each `export`ed declaration must
  have a leading `/** ... */` docblock, and each file must have a module-level
  docblock;
- every non-test `.rs` file under `src-tauri/src/` and
  `src-tauri/sidecar/src/`: every `pub fn|struct|enum|trait|union|type|const|static`
  must have a `///` docblock, and each file must start with `//!` module docs.
  `pub(crate)`, `pub use` and `pub mod` are excluded: re-exports and module
  declarations are documented at their target/module, not on the `use` line.

The gate fails only on entries **not** in `docs/harness/docblock-baseline.txt`:
a new undocumented export/file, or a symbol whose docblock was removed. It
reports entries that are now documented so the baseline can shrink. An empty
scan is an error, never a pass.

```bash
node scripts/check-docblocks.mjs                  # gate
node scripts/check-docblocks.mjs --write-baseline # rewrite after documenting
```

`--write-baseline` is not a way to accept new debt silently: it is run by the
owner after documenting symbols (to shrink the file) or, exceptionally, to
record reviewed legacy debt. The baseline must never grow without a reason in
the story.

## Baseline

`docs/harness/docblock-baseline.txt` — 61 entries at generation time:

| Area                                       | Entries |
| ------------------------------------------ | ------- |
| TypeScript exported symbols                | 25      |
| TypeScript files without a module docblock | 6       |
| Rust public items                          | 28      |
| Rust files without `//!` module docs       | 2       |

The largest groups:

- `src/document.ts` and `src/autosave.ts` exported interfaces/types (the pure
  model is documented at module level but not per type);
- UI prop interfaces in `src/ui/*`;
- sidecar `transport/*` handlers (`post_*`, `get_*`) and
  `service/indigo_ops.rs` operations;
- `pub fn run` in the Tauri host and the missing `//!` module headers in
  `src-tauri/src/{lib,main}.rs`;
- module docblocks missing in `App.tsx`, `main.tsx`, `fileSaver.ts`,
  `ui/Button.tsx`, `ui/Dialog.tsx`, `ui/editorButtons.ts`.

## Burn-down story (needs a backlog entry)

Proposed story: **"Document the legacy public surface and empty the docblock
baseline"**.

Acceptance:

1. Every entry in `docs/harness/docblock-baseline.txt` is documented, or the
   remaining entry is a reviewed exception with a reason in this file.
2. `node scripts/check-docblocks.mjs --write-baseline` produces an empty list.
3. `bash scripts/docsgen.sh` is green and `docs/generated/api` shows no
   undocumented exported symbols when generated with
   `--validation.notDocumented`.
4. No new undocumented exports/files: the gate stays enabled on every change.

Suggested split: (a) frontend pure model + UI prop types, (b) sidecar transport
handlers, (c) sidecar service operations, (d) Tauri host `run` + module headers.
Do not weaken the scan or the baseline to finish the story.

## Rustdoc warnings

`cargo doc --no-deps` is a hard gate for errors, not warnings. Current warnings
are intra-doc links from public module docs to private constants
(`MAX_CENTRAL_SIDE`, `PROCESSING_TIMEOUT`). They are cosmetic and can be fixed
in the same burn-down story; they do not block the generator today.
