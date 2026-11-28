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
10. Activity lifecycle, claims and `touches`: see
    `docs/harness/verification.md`. The v1 `activity-policy` scripts and the
    `phase`/`reviewer` task model no longer exist.

The one-shot equivalent is `pnpm run check` (typecheck + ESLint + Prettier) plus
the Rust commands above; `node scripts/harness.mjs` runs everything. `pnpm test`
(Vitest) and harness block 8 that runs it must also be green; see
`docs/testing.md` §6.1.

Packaging or dependency changes additionally require:

11. `task packages` — builds `.deb`, `.rpm` and the AppImage.
12. `dpkg-deb -I build/packages/*.deb` and `rpm -qpR build/packages/*.rpm` —
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
    `.github/actions/windows-build/action.yml` — `/v2/info` answers `200` and,
    because the runner carries no models, advertises `imago_versions: []`;
    `/v2/health` answers `200` with neither `imago_worker` nor
    `imago_versions`, `POST /v2/imago/uploads` with the `caffeine.png` fixture
    (`image/png`) returns `200` and a non-empty `upload_id` (not 404), an
    unknown id is `404`, and `GET /v2/imago/uploads/{id}` answers `200` with a
    `state` (polled for up to 10 s; `PENDING` is accepted because the runner
    carries no models). A temp-root test covers the installed case
    (`["local-ocsr"]`). Linux covers the same contract through `cargo test`, in
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
  `jq .imago_versions` returns `["local-ocsr"]` when the models are installed
  (and `[]` on a clean install) — the synthetic capability list, not an Imago
  build. On a clean install the **Models** setup dialog opens automatically at
  startup (see "Model setup UI (B3)" below) and Recognize stays disabled until
  the download completes.
- `curl -s http://127.0.0.1:9321/v2/health` reports `"status": "ok"` and has no
  `imago_worker` field.
- Closing the window kills `indigo-server` (no orphan on the port).

### Model delivery (B3)

The release model root is the Tauri app data directory:

| Platform | Model root                                                                    |
| -------- | ----------------------------------------------------------------------------- |
| Linux    | `~/.local/share/dev.spalax.ChemistryDraw/models` (`$XDG_DATA_HOME` respected) |
| Windows  | `%APPDATA%\dev.spalax.ChemistryDraw\models`                                   |

`CHEMISTRY_MODELS_DIR` overrides it and the host logs `model root = ...` at
startup. The release host creates the app-data model root before spawning the
sidecar; a debug run without an explicit value uses `<repo>/models`, which the
downloader creates on demand.

- **Clean-root status.** Point a debug run at a fresh directory:

  ```bash
  CLEAN=$(mktemp -d)
  CHEMISTRY_MODELS_DIR=$CLEAN task run
  ```

  `GET /v2/models` answers `200` with `ready: false`,
  `manifest_present: false`, `total_bytes: 323987190`, both models
  `installed: false` with their `missing` lists and `download.state: "idle"`.
  `/v2/info` answers `imago_versions: []`, so Recognize is disabled, while
  Indigo operations still work.

  ```bash
  BASE=http://127.0.0.1:9321
  curl -s "$BASE/v2/models" | jq
  curl -s "$BASE/v2/info" | jq .imago_versions   # []
  ```

- **Download.** `POST /v2/models/download` returns `202` and starts; poll
  `GET /v2/models` until the state leaves `downloading`:

  ```bash
  curl -s -X POST "$BASE/v2/models/download" | jq '.download.state'
  while :; do
    S=$(curl -s "$BASE/v2/models")
    echo "$S" | jq -r '"\(.download.state) \(.download.downloaded_bytes)/\(.download.total_bytes) \(.download.current_file // "")"'
    [ "$(echo "$S" | jq -r '.download.state')" = "downloading" ] || break
    sleep 1
  done
  echo "$S" | jq '{ready, installed_bytes, total_bytes, download}'
  ```

  Expected: `ready: true`, `installed_bytes == total_bytes == 323987190`,
  `download.state: "ready"`, and `/v2/info` now returns
  `["local-ocsr"]`. The generated `$CLEAN/manifest.json` is schema 1 with
  `catalog_version` and both models. The sidecar log names each artifact and
  its checksum result; no `.part` file remains.

- **Cancel and resume.** Start a download into a fresh root, wait until
  `downloaded_bytes` grows, then cancel:

  ```bash
  curl -s -X POST "$BASE/v2/models/download/cancel" | jq '.download.state'  # downloading (cooperative)
  find "$CLEAN" -name '*.part' -ls        # the partial file is kept
  # The cancel response is immediate and still says "downloading"; polling
  # reports the transition once the worker observes the flag between chunks.
  curl -s "$BASE/v2/models" | jq '.download.state'                          # cancelled
  curl -s "$BASE/v2/models" | jq '.download.downloaded_bytes'
  curl -s -X POST "$BASE/v2/models/download" | jq '.download.state'         # downloading
  ```

  The second run resumes with `Range: bytes=<kept>-` (the suite's test server
  asserts the header; the sidecar itself does not log request headers) instead
  of restarting, and the final bytes match the catalog. Cancel
  without a running download is `409`; a second download while one is running
  is `409`.

- **Verify and repair.** After a complete download:

  ```bash
  curl -s -X POST "$BASE/v2/models/verify" | jq '{ok, repair}'
  # { "ok": true, "repair": null }
  ```

  Corrupt an artifact in a **temp** root (never the installed root), start the
  sidecar against that root, and run verify: expected `ok: false`, the artifact
  `status: "corrupt"` with expected/actual hashes and
  `repair: "POST /v2/models/download"`. A following download replaces the
  corrupt artifact and rewrites the manifest even when the installed manifest is
  valid: the explicit POST re-hashes the installed files and answers `200` only
  when every size and SHA-256 matches. `POST /v2/models/verify` during a
  download is `409`.

- **Real-network smoke (manual, not CI).** In a temp root with the default
  catalog:

  ```bash
  SMOKE=$(mktemp -d)
  # Start the sidecar with CHEMISTRY_MODELS_DIR=$SMOKE and the default catalog,
  # POST /v2/models/download, poll to ready, then:
  du -cb "$SMOKE"/image-classifier-fp16/* "$SMOKE"/ocsr-handdrawn-fp32/* | tail -1
  # 323987190
  sha256sum "$SMOKE"/image-classifier-fp16/classifier.fp16.onnx \
            "$SMOKE"/ocsr-handdrawn-fp32/encoder.onnx \
            "$SMOKE"/ocsr-handdrawn-fp32/decoder_step.onnx \
            "$SMOKE"/ocsr-handdrawn-fp32/vocab.json
  jq '.catalog_version, (.models | keys)' "$SMOKE/manifest.json"
  ```

  Expected: the four pinned hashes from `docs/architecture.md` §7, total
  `323987190` B, `catalog_version: 1` and both model keys. Then run the package
  absence greps in "Packaging" below: no `.onnx`, `manifest.json` or `models/`
  path is shipped. Remove the temp root when done.

### Model setup UI (B3)

Run against the desktop build (`task run`) with a temp model root so the
installed models are never touched:

```bash
CLEAN=$(mktemp -d)
CHEMISTRY_MODELS_DIR=$CLEAN task run
```

1. **Auto-open on a clean root.** The **Models** setup dialog opens once after
   the editor paints, and the **Models** control is present in the toolbar. The
   dialog lists both families (`Image classifier`, 8,162,917 B;
   `Structure recognition`, 315,824,273 B), the 323,987,190 B (309.0 MiB)
   total and the state `Not installed`; it has no **Licenses and source**
   block, no Hugging Face URL and no repeated license paragraph (attribution
   stays in `NOTICE` and the docs). **No download has started**:
   `GET /v2/models` reports `download.state: "idle"` and the log shows no
   artifact request. The built-in **Recognize** control is disabled
   (`/v2/info` advertises `[]`).
2. **Later.** Click **Later** (and repeat after reopening with Escape): the
   dialog closes, no download starts, the app draws and runs Indigo operations,
   and the **Models** control (still visible because the install is not ready)
   reopens the same state. The dialog must not reopen by itself in the same
   session.
3. **Download, progress and ready.** Draw a small structure first. Click
   **Download**: the dialog is the only surface that changes — the editor stays
   mounted behind it. The progress section shows the state, bytes of the total,
   an integer percent and the current artifact path; the button row is
   **Cancel** + **Later** while downloading, then only **Later** while
   verifying. At the end the status is ready, installed bytes equal
   `323987190` and `$CLEAN/manifest.json` exists. The **Models** control
   disappears from the toolbar as soon as the ready status is observed (ready,
   no update, no verify repair); the open dialog is not force-closed and stays
   until **Later**. **Recognize is enabled without a restart**: the canvas is
   not reloaded, the structure drawn in step 2 is still there, and `Ctrl+Z`
   still undoes into the pre-download history (the editor was not remounted;
   Ketcher's option store was updated in place). `jq .imago_versions` on
   `/v2/info` returns `["local-ocsr"]`.
4. **Ready hides the control.** The dialog still shows `Installed`, the
   installed bytes and a **Verify** action. Click **Later**: the toolbar no
   longer carries **Models**, which is the intended end state for a healthy
   install, and there is no toolbar path back to the dialog. No auto-open
   occurs on the next launch with this root.
5. **Cancel and resume.** Stop the app, point `CLEAN` at a fresh directory
   (`CLEAN=$(mktemp -d)`) and relaunch with
   `CHEMISTRY_MODELS_DIR=$CLEAN task run`. Wait until bytes grow, then
   **Cancel**. The dialog reports the cancelled state with **Resume** (no
   error), `find "$CLEAN" -name '*.part' -ls` shows the partial file and
   clicking **Resume** continues rather than restarting. The control stays
   visible while the install is not ready. Repeating Cancel while verifying is
   not offered (the backend answers `409`).
6. **Offline error stays in the dialog.** Use the support catalog override in a
   temp root with every URL pointed at a closed port (never in a release):

   ```bash
   CAT=$(mktemp --suffix=.json)
   sed 's#https://huggingface.co#http://127.0.0.1:9#g' \
     src-tauri/sidecar/src/service/ml/model-catalog.json > "$CAT"
   CHEMISTRY_MODELS_DIR=$(mktemp -d) CHEMISTRY_MODEL_CATALOG=$CAT task run
   ```

   The **Models** control is visible (the status is not ready). Click
   **Download**: after a failed preflight/fetch the dialog keeps the
   `role="alert"` error (it names the URL and asks to check the network) with
   **Retry** and **Later**. No OS alert or second window appears and no browser
   `alert()` fires. A full volume (a small tmpfs or quota-limited mount) shows
   the required/available byte message in the same place; the deterministic
   disk coverage is the backend test suite.

7. **Verify, repair and the returning control.** Keep the dialog open after the
   step 3 download instead of clicking **Later**, and overwrite one artifact
   with same-size garbage (for example the 5,316 B
   `ocsr-handdrawn-fp32/vocab.json`). Click **Verify**: the dialog reports the
   corrupt file, the primary action becomes **Repair** and the **Models**
   control reappears in the toolbar because the verify report is `ok: false`.
   Click **Later**, then reopen from **Models**: the dialog still shows
   **Repair** and the control is still visible; close it again and the control
   stays visible. Repair re-hashes, fetches only the bad artifact, rewrites the
   manifest and ends ready; **Verify** then reports all files match and the
   control disappears again. While that repair runs (`downloading`/`verifying`
   on a ready install) and if it is cancelled, the **Models** control stays
   visible with **Cancel**/**Resume**: only a healthy `idle`/`ready` install
   hides it. A recognition failure that reports the models unavailable forces
   the control visible until a Verify report with `ok: true` or a completed
   download-style run whose status is healthy; an accepted `202` is not proof,
   and the dialog shows a muted note asking for Verify while the override is
   armed. See "Recognize Molecule end
   to end". A healthy ready install has no toolbar path to Verify once the
   dialog is closed; the backend verify/repair semantics stay covered by the
   sidecar suite.
8. **Update label.** In the same temp root only, set `catalog_version` to `0` in
   `manifest.json` and restart with that root. The **Models** control is back in
   the toolbar because `update_available` is true; opening it shows that an
   update is available and the primary action is **Update**. Update re-verifies
   the installed files without refetching them and rewrites the manifest at
   version `1`; the control disappears again. A newer installed catalog is not
   offered an update.
9. **No native alerts anywhere.** Every setup error above stays in the dialog;
   an ad-hoc Playwright run against `pnpm dev` (not a committed suite) records
   no browser alert, and no Tauri `message()`/`confirm()` window appears in the
   taskbar.
10. **Dialog fits the window.** At 1280×800 and at the 900×600 minimum, in the
    normal and error states, the whole panel stays inside the window and the
    action row is visible; only the body scrolls.

### Clean install (B3)

This validates the packaged artifacts, not a dev checkout. Build them first with
`task packages`; the full native-library and dependency inspection stays in
"Packaging" above, and this section adds the model-free and clean-root contract.
Model weights are never downloaded by CI: the real Hugging Face run below is a
gated/manual smoke.

> Package sizes (0.1.7, measured on 2026-11-14 with `task packages`; 0.1.6
> baseline for context):
>
> | Artifact | 0.1.7 bytes | 0.1.6 baseline | Δ bytes    |
> | -------- | ----------- | -------------- | ---------- |
> | `.deb`   | 29,676,964  | 30,851,320     | −1,174,356 |
> | `.rpm`   | 29,801,134  | 30,983,791     | −1,182,657 |
> | AppImage | 28,011,000  | 27,515,384     | +495,616   |
>
> The payload stays in the same range as 0.1.6: the 323,987,190 B of model
> weights live in the app-data model root, never in the installer. The AppImage
> grows slightly because the B3 sidecar is 2,699,864 B → 5,646,936 B while the
> payload also dropped the host font/PNG libraries still present in 0.1.6; the
> compressed `.deb`/`.rpm` shrink.

1. **Payload inspection.** No `.onnx` file or `models/` path may be shipped, and
   the Indigo libraries plus the ONNX Runtime chain must still be there. Every
   absence command must print nothing and every non-vacuity check must succeed,
   otherwise the inspection proves nothing:

   ```bash
   V=0.1.7
   DEB=build/packages/chemistry-draw_${V}_amd64.deb
   RPM=build/packages/chemistry-draw-${V}-1.x86_64.rpm
   APPIMAGE=build/packages/chemistry-draw_${V}_amd64.AppImage

   mkdir -p build/appimage
   APPIMAGE=$(realpath "$APPIMAGE")
   (cd build/appimage && rm -rf squashfs-root && "$APPIMAGE" --appimage-extract >/dev/null)

   # Non-vacuity: the sidecar, Indigo and the runtime are present.
   ar p "$DEB" data.tar.gz | tar -tz | grep usr/bin/indigo-server
   rpm -qlp "$RPM" | grep usr/bin/indigo-server
   test -x build/appimage/squashfs-root/usr/bin/indigo-server
   ar p "$DEB" data.tar.gz | tar -tz | grep 'libindigo\.so'
   rpm -qlp "$RPM" | grep 'libindigo\.so'
   find build/appimage/squashfs-root -name 'libindigo*.so*' | grep .
   ar p "$DEB" data.tar.gz | tar -tvz | grep 'libonnxruntime\.so'
   rpm2cpio "$RPM" | cpio -tv 2>/dev/null | grep 'libonnxruntime\.so'
   find build/appimage/squashfs-root -name 'libonnxruntime.so*' -printf '%y %p -> %l\n'

   # Absence: each command must print nothing.
   ar p "$DEB" data.tar.gz | tar -tz | grep -Ei '\.onnx$|/models/|manifest\.json'
   rpm -qlp "$RPM" | grep -Ei '\.onnx$|/models/|manifest\.json'
   find build/appimage/squashfs-root \( -iname '*.onnx' -o -ipath '*/models/*' -o -name 'manifest.json' \)

   # Recorded sizes.
   stat -c '%s %n' "$DEB" "$RPM" "$APPIMAGE"
   ```

   Expected: one real `libonnxruntime.so.1.31.0` plus the `.so.1`/`.so` symlinks
   per Linux payload, no model match from any absence grep, and the sizes above
   filled in the table.

2. **Packaged sidecar, empty root.** Run the sidecar from the extracted AppImage
   payload with an empty model root and the packaged libraries. No
   `ORT_DYLIB_PATH`: this proves the bundled chain loads from the packaged
   directory the way the release host points at it:

   ```bash
   CLEAN=$(mktemp -d)
   export LD_LIBRARY_PATH=$PWD/build/appimage/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64
   INDIGO_PORT=19321 INDIGO_NO_PARENT_WATCHDOG=1 \
     CHEMISTRY_MODELS_DIR=$CLEAN \
     ./build/appimage/squashfs-root/usr/bin/indigo-server &
   BASE=http://127.0.0.1:19321

   curl -s -o /tmp/clean-models.json -w '%{http_code}\n' "$BASE/v2/models" # 200
   jq '{ready, manifest_present, installed_bytes, total_bytes,
        download: .download.state}' /tmp/clean-models.json
   # { "ready": false, "manifest_present": false, "installed_bytes": 0,
   #   "total_bytes": 323987190, "download": "idle" }
   jq '.models[] | {key, installed, missing}' /tmp/clean-models.json
   curl -s "$BASE/v2/info" | jq -c .imago_versions                         # []
   ```

   The directory exists but holds nothing; neither route creates a manifest or
   contacts Hugging Face.

3. **Real download, verify and inference.** Start the opt-in download and poll
   `GET /v2/models` until it leaves `downloading`/`verifying`:

   ```bash
   curl -s -o /tmp/clean-download.json -w '%{http_code}\n' \
     -X POST "$BASE/v2/models/download"                                  # 202
   while :; do
     S=$(curl -s "$BASE/v2/models")
     STATE=$(echo "$S" | jq -r '.download.state')
     echo "$STATE $(echo "$S" | jq -r '[.download.downloaded_bytes,.download.total_bytes] | @tsv')"
     [ "$STATE" = "downloading" ] || [ "$STATE" = "verifying" ] || break
     sleep 1
   done
   echo "$S" | jq '{ready, installed_bytes, total_bytes, download: .download.state}'
   # ready: true, installed_bytes == total_bytes == 323987190, download: "ready"

   jq '.schema, .catalog_version, (.models | keys)' "$CLEAN/manifest.json"
   # 1, 1, ["image-classifier", "ocsr-handdrawn"]

   curl -s -X POST "$BASE/v2/models/verify" | jq '{ok, repair}'
   # { "ok": true, "repair": null }

   for ep in filter/classify ocsr/recognize; do
     curl -s -o "/tmp/clean-${ep//\//-}.json" -w "$ep %{http_code}\n" \
       -X POST "$BASE/v2/$ep" -H 'Content-Type: image/png' \
       --data-binary @src-tauri/sidecar/fixtures/caffeine.png
   done
   jq '.category, .model' /tmp/clean-filter-classify.json
   jq '{smiles, incomplete, model}' /tmp/clean-ocsr-recognize.json
   find "$CLEAN" -name '*.part'                                          # nothing
   kill %1
   ```

   Expected: both endpoints answer `200`; the filter reports
   `structure`/`image-classifier@Iagea/d21f4cb`; the OCSR body has the caffeine
   SMILES `CN1C=NC2=C1C(=O)N(C)C(=O)N2C`, `incomplete: false` and
   `ocsr-handdrawn@zenodo:10781330`; no `.part` file remains.

4. **Clean app-data UI flow.** Launch the packaged app (extracted AppRun or an
   installed package) with a fresh app-data root so the real profile is never
   touched:

   ```bash
   CLEAN_DATA=$(mktemp -d)
   XDG_DATA_HOME=$CLEAN_DATA ./build/appimage/squashfs-root/AppRun
   # or: XDG_DATA_HOME=$CLEAN_DATA \
   #   ./build/packages/chemistry-draw_0.1.7_amd64.AppImage
   ```

   1. **First launch.** The **Models** dialog opens automatically after the
      editor paints and the **Models** control is present in the toolbar. It
      lists both families and sizes, shows `Not installed` and `idle`, and no
      artifact request is made; there is no **Licenses and source** block or
      source URL. Recognize is disabled (`/v2/info` is `[]`).
      `$CLEAN_DATA/dev.spalax.ChemistryDraw/` exists and `models/` is empty.
   2. **Later and reopen.** **Later** closes it; the app draws, runs Layout and
      saves a `.ket` file. **Models** reopens the same state and the dialog does
      not reopen by itself.
   3. **Download → ready.** Draw a structure, click **Download**: progress is
      polled in the dialog; at the end it is ready with 323,987,190 installed
      bytes and `$CLEAN_DATA/dev.spalax.ChemistryDraw/models/manifest.json`,
      and the **Models** control disappears from the toolbar.
      **Recognize enables without a restart**: the structure, selection and
      undo history are intact (no remount). Use **Recognize Molecule** with
      `caffeine.png`: the structure is inserted (the packaged models, runtime
      and Indigo all ran).
   4. **Document workflow.** Save, Save As, Open, New and an Export still work
      while the Models state changes; no native alert or second OS window
      appears for any setup step.
   5. **Restart with installed models.** Relaunch with the same `CLEAN_DATA`:
      no dialog auto-opens and no **Models** control appears (ready, no update,
      no last verify repair); Recognize stays enabled. A second fresh
      `CLEAN_DATA` repeats step 1.

5. **Windows CI smoke.** The `windows` job
   (`.github/actions/windows-build/action.yml`) runs the release sidecar with
   `INDIGO_NO_PARENT_WATCHDOG=1` and an empty model root, and must assert:

   - `GET /v2/models` is `200` with `ready: false`, `manifest_present: false`,
     `installed_bytes: 0`, `total_bytes: 323987190` and `download.state: "idle"`.
   - `GET /v2/info` is `200` with `imago_versions: []`. The pre-B3 expectation
     of `local-ocsr` on a model-less runner is obsolete and must not return.
   - The existing `/v2/imago/uploads` compatibility checks stay (POST returns an
     `upload_id`, unknown id `404`, job terminal or `PENDING`, no
     `imago_worker`).
   - The NSIS payload carries `onnxruntime.dll` and the five Indigo DLLs and no
     `.onnx`/`models/` path.

   The runner never downloads the real models; the Windows change is guarded by
   the packaging contract test in `docs/testing.md` §5, and the real download
   remains the manual Linux smoke above.

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
  inserts a structure end to end (see below). On a clean install B3 gates the
  capability: `/v2/info` advertises no `imago_versions`, so the control is
  disabled until the model download completes.

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
- `GET /v2/info` adds only the synthetic `imago_versions` capability list, and
  only when the manifest and both models' required artifacts exist; the rest of
  the payload (`Indigo`, `indigo_version`, `api_path`) is unchanged and it
  carries no inference fields.

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
  below, and only when both model families' artifacts are installed: no OCSR or
  other inference fields, and the rest of its payload is unchanged.

### Recognize Molecule end to end

Requires both model sets (`models/manifest.json`, the classifier file and the
three OCSR artifacts) and a loadable ONNX Runtime. Without them `/v2/info`
advertises `imago_versions: []` and Ketcher disables the control; the
model-unavailable job path stays a sidecar contract, and the **Models** setup
dialog (above) is the supported way to install the models and enable the
control.

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
  confidently…"), conversion, timeout and the plain-text `413` ("The server
  could not process the image. It may be too large."). A direct request with
  models missing still maps to the setup copy, although B3 disables the control
  when the capability is absent. In every case the title is **Structure
  problem**, the friendly copy replaces the raw message and no native alert
  appears. An ad-hoc Playwright run against `pnpm dev` (not a committed suite)
  can make the same check a DOM assertion — a `[role="dialog"]` element titled
  `Structure problem` — plus `page.on("dialog")` recording no browser `alert()`;
  a native Tauri `message()` is an OS window outside the webview and satisfies
  neither. The same temporary flow, run against the dummy catalog and a
  manifest-valid ready root whose artifacts are not loadable, checks the two
  repair paths: (a) a Verify `ok: false` → **Later** → reopen from **Models**
  still shows **Repair** with the control visible, and closing again leaves it
  visible; (b) a Recognize attempt ends in the model-unavailable `FAILURE` body
  while `/v2/info` advertises the ids, and after the `ErrorDialog` is dismissed
  the **Models** control is visible and opens the dialog. That is the only
  way the attention override is exercised without corrupting a real install;
  the unit tests pin the helper and the substring match. The flow also checks
  that the accepted start is not treated as health: a Repair POST forced to
  `500` keeps the control visible after Later/reopen, an accepted `202` whose
  body still reports `downloading` (not forwarded, so no run starts) keeps the
  control visible while the following polls keep answering `downloading` for a
  couple of seconds (checked across at least two polls, not a sub-second
  snapshot), and the control stays visible while the real repair is
  `downloading` and hides only when the completed run reads healthy. The dialog
  shows the muted attention note only while the override is armed on a ready,
  verify-capable dialog (Verify is the action it points at); the note stays
  absent during a run and disappears with the override. A close-during-repair
  variant is the strict-clear regression: from the attention state a real Repair
  is started and **Later** closes the dialog before a poll sees progress, the
  run completes with no status read, and a fresh recognition failure (past the
  5 s dedupe) must leave the control visible and the note present after its
  silent refresh settles; an earlier run's pending health proof may not clear a
  failure observed now. A following **Verify** with `ok: true` hides the note
  and the control, the other clear path.
- Low confidence / incomplete: there is no deterministic fixture; a fragmented
  or heavily degraded sketch is the manual reproduction. The deterministic
  coverage is the gate test with a fake prediction. The dialog must say the
  structure could not be read confidently and must not show a partial
  structure.
- Models missing: on a clean root (or after renaming `models/`) `/v2/info`
  returns `imago_versions: []`, the Recognize control is disabled, `/v2/health`
  lists no model and Indigo keeps working. A direct `POST /v2/imago/uploads`
  still ends `FAILURE` with the model-unavailable message, but the UI cannot
  reach that path while the capability is absent.
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

### Model parity pilot (Phase D)

Manual and gated: it needs the external decimer-onnx-toolchain checkout, its
datasets and the installed models. CI never downloads the datasets or runs the
benchmark. The protocol and acceptance are in
`docs/benchmarks/model-parity.md`; this section is the run checklist.

**Prerequisites.**

| Item      | Requirement                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Toolchain | `$TOOLCHAIN` checkout at commit `c2265a6d83f3eb5a7ef0fd5df4741335627c5f20` (outside this repo)            |
| Datasets  | `$TOOLCHAIN/data/benchmark/classifier-curated/classified/` and `$TOOLCHAIN/data/benchmark/handdrawn-hdm/` |
| Models    | `models/manifest.json`, the classifier file and the three `ocsr-handdrawn-fp32` artifacts                 |
| Runtime   | A loadable ONNX Runtime (`ORT_DYLIB_PATH`, or the bundled `lib/<platform>/`)                              |
| Python    | `$TOOLCHAIN/.venv/bin/python` with Pillow and RDKit 2026.09.1                                             |

1. Verify the model hashes before starting:

   ```bash
   sha256sum models/image-classifier-fp16/classifier.fp16.onnx \
             models/ocsr-handdrawn-fp32/encoder.onnx \
             models/ocsr-handdrawn-fp32/decoder_step.onnx \
             models/ocsr-handdrawn-fp32/vocab.json
   ```

   Expected: `d5f5506b…af505a9` (classifier), `996727a2…c78193f52`
   (encoder), `cfff9788…c6bb6d68197` (decoder), `62c84d90…fa3c7dd` (vocab).
   A mismatch stops the run: it is a setup failure, not a parity result.

2. Verify the frozen inputs against the SHA-256 table in
   `docs/benchmarks/model-parity.md` §2 (`classifier.frozen.json`,
   `handdrawn.frozen.json`, both `labels.jsonl`, and the reference JSON files).

3. The runner starts the sidecar itself. It sets `CHEMISTRY_MODELS_DIR`,
   `ORT_DYLIB_PATH`, `LD_LIBRARY_PATH=<repo>/src-tauri/lib/linux-x86_64` (Indigo)
   and an explicit free loopback port (`INDIGO_PORT=<n>`), parses the
   `INDIGO_PORT=<n>` stdout line, and confirms `/v2/health` lists
   `image-classifier@Iagea/d21f4cb` and `ocsr-handdrawn@zenodo:10781330`. It
   never probes or binds 9321 and never touches a running packaged app.
   `INDIGO_PORT=0` would be the natural choice, but the sidecar binds an
   ephemeral port and then reports the literal `INDIGO_PORT=0`, so the runner
   allocates the free port in Node first. To run the sidecar by hand:

   ```bash
   cargo build --release -p indigo-server --bin indigo-server
   INDIGO_PORT=44100 CHEMISTRY_MODELS_DIR=$PWD/models \
     ORT_DYLIB_PATH=$PWD/.ort/linux-x86_64/libonnxruntime.so \
     LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
     target/release/indigo-server
   curl -s http://127.0.0.1:44100/v2/health
   ```

   Use the **release** binary for the pilot: it is what the app ships, and it
   is the only build whose latency is comparable to the toolchain. A debug
   binary (`target/debug/indigo-server`) is fine for a functional smoke test but
   its latency must never be reported as the app result.

4. Conversion is automatic: the runner converts the **197 TIFF** classifier
   pilot images to RGB PNG with the toolchain Pillow
   (`$TOOLCHAIN/.venv/bin/python`): first frame, `convert("RGB")`, no
   resize/normalization, temporary output only. The app decodes only
   PNG/JPEG/WebP, so an unconverted TIFF returns `400`; the app's supported
   formats are unchanged. The ID → PNG map is written to
   `converted-classifier.json` in the run directory.

5. Run the pilot (defaults: `$DECIMER_TOOLCHAIN_DIR` or
   `../decimer-onnx-toolchain`, `$PWD/models`, `.ort/linux-x86_64`,
   `target/release/indigo-server`):

   ```bash
   node scripts/model-parity.mjs --suite classifier --split pilot
   node scripts/model-parity.mjs --suite handdrawn --split pilot
   # or both suites in one sidecar process / run directory:
   node scripts/model-parity.mjs --suite both --split pilot
   ```

   `--sidecar <file>` overrides the binary (for example
   `--sidecar target/debug/indigo-server` for a functional-only run).
   `--split pilot` is the only accepted split (the pinned aggregate and the
   300-row gates are pilot-only), and `--out` must stay under
   `build/benchmarks/` so raw outputs cannot bypass the tracking policy.

   Raw predictions, converted images, the sidecar log and `summary.json` stay
   under `build/benchmarks/model-parity/<run-id>/`. A gate failure exits
   non-zero after writing the files; a setup/hash/status failure stops the run.

6. Read the aggregate and fill `docs/benchmarks/model-parity.md` §4:
   classifier accuracy, confusion, reactions and binary `n` (currently 228
   binary / 72 reactions); OCSR canonical over comparable pairs, exact, valid
   and incomplete; p50/p95; per-image agreement and deltas.

7. Check the gates:

   - Classifier: binary accuracy **≥ 0.7231** (same-pilot FP16 reference
     0.7281 − 0.5 pp), with 228 binary / 72 reactions and all 300 images
     decoded. Do not use the historical `0.7361`/`n=216` pilot file as the
     baseline; it is not the current frozen split (see the protocol §2.3).
   - OCSR: canonical **≥ 0.7092** (reference 0.7192 − 1.0 pp) over comparable
     pairs; record exact (reference 121/300) and valid (299/300, 1 incomplete).
   - Artifact hashes equal; every per-image disagreement listed for review.
   - p50/p95 recorded on the same machine and the **release** build
     (nearest-rank, after one warm-up); latency is informational and the
     classifier reference is an in-process toolchain number, not an HTTP one.

8. Investigate any gate failure in this order: artifact hash → conversion →
   preprocessing → decode path → threshold direction. Do not tune the
   classifier threshold (`0.000089`) or the OCSR confidence gate (`0.901`) on
   the pilot; the expected decision is **retain both**, and a change needs a
   separate calibration activity with a measured delta. Then run
   `node --test scripts/lib/model-parity.test.mjs` and
   `node scripts/harness.mjs`.

**Result (2026-11-17; release latency re-measured 2026-11-18).** Both gates
pass on `target/release/indigo-server` (SHA-256 `b7b850c9…6558263a`): classifier
0.7281 (166/228, 87/62/0/79, 72 reactions, 300/300 FP16 agreement) and OCSR
canonical 0.7276 (211/290), exact 122/300, valid 299/1 — identical to the
accepted debug run on all 600 rows, including every classifier score and OCSR
answer. Release p50/p95: classifier **124.4 / 425.9 ms**, OCSR
**1681.7 / 3557.0 ms** (full HTTP round trip, §3.4). The raw run is
`build/benchmarks/model-parity/2026-11-18T02-27-34-439Z/`; §4 of
`docs/benchmarks/model-parity.md` has the identity, the classifier latency split
and the nine OCSR per-image differences. A debug-build latency is not
representative and must not be quoted as the app result.

### OCSR incomplete tail (Phase D follow-up)

Manual, release build. Confirms that the repetition guard removes the one
pathological incomplete decode without changing any pilot300 decision. The
design, parameters, acceptance and residual risk are in
`docs/benchmarks/ocsr-tail-fix.md`; this section is the run checklist.

Use the same prerequisites as the model-parity pilot above (toolchain checkout,
datasets, installed models, loadable ONNX Runtime, **release** sidecar).

1. The accepted pre-guard run is
   `build/benchmarks/model-parity/2026-11-18T02-27-34-439Z/`. Its
   `details.jsonl` has `hdm::CDK_Depict_5_82` at status `422` with
   `latencyMs` **37,270.662** (37.3 s). Keep it as the comparison baseline; do
   not overwrite it.
2. Run the hand-drawn pilot with the guarded release binary:

   ```bash
   node scripts/model-parity.mjs --suite handdrawn --split pilot
   ```

3. In the new `details.jsonl`, find `hdm::CDK_Depict_5_82`:

   - status `422`, with `valid: false`, `exact: false`, `canonical: null` and
     `incomparable: true` — the row keeps its parity classification;
   - `latencyMs` **≤ 5000** (target five seconds). A value in the tens of
     seconds means the guard did not fire.

4. Check the aggregate is unchanged: canonical **211/290**, exact **122/300**,
   valid **299/1** (sidecar result; the toolchain reference is 210/292,
   121/300, 299/1).
5. Diff every row against the accepted run's `details.jsonl`: status, `got`,
   `exact`, `canonical` and `incomparable` must be identical, **0 differences**
   over 300 rows. Any changed `got` on an answered row means a valid decode was
   cut: stop, raise the guard's repeat threshold (report §8), rerun.
6. The sidecar log line for the row must still end `incomplete`, with far fewer
   than 303 ids (start plus 302 generated) and a time consistent with the HTTP
   latency.
7. Run `cargo test -p indigo-server` (the fake-decoder guard cases) and
   `node scripts/harness.mjs`. The manifest, `max_len`, thresholds and model
   artifacts must be unchanged.

| Item                                | Before                    | Target after |
| ----------------------------------- | ------------------------- | ------------ |
| `hdm::CDK_Depict_5_82` status       | `422`                     | `422`        |
| `hdm::CDK_Depict_5_82` HTTP latency | 37.3 s                    | ≤ 5 s        |
| Canonical / exact / valid           | 211/290 / 122/300 / 299/1 | unchanged    |
| Per-image differences (300 rows)    | —                         | 0            |

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

> **US-01 update (1.x):** the single-document `autosave.ket`/`autosave.json`
> snapshot and its Restore/Discard prompt are replaced by per-tab snapshots
> under `recovery/tabs/` and silent restore (ADR 0010, ACT-07). The current
> workflow is `docs/harness/verification.md` §10, "Per-tab recovery after
> restart"; the recovery steps below describe the 0.x baseline.

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
   plus exactly four extra buttons: Save, New, Export and Models. There is no
   **Save As…** entry.
2. **Icon styling.** Save, New, Export and Models match the neighbours' metrics
   and inherit their colour; the app never paints a fixed icon colour.
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
   - **Titles:** the tooltips are still `Save`, `New`, `Export` and `Models`,
     and the Save glyph is visually distinct from a floppy disk glyph.
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
   `buttons.save.hidden`; there is no CSS `display: none` and no DOM query for
   the native entry. (The app's only DOM hook toggles the app-registered
   `Models` control; see `docs/conventions.md` §6.5.1.)
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
  `libopencv*`. `build/packages/` may hold older generations, so target the
  version under test with explicit paths (never a glob over two generations).
  Each absence command must print nothing, and each non-vacuity check must
  succeed — otherwise the inspection proves nothing:

  ```bash
  V=0.1.6
  DEB=build/packages/chemistry-draw_${V}_amd64.deb
  RPM=build/packages/chemistry-draw-${V}-1.x86_64.rpm
  APPIMAGE=build/packages/chemistry-draw_${V}_amd64.AppImage

  # Non-vacuity: the payload really contains the sidecar.
  ar p "$DEB" data.tar.gz | tar -tz | grep usr/bin/indigo-server >/dev/null
  rpm -qlp "$RPM" | grep usr/bin/indigo-server >/dev/null
  mkdir -p build/appimage
  APPIMAGE=$(realpath "$APPIMAGE")
  (cd build/appimage && rm -rf squashfs-root && "$APPIMAGE" --appimage-extract >/dev/null)
  test -x build/appimage/squashfs-root/usr/bin/indigo-server

  # Absence: each command must print nothing.
  ar p "$DEB" data.tar.gz | tar -tz | grep -Ei 'imago|opencv'
  rpm -qlp "$RPM" | grep -Ei 'imago|opencv'
  find build/appimage/squashfs-root \( -iname '*imago*' -o -iname '*opencv*' \)
  ```

- The packaged sidecar answers `GET /v2/info` with `imago_versions: []` because
  the payload carries no models (with an installed model root it advertises the
  synthetic `["local-ocsr"]` capability) and `GET /v2/health` without
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
find build/appimage/squashfs-root -name 'libonnxruntime.so*' -printf '%y %p -> %l\n'

# No model weights: each command must print nothing.
ar p "$DEB" data.tar.gz | tar -tz | grep -Ei '\.onnx$|/models/'
rpm -qlp "$RPM" | grep -Ei '\.onnx$|/models/'
find build/appimage/squashfs-root \( -iname '*.onnx' -o -ipath '*/models/*' \)
```

`scripts/check-native-libs.sh --allowlist /opt/chemistry/libs
/opt/chemistry/libs <bundled-lib-dir>` passes right after the builder copy (no
output, exit 0); a stale builder image fails there before bundling. `ldd` and
`readelf -d` on the packaged sidecar show no ONNX Runtime:

```bash
export LD_LIBRARY_PATH=$PWD/build/appimage/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64
ldd build/appimage/squashfs-root/usr/bin/indigo-server | grep -c libonnxruntime      # 0
readelf -d build/appimage/squashfs-root/usr/bin/indigo-server | grep -i onnxruntime  # nothing
```

Packaged-sidecar smoke, run from the repository root so the fixture and models
resolve. No `ORT_DYLIB_PATH`: this proves the bundled library itself loads from
the packaged directory through `LD_LIBRARY_PATH` (the release host points
`ORT_DYLIB_PATH` at the same directory).

```bash
LD_LIBRARY_PATH=$PWD/build/appimage/squashfs-root/usr/lib/chemistry-draw/lib/linux-x86_64 \
  CHEMISTRY_MODELS_DIR=$PWD/models \
  ./build/appimage/squashfs-root/usr/bin/indigo-server &
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

### Ketcher 3.21 / Indigo 1.49 adoption (US-07)

The story checkpoint is C17 in `docs/CHECKPOINTS.md`. Its automated half was run
on the `us-07-ketcher-321` branch; its manual half is **pending** until a
packaged build is exercised. A command not listed as run here is not green.

**Automated gates (run).**

| Command                                                                      | Result                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `node --test scripts/lib/e1-ketcher.test.mjs scripts/lib/e1-indigo.test.mjs` | 12 tests, 12 pass, 0 fail: exact 3.21.0 pins, committed multi-language tarball, narrowed patch, Indigo pins  |
| `pnpm test`                                                                  | 21 files, 484 tests, all pass: toolbar, option store, patch, recognition, model setup and dialog-token units |
| `pnpm exec tsc --noEmit`                                                     | exit 0                                                                                                       |
| `node scripts/harness.mjs --fast`                                            | green (format, structure, docblocks; lint/type/test skipped on a docs-only tree)                             |

The `/v2/info` version check does not need Docker or a native rebuild because
`src-tauri/lib/linux-x86_64` already holds the 1.49.0 libraries:

```bash
cargo build -p indigo-server --bin indigo-server
LD_LIBRARY_PATH=$PWD/src-tauri/lib/linux-x86_64 \
  INDIGO_PORT=19472 INDIGO_NO_PARENT_WATCHDOG=1 \
  CHEMISTRY_MODELS_DIR=$PWD/models ./target/debug/indigo-server &
curl -s http://127.0.0.1:19472/v2/info | jq '{indigo_version, imago_versions}'
kill %1
```

Observed: `HTTP 200` with `indigo_version`
`1.49.0.0-g92d2821-x86_64-linux-gnu-12.2.0`; with `models/` installed,
`imago_versions: ["local-ocsr"]`. The version string comes from the loaded
Indigo library, so this is the real pin, not a constant. A clean model root must
answer `imago_versions: []` (covered by the sidecar tests and `docs/verification`
"Model delivery (B3)").

**Pending manual checks (not yet verified).** These need a packaged build
(`task packages` / `pnpm tauri build`) and a GUI, so they are the user's closing
gate, not a CI step:

1. **Language selector in the packaged app.** Launch the packaged app, open the
   language selector, switch English → Simplified Chinese and back. Every
   Ketcher label, menu and dialog title changes; the choice persists across a
   relaunch in `localStorage["ketcher-language"]`. The packaged payload must
   carry the multi-language `ketcher-react` build, not the English-only npm
   bundle.
2. **Sidecar wiring after the switch.** With the language changed, draw a
   structure, run Layout/Clean, Open and Export, and Recognize Molecule with
   `src-tauri/sidecar/fixtures/caffeine.png`. All reach the sidecar; `/v2/info`
   still answers 1.49.0 and the API base is the bound port (no
   `127.0.0.1undefined`).
3. **Packaged smoke.** Run the packaged sidecar (see "Packaged sidecar, empty
   root" and "Clean install (B3)") and confirm `/v2/info` reports 1.49.0 from the
   packaged libraries, with `imago_versions` following the installed models.
4. **GUI contracts on 3.21.** Re-run the "Toolbar integration", "In-app dialog
   styling", "Documents, autosave and recovery" and "Recognize Molecule end to
   end" checklists on the 3.21 build. The unit contracts are green; the rendered
   toolbar, dialogs and recognition surface are not unit-tested.
5. **Full harness.** `node scripts/harness.mjs --activity ACT-05` (the
   orchestrator runs it serially) and the full `node scripts/harness.mjs` with
   the frontend build, Clippy and the sidecar suite.

### Toolchain drift (US-10)

The story checkpoint is C18 in `docs/CHECKPOINTS.md`. It keeps one toolchain
source of truth (`.nvmrc` for Node, `packageManager` for pnpm) across the
workflows, the composite actions and the builder image (ADR 0012), covers
`develop` in `ci.yml`, and trims the capability set to the file-picker dialogs.
The automated half was run on the `us-10-tooling-drift` branch; the manual half
is **pending** until a packaged build and a real `develop` CI run. A command not
listed as run here is not green.

**Automated gates (run).**

| Command                                                | Result                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test scripts/lib/toolchain-alignment.test.mjs` | 7 tests, 7 pass, 0 fail: `.nvmrc`/`packageManager` parity, `node-version-file`, no pnpm major, `develop` triggers, builder pin, capability set |
| `node --test scripts/lib/*.test.mjs`                   | 131 tests, 131 pass, 0 fail (includes `clean-install.test.mjs`)                                                                                |
| `node scripts/harness.mjs --fast`                      | green (format, structure, docblocks; lint/type/test skipped on a docs-only tree)                                                               |

The capability JSON in `src-tauri/capabilities/default.json` is syntactically
parsed and asserted by `toolchain-alignment.test.mjs` (it is data, not Rust), so
`cargo check -p indigo-server` is not the gate for it. `clean-install.test.mjs`
reads packaging scripts and configs only and spawns nothing; it needs no Docker
or network, and runs as part of the suite above.

**Pending manual checks (not yet verified).**

1. **Packages and clean install.** Run `task packages`, then the payload
   inspection and the packaged-sidecar empty-root/download smoke in "Clean
   install (B3)" above. Expected: the `.deb`/`.rpm`/AppImage build with the
   pinned toolchain, no `.onnx`/`models/`/`manifest.json` in any payload, and
   Indigo plus the ONNX Runtime 1.31.0 payload retained.
2. **Real `develop` CI run.** Push the branch and confirm the `ci` job (Node
   `24.20.0` and pnpm `12.21.0` from `.nvmrc`/`packageManager`, builder image
   from `scripts/Dockerfile`, Node tests, sidecar tests, frontend build) and the
   `windows` job are green. The local contract suite does not reproduce a
   clean-runner run.
3. **Full harness.** `node scripts/harness.mjs --activity ACT-03` (the
   orchestrator runs it serially) and the full `node scripts/harness.mjs` with
   the frontend build, Clippy and the sidecar suite.

---

## 3. Reviewer checklist

Verify before closing (there is no reviewer agent in the two-stage harness; the
gates and the story approval are described in `docs/harness/verification.md`):

- [ ] Harness passes (`node scripts/harness.mjs` exits 0)
- [ ] TypeScript clean (`pnpm exec tsc --noEmit`)
- [ ] ESLint clean (`pnpm run lint`)
- [ ] Prettier clean (`pnpm run format:check`)
- [ ] Rust formatting clean (`cargo fmt --all --check`)
- [ ] Clippy clean (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Sidecar tests green (`cargo test -p indigo-server`)
- [ ] Activity order, claims, `touches` and story approval follow
      `docs/harness/verification.md`; the v1 phases, reviewer agent and
      `activity-policy` scripts are retired
- [ ] New behaviour has a test that would fail without the change
- [ ] Model delivery is verified: empty-root status, opt-in
      download/resume/cancel/verify, generated schema-1 manifest, app-data root,
      `/v2/info` capability gating, and no model files in packages
- [ ] Model setup UI is verified: the conditional **Models** control (visible
      on an unknown/not-ready install, an available update, a verify repair, a
      recognition failure that reports the models unavailable, or a
      downloading/verifying/cancelled/failed run even on a ready install;
      hidden only on a healthy `idle`/`ready` install with no attention flag;
      accepting a download-style run does not clear the attention, it arms the
      health proof: a response that is already healthy (the `200` no-op re-hash)
      clears immediately, otherwise a later status read clears only when the
      completed run reports healthy, and a new model-unavailable failure
      invalidates any pending proof; the dialog shows the muted Verify note only
      while the override is armed on a ready, verify-capable dialog),
      auto-open/Later, Later → reopen keeping Repair and the control, opt-in
      Download with polling/progress, the
      Download/Resume/Repair/Update/Verify/Cancel/Retry
      labels, in-dialog offline/disk errors with no native alert, the dialog
      without a license/source block, and Recognize enabling after ready
      without a remount or canvas loss
- [ ] Clean install is verified: the packaged payloads carry no model weights
      and keep Indigo/ONNX Runtime, the AppImage sidecar serves the empty
      `/v2/models` + `/v2/info` contract and runs the real download/verify plus
      filter/OCSR, the packaged app's clean-root Models flow works, the Windows
      smoke covers `/v2/models` empty and `/v2/info` `[]`, and the measured
      sizes are recorded
- [ ] Toolchain drift is fixed: every workflow and composite action reads Node
      from `.nvmrc` and pnpm from `packageManager`, `ci.yml` covers `main` and
      `develop`, the builder pins Node 24 and `pnpm@12.21.0`, and the capability
      set keeps only `dialog:allow-open`/`dialog:allow-save` (no
      `dialog:allow-message`); see `docs/CHECKPOINTS.md` C18
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
