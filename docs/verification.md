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
   and the info line names the missing piece otherwise. OCSR model-gated tests
   additionally need `models/ocsr-handdrawn-fp32/` (encoder, decoder step and
   vocabulary) and self-skip when those files are absent. The Recognize
   Molecule success/rejection tests use the same gate; the job store, upload
   protocol, 404 and missing-model tests always run.
9. Review `docs/CHECKPOINTS.md` — mark the applicable boxes.
10. `node --test scripts/lib/activity-policy.test.mjs` — policy tests green.
    The harness runs the same command in block 3 and then validates
    `activities.json` with `scripts/lib/activity-policy.mjs`, including
    sequential status (no `in_progress`/`done` task while an earlier task is not
    `done`).

The one-shot equivalent is `pnpm run check` (typecheck + ESLint + Prettier) plus
the Rust commands above; `node scripts/harness.mjs` runs everything. `pnpm test`
(Vitest) and harness block 8 that runs it must also be green; see
`docs/testing.md` §6.1.

Packaging or dependency changes additionally require:

11. `task packages` — builds `.deb`, `.rpm` and the AppImage.
12. `dpkg-deb -I dist-packages/*.deb` and `rpm -qpR dist-packages/*.rpm` —
    dependency metadata sane.
13. `ldd` on the sidecar inside the package — no `not found`, no `libstdc++`,
    and no `DT_NEEDED libonnxruntime` (the shipped runtime is loaded dynamically
    from the bundled lib directory, not linked).

Windows changes are validated by the `windows` job in
`.github/workflows/ci.yml` (there is no Windows host in local development):

14. `pwsh scripts/fetch-windows-libs.ps1` succeeds and creates the five Indigo
    DLLs plus `onnxruntime.dll` and `indigo.lib` / `indigo-renderer.lib`.
15. For model-gated tests, copy the fetched
    `src-tauri/lib/windows-x86_64/onnxruntime.dll` to `.ort/windows-x86_64/`
    (or set `ORT_DYLIB_PATH`); the harness skips them otherwise. The packaged
    app finds the bundled DLL through the host-added `PATH` entry or
    `ORT_DYLIB_PATH`.
16. `node scripts/harness.mjs` passes on Windows (ShellCheck is skipped: the
    scripts are POSIX-only).
17. Sidecar smoke test (Windows job only): the compatibility contract lives in
    `.github/actions/windows-build/action.yml` — `/v2/info` answers `200` and
    advertises the synthetic `imago_versions` capability (`local-ocsr`),
    `/v2/health` answers `200` with neither `imago_worker` nor
    `imago_versions`, `POST /v2/imago/uploads` with the `caffeine.png` fixture
    (`image/png`) returns `200` and a non-empty `upload_id` (not 404), an
    unknown id is `404`, and `GET /v2/imago/uploads/{id}` answers `200` with a
    `state` (polled for up to 10 s; `PENDING` is accepted because the runner
    carries no models). Linux covers the same contract through `cargo test`, in
    the module that replaces `tests/imago_absent.rs`.
18. `pnpm tauri build --bundles nsis` produces
    `target/release/bundle/nsis/*.exe`, uploaded by CI.
19. `cargo check -p indigo-server --all-targets --target x86_64-pc-windows-msvc`
    catches `cfg(windows)` mistakes without linking the DLLs.

---

## 2. Manual verification steps

### Application startup

- `task run` opens the editor and the sidecar logs `indigo-server listening`.
- `task run` logs `model root: /.../models` — an absolute path, not
  `model root: models` — and `POST /v2/filter/classify` answers without
  exporting `CHEMISTRY_MODELS_DIR`.
- `curl -s http://127.0.0.1:9321/v2/info` answers 200 and
  `jq .imago_versions` returns `["local-ocsr"]` — the synthetic capability
  list, not an Imago build.
- `curl -s http://127.0.0.1:9321/v2/health` reports `"status": "ok"` and has no
  `imago_worker` field.
- Closing the window kills `indigo-server` (no orphan on the port).

### Logs

- `~/.local/share/dev.spalax.ChemistryDraw/logs/chemistry-draw.log` exists.
- It contains `[frontend] session start` and `[indigo-server]` lines.
- Panics include a file:line location.

### Chemistry behaviour

- Draw a molecule, run Layout and Clean: the structure stays valid.
- Save as PNG/SVG: the file is produced and non-empty.
- Export a structure to PNG with the desktop build: the render succeeds, the
  image matches the previous output, and the log contains **no**
  `Fontconfig warning` lines.
- `ldd src-tauri/lib/linux-x86_64/libindigo-renderer.so` resolves
  `libfontconfig.so.1` from the host (e.g. `/lib64/` on Fedora,
  `/usr/lib/x86_64-linux-gnu/` on Debian), not from the bundled directory.
- Recognize Molecule is visible on every platform. With the models installed it
  inserts a structure end to end (see below); without them the control still
  opens and the job fails with the model-setup dialog.

### Image filter

Requires a local model (`models/manifest.json` plus
`models/image-classifier-fp16/classifier.fp16.onnx`) and a loadable ONNX Runtime.
The harness and the debug host set `ORT_DYLIB_PATH`; debug prefers
`.ort/<platform>/` (fetched by `scripts/fetch-onnxruntime.sh`) and falls back to
the bundled `lib/<platform>/`. See `docs/architecture.md` §7. Without either one
the sidecar still starts.

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
- `GET /v2/info` adds only the synthetic `imago_versions` capability list; the
  rest of the payload (`Indigo`, `indigo_version`, `api_path`) is unchanged and
  it carries no inference fields.

### OCSR recognition

Requires the OCSR model files `models/ocsr-handdrawn-fp32/encoder.onnx`,
`decoder_step.onnx` and `vocab.json` (plus `models/manifest.json` with the
`ocsr-handdrawn` entry) and a loadable ONNX Runtime. The pair is ~316 MB; it is
gitignored and never bundled.

- Model presence and integrity. The encoder and decoder hashes are pinned; the
  vocabulary hash is the one recorded in `manifest.json`:

  ```bash
  du -ch models/ocsr-handdrawn-fp32/*
  sha256sum models/ocsr-handdrawn-fp32/encoder.onnx \
            models/ocsr-handdrawn-fp32/decoder_step.onnx \
            models/ocsr-handdrawn-fp32/vocab.json
  jq -r '.models["ocsr-handdrawn"].vocab.artifact_sha256' models/manifest.json
  ```

  Expected encoder hash
  `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52`,
  decoder hash
  `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197`,
  and the vocabulary hash equal to the manifest value. A missing file or a
  mismatch makes `POST /v2/ocsr/recognize` answer `503`; it must not affect
  startup or the filter.

- `/v2/health` lists both ids when their files exist —
  `image-classifier@Iagea/d21f4cb` and `ocsr-handdrawn@zenodo:10781330` — and
  returns without opening an OCSR session (it stays fast; the ~316 MB pair is
  loaded on first recognition).

- Recognition (the first call pays the checksum and session load; later calls
  reuse the cached sessions):

  ```bash
  curl -s -X POST http://127.0.0.1:9321/v2/ocsr/recognize \
    -H "Content-Type: image/png" \
    --data-binary @src-tauri/sidecar/fixtures/caffeine.png | jq
  ```

  Expected `200` with all four fields: `smiles` equal to
  `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`, `confidence` around `0.9957` (in `0..=1`),
  `incomplete: false` and `model: "ocsr-handdrawn@zenodo:10781330"`.

- `400`: `Content-Type: text/plain`, undecodable bytes, or a central canvas over
  8,192 px per side (extreme aspect ratio); exactly 10,485,760 bytes must reach
  the decoder (`400`), one byte more returns `413` (plain text, not JSON). `503`:
  rename the OCSR directory or point `CHEMISTRY_MODELS_DIR` at a root without
  the `ocsr-handdrawn` entry — Indigo keeps working and the filter still
  answers.

- `422`: the decoder reached `max_len = 302` without `end_id`, so no SMILES is
  returned:

  ```json
  { "error": "could not finish the structure; try a sharper image" }
  ```

  Truncation depends on model output, so the deterministic coverage is the
  fake-decoder test; a fragmented or heavily degraded sketch is the manual
  reproduction. A truncated `smiles` must never appear in a `200`.

- `GET /v2/info` adds only the synthetic `imago_versions` capability described
  below: no OCSR or other inference fields, and the rest of its payload is
  unchanged.

### Recognize Molecule end to end

Requires both model sets (`models/manifest.json`, the classifier file and the
three OCSR artifacts) and a loadable ONNX Runtime. Without them the control is
still visible and the job fails with the setup dialog; that path is checked
below.

- The toolbar shows **Recognize Molecule** and opens Ketcher's "Import
  Structure from Image" dialog. The dialog does **not** show an "Imago version"
  selector: `src/overrides.css` hides Ketcher's label because the local OCSR
  model has no version choice. The capability list still enables the control,
  and the optional version query remains accepted and ignored.
- Choose `src-tauri/sidecar/fixtures/caffeine.png` and confirm the preview. The
  dialog uploads, waits 300 ms and then polls every 500 ms until the job leaves
  `PENDING`; once it is `SUCCESS`, the dialog offers **Add to Canvas**. The
  structure appears with 2D coordinates; the job's
  `mol_str` is a V2000 molfile whose molecule matches the fixture's known
  SMILES `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`.
- Click **Change image** and choose a second, different structure image (for
  example `aspirin.png` from a manual run). The original image and filename
  update and the "Recognized structure preview" replaces the first structure;
  an older in-flight recognition must never overwrite or clear the new preview.
- Repeat with `chinese_character.jpg` or `random_scatter_plot_64933.png`: the
  job ends `FAILURE` with `No molecule was detected in this image.` and the
  failure renders in the **in-app** `ErrorDialog`, not a native OS alert. The
  dialog sits inside the webview above the editor with Ketcher's dimmed hatch
  backdrop (the same overlay as Export and the close guard), the title
  **Structure problem**, the copy "No chemical structure was detected in this
  image. Try a clear image of one drawn molecule, or draw the structure in the
  editor." and a single **Close** button that returns to Ketcher's dialog. No
  raw JSON is shown and no separate OS window appears: check the window
  list/taskbar for a GTK/Win32 alert — there must be none, and `alert()` is
  never used. This is the known multi-molecule limitation: a `no-structure`
  answer is not proof that no structure exists.
- The same in-app surface is expected for the other recognition failures:
  low confidence (title `Structure problem`, "The structure could not be read
  confidently…"), models missing ("Molecule recognition is not set up…"),
  conversion, timeout and the plain-text `413` ("The server could not process
  the image. It may be too large."). In every case the title is **Structure
  problem**, the friendly copy replaces the raw message and no native alert
  appears. When a Playwright runner drives `pnpm dev`, the same check is a DOM
  assertion — a `[role="dialog"]` element titled `Structure problem` — plus
  `page.on("dialog")` recording no browser `alert()`; a native Tauri
  `message()` is an OS window outside the webview and satisfies neither.
- Low confidence / incomplete: there is no deterministic fixture; a fragmented
  or heavily degraded sketch is the manual reproduction. The deterministic
  coverage is the gate test with a fake prediction. The dialog must say the
  structure could not be read confidently and must not show a partial
  structure.
- Models missing: rename `models/` (or point `CHEMISTRY_MODELS_DIR` at an empty
  directory) and retry. The job ends `FAILURE` with the model-unavailable
  message; the dialog says the models are not available, `/v2/health` lists no
  model and Indigo keeps working.
- Unsupported format: choose a GIF or rename `caffeine.png` to `.gif`. The POST
  is `400` and the dialog says the image is unsupported. The `.webp` fixture is
  accepted.
- A body over 10 MiB returns `413` with axum's plain-text body, not JSON.
  Ketcher's `response.json()` throws a parse error, which the UI maps to "The
  server could not process the image. It may be too large."; exactly 10,485,760
  bytes is accepted by `POST` and fails later in the worker if it does not
  decode.

Curl job protocol:

```bash
BASE=http://127.0.0.1:9321
IMG=src-tauri/sidecar/fixtures/caffeine.png

# 1. Upload. The version query is accepted and ignored.
UPLOAD=$(curl -s -X POST "$BASE/v2/imago/uploads?version=local-ocsr" \
  -H "Content-Type: image/png" --data-binary @"$IMG")
echo "$UPLOAD" | jq -e '.upload_id' >/dev/null
ID=$(echo "$UPLOAD" | jq -r '.upload_id')

# 2. Wait 300 ms, then poll every 500 ms until the job leaves PENDING.
#    The loop bound belongs to this script, not to Ketcher.
sleep 0.3
for _ in $(seq 1 300); do
  JOB=$(curl -s "$BASE/v2/imago/uploads/$ID")
  STATE=$(echo "$JOB" | jq -r '.state')
  [ "$STATE" = "PENDING" ] || break
  sleep 0.5
done
echo "$JOB" | jq

# 3. Expected: SUCCESS and a V2000 molfile.
echo "$JOB" | jq -e '.state == "SUCCESS"'
echo "$JOB" | jq -r '.metadata.mol_str' | grep -q 'V2000'
```

The same sequence with a non-structure fixture ends with:

```json
{
  "state": "FAILURE",
  "error": "No molecule was detected in this image."
}
```

A `FAILURE` is always `HTTP 200` with `state: "FAILURE"`; only an unknown,
expired or restarted id is `404`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "$BASE/v2/imago/uploads/00000000-0000-0000-0000-000000000000"   # 404
```

`POST` with `Content-Type: text/plain` is `400`; a body over 10 MiB is `413`
with a plain-text body. A pipeline still running after the sidecar's 120 s
worker bound is abandoned as the timeout `FAILURE`. A job that stays `PENDING`
for 10 minutes (a lost worker) also becomes the timeout `FAILURE` on its next
poll, and a resolved job is pruned 10 minutes after it resolved. The worker and
store tests cover both boundaries without waiting.

### Ketcher render robustness

Run against the desktop build (`task run`) with the developer console open.

1. **Reproduce the desync.** Draw a small structure, then create an
   invalid-valence edit and/or edit a bond and undo the deletion so a bond keeps
   a stale half-bond reference. A structure whose bond references a half-bond
   missing from the struct is the condition under test; `Ctrl+Z` after deleting
   a bond is the shortest reproduction.
2. **Hover and select bonds.** Hover over the affected bond and select it (click
   or rubber-band selection). The console must not flood with
   `halfBonds.get(...)` / `undefined is not an object (restruct.molecule.halfBonds.get(bond.hb1).p)`
   errors, and the render loop must keep running. The bond may simply show no
   hover or selection highlight; that graceful degradation is the expected
   result, not a failure.
3. **No regression.** Hover and select a normal, valid bond: the hover plate and
   selection plate draw as before.

### Documents, autosave and recovery

Run against the desktop build (`task run`), not the browser, except where the
fallback is stated. `<appDataDir>` is `~/.local/share/dev.spalax.ChemistryDraw`
on Linux and `%APPDATA%\dev.spalax.ChemistryDraw` on Windows.

1. **Save an unsaved document.** Draw a structure, press `Ctrl+S`. A Save As
   dialog appears with `untitled.ket`. Choose a directory: the file exists,
   contains `.ket` JSON, the title shows the file name without `*`, and the
   snapshot under `<appDataDir>/recovery/` is gone.
2. **Save again.** Edit the structure and press `Ctrl+S`: no dialog appears,
   the same file is overwritten (mtime changes) and the title loses `*`.
3. **Save As.** Edit, run Save As to a second path: the title changes, the new
   file has the edits and the first file is unchanged.
4. **Export.** Export each of Molfile V2000/V3000, SMILES, InChI, SVG and PNG.
   Every file is non-empty and opens in an independent viewer; the window title
   and `path` do not change, and a following `Ctrl+S` still writes the `.ket`
   file, not the export.
5. **Crash simulation.** Draw or edit, wait at least 2 s, then kill the process
   while it is dirty (e.g. `kill -9 <pid>`). `<appDataDir>/recovery/` contains
   `autosave.ket` plus `autosave.json` with the original `path`, a timestamp
   and `dirty: true`.
6. **Recovery prompt.** Relaunch: an in-app Restore/Discard dialog appears (not
   a native GTK/Win32 dialog). Restore reloads the structure, re-attaches the
   original path when it was saved before, and shows `*`. Save, then confirm
   the `.ket` file on disk contains the recovered edits.
7. **Discard.** Repeat 5, choose Discard: the editor is empty and the snapshot
   is deleted. Relaunch again: no prompt.
8. **Clean close.** With a saved document, close the window: it closes with no
   dialog and no snapshot is left behind.
9. **Close guard.** With unsaved changes, close the window: the in-app
   Save/Discard/Cancel dialog appears.
   - Cancel: the window stays open and the structure is intact.
   - Save: the document is written before the window closes.
   - Discard: the window closes without writing and without leaving a snapshot.
   - Cancel the Save As dialog during Save: the window stays open.
10. **New and Open.** New empties the editor, clears `path`, the title shows
    `Untitled` and any snapshot is gone. Open a `.ket`: the path and title
    follow it and the document is clean. Open a `.mol`/`.smi`: it imports
    through Ketcher, the title is `Untitled` and the document is dirty. Repeat
    both with unsaved changes: an in-app Save/Discard/Cancel prompt appears
    first; Cancel leaves the document untouched, Discard replaces it, and Save
    writes before replacing it (a cancelled Save As aborts the command).
11. **Browser fallback.** `pnpm dev` in a normal browser: Save and Export
    download files (no dialog, no path), there is no autosave, no recovery
    prompt and no close guard, and the console stays free of errors.
12. **Autosave scope.** Draw or edit a structure and let the debounce fire
    (about 2 s). `<appDataDir>/recovery/` contains `autosave.ket` and
    `autosave.json`, and the log has no `forbidden path` WARN naming
    `recovery` or `allow-mkdir`.
13. **Restored document scope.** Repeat step 5 with a document that has a saved
    `path`, relaunch and choose Restore. Press `Ctrl+S` without opening a
    dialog: the restored document is written to its original path, the title
    loses `*`, and the log has no `forbidden path` WARN for that path. With the
    original file deleted, Restore keeps the path and the first Save recreates
    the file.

### In-app dialog styling

Run against the desktop build (`task run`).

1. **Export dialog.** Draw a structure and click Export: the format dialog opens
   and the editor behind it is only lightly dimmed (~20 % grey, still clearly
   readable), not heavily darkened. Faint diagonal lines are visible across the
   dimmed editor — the overlay is a 10×10 repeating hatch, not a flat wash. A
   flat, hatch-free wash is the bug, not a styling choice. The overlay fades in
   smoothly over about 0.3 s instead of snapping, and the hatch pattern neither
   shimmers nor scales while the backdrop fades.
2. **Close guard.** With unsaved changes, close the window: the close-guard
   dialog opens with the same light dimming, the same faint diagonal hatch
   behind it and the same smooth fade.
3. **Panel shape.** Both dialogs show white panels with `8px` rounded corners,
   no border and no drop shadow. Comparing Export and the close guard side by
   side, they look identical; only their text and buttons differ.
4. **Native parity.** Compare against Ketcher's own modal styling (overlay
   `rgba(94,94,94,.2)` with its `10px 10px` diagonal hatch and a borderless,
   shadowless white panel with `8px` corners): the overlay tint, the hatch, its
   `0.3s` fade and the panel frame match.
5. **Every dialog, both zooms.** Repeat step 1 for every in-app dialog (Export,
   close guard, recovery prompt, error dialog): the faint diagonals are visible
   behind each of them at 100 % **and** 125 % zoom. Diagonals missing behind any
   one dialog, or only at one zoom, fail this check — the effective
   `background-image` must be the token wrapped in `url("…")`, and good parity
   stops there: the panel has no transform/opacity entrance animation and ours
   is fixed above the whole app rather than scoped to the editor.

### Toolbar integration

Run against the desktop build (`task run`) unless a step says browser.

1. **Toolbar only.** The editor shows no control group in the bottom-left
   corner and no app-drawn toolbar anywhere. Ketcher's top toolbar carries Open
   plus exactly three extra buttons: Save, New and Export. There is no
   **Save As…** entry.
2. **Icon styling.** Save, New and Export match the neighbours' metrics and
   inherit their colour; the app never paints a fixed icon colour.
   - **Default:** each glyph is the same grey as Ketcher's own icons
     (`#333333`), with no lighter, darker or thicker icon among the buttons.
   - **Hover:** hovering a button turns its glyph Ketcher's teal (`#167782`)
     together with the button; moving away restores the grey.
   - **Active:** pressing a button shows the same active-state colour as a
     native icon pressed at the same time.
   - **Size:** at 100 % the buttons and glyphs match the native 28/32/40 px
     controls and fill their box without clipping; at 125 % zoom they scale with
     the toolbar and stay sharp.
   - **Optical size:** each glyph's ink spans the same ~15x15 live area as the
     neighbouring native icons and carries the same 1.5-unit outline weight, so
     the optical size matches the neighbouring native icons (no heavier, no
     filled glyph, none edge to edge).
   - **Titles:** the tooltips are still `Save`, `New` and `Export`, and the Save
     glyph is visually distinct from a floppy disk glyph.
3. **Save.** Draw a structure, click Save with an untitled document: the Tauri
   Save As dialog appears with `untitled.ket`; choose a path and confirm the
   file is `.ket` JSON and the title loses `*`. Edit and click Save again: no
   dialog, the same file is overwritten.
4. **New.** With unsaved changes, click New: the in-app Save/Discard/Cancel
   dialog appears and the recovery snapshot under `<appDataDir>/recovery/` is
   removed after the command. Cancel leaves the structure intact; Discard
   empties the editor; Save writes before replacing.
5. **Export.** Click Export: the existing in-app format dialog opens and lists
   Molfile V2000, Molfile V3000, SMILES, InChI, SVG and PNG. Export any of
   them; the document title and its `.ket` path are unchanged and a following
   Save still writes the `.ket` file.
6. **Shortcuts.** `Ctrl+S` saves, `Ctrl+Shift+S` opens Save As, `Ctrl+O` opens a
   file and `Ctrl+N` starts a new document. `Ctrl+S` does **not** open
   Ketcher's native Save As dialog.
7. **No native Save As.** Ketcher's top toolbar has no **Save As…** entry, and
   no shortcut opens its Molfile save dialog. The entry is hidden through
   `buttons.save.hidden`; there is no CSS `display: none` and no DOM query in
   the app.
8. **No native save dialog.** Neither the toolbar nor any shortcut opens
   Ketcher's Save As dialog, so its built-in image-save entry is unreachable.
   Use the app **Export** once for SVG and once for PNG: each opens the Tauri
   save dialog, writes the file to disk and triggers no browser download.
9. **Browser fallback.** `pnpm dev` in a normal browser: Save and Export
   download files, no dialog opens, `path` stays `null`, and the console stays
   free of errors.

### Packaging

- AppImage extracts to a minimal AppDir: only our libraries, no GTK/WebKit/
  Wayland.
- `.deb`/`.rpm` install into `/usr/bin` and `/usr/lib/chemistry-draw`.
- No `libstdc++`/`libgcc_s` inside any artifact.
- No bundled `libfontconfig*`, `libfreetype*`, `libexpat*`, `libpng*` or
  `libbrotli*` inside any artifact: the distribution provides them.
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

- The packaged sidecar answers `GET /v2/info` with the synthetic
  `imago_versions: ["local-ocsr"]` capability and `GET /v2/health` without
  `imago_worker`. `POST /v2/imago/uploads` is registered and returns an
  `upload_id`; with no models in the payload the job ends `FAILURE` (model
  unavailable), never 404. The payload still contains no `imago-worker`,
  `libimago.so` or OpenCV (absence grep above).

#### ONNX Runtime payload

Each Linux artifact must carry the shipped runtime exactly once — one real
`libonnxruntime.so.1.31.0` (29,345,384 B) and the two symlinks
`libonnxruntime.so -> libonnxruntime.so.1 -> libonnxruntime.so.1.31.0` — and no
model weights. Three copies of the 29 MB file in one payload is a symlink-loss
regression.

```bash
# Three entries per payload, one regular file and two symlinks.
ar p "$DEB" data.tar.gz | tar -tvz | grep 'libonnxruntime\.so'
rpm2cpio "$RPM" | cpio -tv 2>/dev/null | grep 'libonnxruntime\.so'
find squashfs-root -name 'libonnxruntime.so*' -printf '%y %p -> %l\n'

# No model weights: each command must print nothing.
ar p "$DEB" data.tar.gz | tar -tz | grep -Ei '\.onnx$|/models/'
rpm -qlp "$RPM" | grep -Ei '\.onnx$|/models/'
find squashfs-root \( -iname '*.onnx' -o -ipath '*/models/*' \)
```

`scripts/check-native-libs.sh --allowlist /opt/chemistry/libs
/opt/chemistry/libs <bundled-lib-dir>` passes right after the builder copy (no
output, exit 0); a stale builder image fails there before bundling. `ldd` and
`readelf -d` on the packaged sidecar show no ONNX Runtime:

```bash
export LD_LIBRARY_PATH=$PWD/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64
ldd squashfs-root/usr/bin/indigo-server | grep -c libonnxruntime      # 0
readelf -d squashfs-root/usr/bin/indigo-server | grep -i onnxruntime  # nothing
```

Packaged-sidecar smoke, run from the repository root so the fixture and models
resolve. No `ORT_DYLIB_PATH`: this proves the bundled library itself loads from
the packaged directory through `LD_LIBRARY_PATH` (the release host points
`ORT_DYLIB_PATH` at the same directory).

```bash
LD_LIBRARY_PATH=$PWD/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64 \
  CHEMISTRY_MODELS_DIR=$PWD/models \
  ./squashfs-root/usr/bin/indigo-server &
curl -s -o /tmp/classify.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:9321/v2/filter/classify \
  -H "Content-Type: image/png" \
  --data-binary @src-tauri/sidecar/fixtures/caffeine.png
jq '.category, .model' /tmp/classify.json
kill %1
```

Expected: HTTP `200`, category `"structure"`, model
`"image-classifier@Iagea/d21f4cb"`. A `503` here means the payload lost the
runtime or the host did not point at it.

Windows: the NSIS payload contains `onnxruntime.dll` under
`lib/windows-x86_64/`; the host prepends that directory to `PATH` and sets
`ORT_DYLIB_PATH`, so the packaged classifier answers `200` when the models are
present.

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
- [ ] No ONNX model file is committed or bundled; the shipped
      `libonnxruntime` 1.31.0 comes only from the builder image / Windows fetch
      script (never git), each artifact carries one real file plus its symlink
      chain, and the sidecar has no `DT_NEEDED libonnxruntime` and no
      `OrtGetApiBase` symbol (dynamic load through `ORT_DYLIB_PATH`)
- [ ] `/v2/imago/uploads` is the compatibility shim (POST returns `upload_id`,
      GET reports PENDING/SUCCESS/FAILURE, unknown id 404, TTL expiry covered),
      and no Imago worker, library or native binary is shipped
- [ ] Recognize Molecule is visible, a model-gated image inserts a V2000
      structure, and no-molecule/low-confidence/unsupported/model-unavailable
      failures show friendly dialogs rather than raw JSON
- [ ] `scripts/fetch-onnxruntime.sh` is executable, checksummed and
      ShellCheck-clean
- [ ] Save/Save As write `.ket` only; Export never changes path or format
- [ ] Document commands are Ketcher `customButtons` (no app-owned toolbar or
      dock), the native Save As entry is hidden through `buttons.save.hidden`,
      remaining library saves write through Tauri, and the `file-saver` alias is
      the only third-party override
- [ ] Ketcher's built-in Recognize entry is not hidden and the Imago version
      selector is hidden by `src/overrides.css`
- [ ] New dialogs are in-app components with Ketcher tokens, `role="dialog"`,
      `aria-modal`, focus trap and Escape handling — no new Tauri native dialog
- [ ] Vitest (`pnpm test`) and the harness block that runs it are green
- [ ] `docs/architecture.md` / `docs/conventions.md` respected
- [ ] No debug prints, no vendored binaries, no context-less TODOs
- [ ] Docs updated when behaviour, routes, or commands changed
