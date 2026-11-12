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
8. Model-gated tests (`--include-ignored`) need `models/manifest.json` **and** a
   loadable ONNX Runtime. Run `scripts/fetch-onnxruntime.sh` once; the harness
   sets `ORT_DYLIB_PATH` and `CHEMISTRY_MODELS_DIR`, and skips both gated tests
   and the info line names the missing piece otherwise.
9. Review `docs/CHECKPOINTS.md` — mark the applicable boxes.
10. `node --test scripts/lib/activity-policy.test.mjs` — policy tests green.
    The harness runs the same command in block 3 and then validates
    `activities.json` with `scripts/lib/activity-policy.mjs`, including
    sequential status (no `in_progress`/`done` task while an earlier task is not
    `done`).

The one-shot equivalent is `pnpm run check` (typecheck + ESLint + Prettier) plus
the Rust commands above; `node scripts/harness.mjs` runs everything.

Packaging or dependency changes additionally require:

11. `task packages` — builds `.deb`, `.rpm` and the AppImage.
12. `dpkg-deb -I dist-packages/*.deb` and `rpm -qpR dist-packages/*.rpm` —
    dependency metadata sane.
13. `ldd` on the sidecar inside the package — no `not found`, no `libstdc++`,
    and **no `libonnxruntime`** (B1 loads it dynamically and never bundles it).

Windows changes are validated by the `windows` job in
`.github/workflows/ci.yml` (there is no Windows host in local development):

14. `pwsh scripts/fetch-windows-libs.ps1` succeeds and creates the five DLLs
    plus `indigo.lib` / `indigo-renderer.lib`.
15. Place the pinned `onnxruntime.dll` under `.ort/windows-x86_64/` (or set
    `ORT_DYLIB_PATH`) if model-gated tests should run; the harness skips them
    otherwise.
16. `node scripts/harness.mjs` passes on Windows (ShellCheck is skipped: the
    scripts are POSIX-only).
17. Sidecar smoke test (Windows job only): the absence contract lives in
    `.github/actions/windows-build/action.yml` — `/v2/info` and `/v2/health`
    contain no `imago_versions` / `imago_worker` fields, and
    `POST /v2/imago/uploads` returns 404. Linux covers the same contract through
    `cargo test` (`tests/imago_absent.rs`).
18. `pnpm tauri build --bundles nsis` produces
    `target/release/bundle/nsis/*.exe`, uploaded by CI.
19. `cargo check -p indigo-server --all-targets --target x86_64-pc-windows-msvc`
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
- Recognize Molecule is hidden on all platforms: B1 exposes only the classifier
  endpoint, and the editor UI stays off until B2 wires the OCSR pipeline.

### Image filter

Requires a local model (`models/manifest.json` plus
`models/image-classifier-fp16/classifier.fp16.onnx`) and a loadable ONNX Runtime
(`scripts/fetch-onnxruntime.sh`; `ORT_DYLIB_PATH` is set by the harness and the
debug host). See `docs/architecture.md` §6. Without either one the sidecar still
starts.

- `/v2/health` reports `onnxruntime_version` and lists
  `image-classifier@Iagea/d21f4cb` in `models`.
- A structure image classifies as `structure`:

  ```bash
  curl -s -X POST http://127.0.0.1:9321/v2/filter/classify \
    -H "Content-Type: image/png" \
    --data-binary @src-tauri/sidecar/fixtures/caffeine.png | jq
  ```

  Expected: `contains_molecule: true`, `category: "structure"`, a `score` at or
  below `threshold` (`0.000089`), and
  `model: "image-classifier@Iagea/d21f4cb"`.

- A non-structure image (scatter plot or Chinese character) returns
  `contains_molecule: false`, `category: "no-structure"` and a `score` above the
  threshold.
- The WebP fixture (`caffeine.webp`, `Content-Type: image/webp`) returns
  `structure`.
- A body over 10 MiB returns `413` (plain text, not `{ "error": ... }`); exactly
  10,485,760 bytes reaches the decoder and returns `400`; an undecodable body
  returns `400`.
- With `CHEMISTRY_MODELS_DIR` pointing at an empty directory (or after renaming
  `models/`), the app still starts and Indigo operations work, `/v2/health`
  reports no loaded model, and `POST /v2/filter/classify` answers `503` with an
  actionable `error` message naming the manifest path and
  `CHEMISTRY_MODELS_DIR`.
- With `ORT_DYLIB_PATH` pointing at a missing file, the first classifier request
  answers `503` (not a panic, not `500`) and the message names the path and
  `scripts/fetch-onnxruntime.sh`.
- `GET /v2/info` is unchanged: no inference fields.

### Packaging

- AppImage extracts to a minimal AppDir: only our libraries, no GTK/WebKit/
  Wayland.
- `.deb`/`.rpm` install into `/usr/bin` and `/usr/lib/chemistry-draw`.
- No `libstdc++`/`libgcc_s` inside any artifact.
- Artifact payload inspection shows no `imago-worker`, `libimago.so` or
  `libopencv*`. `dist-packages/` may hold older generations, so target the
  version under test with explicit paths (never a glob over two generations).
  Each absence command must print nothing, and each non-vacuity check must
  succeed — otherwise the inspection proves nothing:

  ```bash
  V=0.1.6
  DEB=dist-packages/chemistry-draw_${V}_amd64.deb
  RPM=dist-packages/chemistry-draw-${V}-1.x86_64.rpm
  APPIMAGE=dist-packages/chemistry-draw_${V}_amd64.AppImage

  # Non-vacuity: the payload really contains the sidecar.
  ar p "$DEB" data.tar.gz | tar -tz | grep usr/bin/indigo-server >/dev/null
  rpm -qlp "$RPM" | grep usr/bin/indigo-server >/dev/null
  "$APPIMAGE" --appimage-extract >/dev/null
  test -x squashfs-root/usr/bin/indigo-server

  # Absence: each command must print nothing.
  ar p "$DEB" data.tar.gz | tar -tz | grep -Ei 'imago|opencv'
  rpm -qlp "$RPM" | grep -Ei 'imago|opencv'
  find squashfs-root \( -iname '*imago*' -o -iname '*opencv*' \)
  ```

- The packaged sidecar answers `GET /v2/info` without an `imago_versions` field
  and `POST /v2/imago/uploads` returns 404.

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
- [ ] When `models/` exists, model-gated tests pass with `--include-ignored`
- [ ] No ONNX model or `libonnxruntime` file is committed or bundled; the
      sidecar has no `DT_NEEDED libonnxruntime` and no `OrtGetApiBase` symbol
      (it loads the runtime dynamically through `ORT_DYLIB_PATH`)
- [ ] `scripts/fetch-onnxruntime.sh` is executable, checksummed and
      ShellCheck-clean
- [ ] `docs/architecture.md` / `docs/conventions.md` respected
- [ ] No debug prints, no vendored binaries, no context-less TODOs
- [ ] Docs updated when behaviour, routes, or commands changed
