# Verification

> How to verify that work is correct.

---

## 1. Before declaring a task `done`

1. Run `node scripts/harness.mjs` — all blocks must pass (exit code 0). For a
   faster iteration loop (skips frontend build, uses `cargo check` instead of
   Clippy, and skips sidecar tests), use `node scripts/harness.mjs --fast`; the
   full run is still required before closing a task.
2. `pnpm exec tsc --noEmit` — no type errors.
3. `pnpm run lint` — ESLint clean.
4. `pnpm run format:check` — Prettier clean.
5. `cargo fmt --all --check` — Rust formatting clean.
6. `cargo clippy --workspace --all-targets -- -D warnings` — no Rust warnings.
7. `cargo test -p indigo-server` — all sidecar tests green
   (`LD_LIBRARY_PATH` must point at `src-tauri/lib/linux-x86_64`; the harness
   sets it for you).
8. Review `docs/CHECKPOINTS.md` — mark the applicable boxes.
9. `node --test scripts/lib/activity-policy.test.mjs` — policy tests green.
   The harness runs the same command in block 3 and then validates
   `activities.json` with `scripts/lib/activity-policy.mjs`, including
   sequential status (no `in_progress`/`done` task while an earlier task is not
   `done`).

The one-shot equivalent is `pnpm run check` (typecheck + ESLint + Prettier) plus
the Rust commands above; `node scripts/harness.mjs` runs everything.

Packaging or dependency changes additionally require:

10. `task packages` — builds `.deb`, `.rpm` and the AppImage.
11. `dpkg-deb -I dist-packages/*.deb` and `rpm -qpR dist-packages/*.rpm` —
    dependency metadata sane.
12. `ldd` on the sidecar inside the package — no `not found`, no `libstdc++`.

Windows changes are validated by the `windows` job in
`.github/workflows/ci.yml` (there is no Windows host in local development):

13. `pwsh scripts/fetch-windows-libs.ps1` succeeds and creates the five DLLs
    plus `indigo.lib` / `indigo-renderer.lib`.
14. `node scripts/harness.mjs` passes on Windows (ShellCheck is skipped: the
    scripts are POSIX-only).
15. Sidecar smoke test: `/v2/info` reports `"imago_versions": []`,
    `/v2/health` reports `imago_worker.found = false`, and
    `POST /v2/imago/uploads` returns 404.
16. `pnpm tauri build --bundles nsis` produces
    `target/release/bundle/nsis/*.exe`, uploaded by CI.
17. `cargo check -p indigo-server --all-targets --target x86_64-pc-windows-msvc`
    catches `cfg(windows)` mistakes without linking the DLLs.

---

## 2. Manual verification steps

### Application startup

- `task run` opens the editor and the sidecar logs `indigo-server listening`.
- `curl -s http://127.0.0.1:9321/v2/info` answers 200.
- `curl -s http://127.0.0.1:9321/v2/health` reports `"status": "ok"`.
- Closing the window kills `indigo-server` (no orphan on the port).

### Logs

- `~/.local/share/dev.spalax.ChemistryDraw/logs/chemistry-draw.log` exists.
- It contains `[frontend] session start` and `[indigo-server]` lines.
- Panics include a file:line location.

### Chemistry behaviour

- Draw a molecule, run Layout and Clean: the structure stays valid.
- Save as PNG/SVG: the file is produced and non-empty.
- Recognize (Imago, Linux): upload → poll reaches `SUCCESS` or a clear error.
- Windows: Recognize Molecule is disabled and `/v2/imago/uploads` is absent.

### Packaging

- AppImage extracts to a minimal AppDir: only our libraries, no GTK/WebKit/
  Wayland.
- `.deb`/`.rpm` install into `/usr/bin` and `/usr/lib/chemistry-draw`.
- No `libstdc++`/`libgcc_s` inside any artifact.

---

## 3. Reviewer checklist

The reviewer agent must verify:

- [ ] Harness passes (`node scripts/harness.mjs` exits 0)
- [ ] TypeScript clean (`pnpm exec tsc --noEmit`)
- [ ] ESLint clean (`pnpm run lint`)
- [ ] Prettier clean (`pnpm run format:check`)
- [ ] Rust formatting clean (`cargo fmt --all --check`)
- [ ] Clippy clean (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Sidecar tests green (`cargo test -p indigo-server`)
- [ ] Activity tasks are phased docs → test → implement → review, in order, and
      `node --test scripts/lib/activity-policy.test.mjs` passes
- [ ] Sequential status: no task is `in_progress` or `done` while an earlier
      task is not `done`
- [ ] New behaviour has a test that would fail without the change
- [ ] `docs/architecture.md` / `docs/conventions.md` respected
- [ ] No debug prints, no vendored binaries, no context-less TODOs
- [ ] Docs updated when behaviour, routes, or commands changed
