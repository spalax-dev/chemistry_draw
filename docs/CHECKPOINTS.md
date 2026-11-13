# CHECKPOINTS — Final State Evaluation

> In multi-agent systems, the path is not evaluated, the destination is.
> These are objective checkpoints a judge (human or AI) can use
> to decide if the project is healthy.

## C1 — Harness is Complete

- [ ] Base files exist: `AGENTS.md`, `scripts/harness.mjs`,
      `scripts/build-harness.mjs`, `scripts/lib/activity-policy.mjs`,
      `scripts/lib/activity-policy.test.mjs`, `activities.json`,
      `progress/current.md`.
- [ ] Docs exist: `docs/architecture.md`, `docs/conventions.md`,
      `docs/verification.md`, `docs/testing.md`.
- [ ] `node scripts/harness.mjs` exits with code 0.

## C2 — State is Coherent

- [ ] At most one activity in `in_progress` in `activities.json`.
- [ ] Every task declares a valid `phase` (`docs`, `test`, `implement`,
      `review`) and phases are non-decreasing in task order.
- [ ] Non-`docs` activities contain docs, test, implement and review phases;
      `docs` activities contain docs + review and no test/implement tasks.
- [ ] `review` tasks use the `reviewer` agent; docs/test/implement use
      `implementer`.
- [ ] Every `done` activity has all tasks done; every `in_progress` activity
      has exactly one `in_progress` task.
- [ ] Every `done` activity has associated passing tests (or, for docs/chore,
      the relevant harness blocks).
- [ ] `progress/current.md` is empty or describes the active session (no
      leftovers from previous sessions).

## C3 — Code Respects Architecture

- [ ] Layer rules from `docs/architecture.md` hold: `transport/` does not call
      `ffi/`, the host contains no chemistry, `unsafe` stays in `ffi/`.
- [ ] No new native libraries or `.so` files committed to git.
- [ ] No debug `println!`/`dbg!` left behind; no TODOs without context.

## C4 — Verification is Real

- [ ] `src-tauri/sidecar/src/tests/` covers the modules touched by the activity.
- [ ] Tests assert observable contracts (status + body), including negative paths.
- [ ] `cargo test -p indigo-server` shows > 0 tests and all green.
- [ ] `pnpm exec tsc --noEmit` passes.
- [ ] `pnpm run lint` and `pnpm run format:check` pass.
- [ ] `cargo fmt --all --check` and
      `cargo clippy --workspace --all-targets -- -D warnings` pass.
- [ ] Shell scripts pass `shellcheck --severity=warning`.

## C5 — Session Closed Properly

- [ ] No suspicious untracked files (`*.tmp`, build artifacts outside
      `.gitignore`, generated `src-tauri/lib/`).
- [ ] `progress/history.md` has an entry for the last session.
- [ ] The last worked activity reflects its correct state.

## C6 — Windows Build Without Imago

- [ ] `scripts/fetch-windows-libs.ps1` pins Indigo 1.46.0, verifies SHA-256 and
      never vendors DLLs/`.lib` files.
- [ ] Windows CI (`windows` job) builds and smoke-tests the sidecar: empty
      `imago_versions`, `imago_worker.found = false`, `/v2/imago/uploads` 404.
- [ ] NSIS installer is uploaded as an artifact.
- [ ] Windows docs state the no-Imago limitation and the build commands.
- [ ] Linux harness and packaging metadata remain green.

## C7 — Docs → Test → Implement → Review

- [ ] Every activity task carries a `phase` in
      `docs | test | implement | review`.
- [ ] Non-`docs` activities declare docs → test → implement → review in that
      order; `docs` activities declare docs → review only.
- [ ] New behaviour has a failing-test (RED) evidence path before its
      implementation, per `docs/testing.md`.
- [ ] No task is `in_progress` or `done` while an earlier task is not `done`
      (sequential status enforcement).
- [ ] `node --test scripts/lib/activity-policy.test.mjs` passes, including
      missing-phase, wrong-order, docs-only, sequential-status and status
      cases.
- [ ] The harness block 3 runs the policy tests and rejects an invalid
      `activities.json`.

## C8 — Document and Autosave Contract

- [x] `.ket` is the only save format: Save and Save As write `.ket`, while
      Export is the only route to Molfile V2000/V3000, SMILES, InChI, SVG and
      PNG, and never changes the document path or format.
- [x] The window title shows the document name (or `Untitled`) plus a dirty
      marker; a successful Save, Open or New clears the dirty state.
- [x] Opening a `.ket` file gives a clean document with that path; opening
      `.mol`/`.smi`/`.sdf`/`.rxn` imports through Ketcher, leaves `path` `null`
      and keeps the document dirty.
- [x] Autosave writes `.ket` plus metadata into the app data dir only while
      dirty, debounced and on a slow interval, never to the user's file, and
      the snapshot is cleared after Save, New or Open; an in-flight write
      cannot recreate a snapshot after that cleanup.
- [x] A snapshot newer than the last clean save triggers an in-app
      Restore/Discard prompt on launch; Restore re-attaches the original path
      when known. A missing or unreadable original still offers recovery
      (missing files are called out in the prompt).
- [x] Closing with unsaved changes is guarded by an in-app Save/Discard/Cancel
      dialog; Cancel keeps the window open and Save writes before closing. New
      and Open reuse the same prompt before replacing a dirty document.
- [x] Recovery, close guard and feature errors are in-app dialogs styled with
      Ketcher tokens, with `role="dialog"`, `aria-modal`, focus trap, initial
      focus and Escape handling; no new Tauri native `message`/`confirm`.
- [x] Pure helpers (title/dirty/names, save vs export, autosave scheduling,
      write generation, recovery decision, close guard) are covered by Vitest,
      and the manual checklist in `docs/verification.md` §2 passes.
- [x] Browser fallback: Save and Export download files; no autosave, recovery
      prompt or close guard.

## C9 — Ketcher Toolbar Integration

- [x] No app-owned toolbar, dock or floating control group exists; Save, New
      and Export render as Ketcher toolbar `customButtons` with sentence-case
      titles and icons that inherit the toolbar button colour (transparent
      `imageLink` painted by a CSS mask, Ketcher's native 28/32/40 px metrics,
      no hard-coded icon colour).
- [x] `CUSTOM_BUTTON_PRESSED` actions dispatch by id: Save writes `.ket` to the
      current path (Save As when untitled), New reuses the dirty guard and
      clears the snapshot, Export opens the in-app format dialog without
      touching path or format.
- [x] `Ctrl+S` is the app Save and Ketcher's `Mod+S` dialog stays shut;
      `Ctrl+Shift+S` opens Save As; `Ctrl+O` and `Ctrl+N` still work.
- [x] Ketcher's native **Save As…** entry is hidden through the `Editor`
      `buttons` config (`buttons.save.hidden`, `src/ui/editorButtons.ts`; no CSS
      or DOM hiding), so Export is the only format route; any remaining library
      save goes through the Vite `file-saver` alias (`src/fileSaver.ts`) to the
      Tauri filesystem or the export dialog (§5.7.1), while the native save
      dialog and its image-save entry are hidden; `node_modules/` is untouched.
- [x] The pure routing helper (`.ket` → document save, other extensions →
      export save, no Tauri/no handler → download) has Vitest coverage and was
      RED before implementation.
- [x] The manual checklist in `docs/verification.md` §2 "Toolbar integration"
      passes, including the browser fallback.

---

**How to use this file:** a reviewer agent
(`.opencode/agent/implementation-reviewer.md`) goes through each checkbox, marks
`[x]` or `[ ]`, and rejects session close if any boxes in C1–C9 remain empty.
