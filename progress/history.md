# Session History

> Append-only log of completed sessions/activities.

---

## 2026-11-03 — Activity 2: docs → test → implement enforcement

- Added `scripts/lib/activity-policy.mjs` and 32 policy tests; harness block 3
  runs them and validates `activities.json`.
- Documented the mandatory docs → test → implement → review order, the
  `phase` field, the docs-only exception and strict sequential status in
  `AGENTS.md`, `README.md`, `docs/` and all agent prompts.
- `node scripts/harness.mjs` green; Linux sidecar 87 tests pass.
- Activity 1 (Windows build) remains blocked on its Windows CI run.

---

## 2026-11-03 — Activity 1: Windows build without Imago

- Windows x86_64 now builds from native Indigo 1.46.0 DLLs; Imago/OpenCV are
  compiled out, `/v2/info` reports `imago_versions: []`, the Imago routes are not
  registered and `imago-worker` is a stub that is not bundled.
- Pinned the Indigo archive by SHA-256 and generate the MSVC import libraries at
  fetch time (`scripts/fetch-windows-libs.ps1`).
- Fixed two bundle-time version mismatches: `tauri-plugin-log` 2.9.2 → 2.10.1,
  and `@tauri-apps/api`/`cli` 2.11 → 2.12.4 after `tauri` moved to 2.12.5. The
  harness now checks every plugin pair and the core `tauri`/api pair.
- CI run 41719701028 green: sidecar, harness (88 tests), smoke test and NSIS.
  Artifact `chemistry-draw_0.1.3_x64-setup.exe` (11 MB) verified to contain the
  app, `indigo-server.exe`, Indigo DLLs, VC runtime and WebView2 bootstrapper,
  with no `imago-worker.exe`.
- Follow-up: `release.yml` still publishes Linux packages only; Windows
  publishing is not wired to releases yet.

## 2026-11-03 — Activity 1: Windows NSIS build without Imago

- Windows CI run `41719701028` passed on `windows-latest`: 88 sidecar tests,
  sidecar smoke test, NSIS build and artifact upload.
- Artifact `chemistry-draw-windows-nsis` (11,074,058 bytes) uploaded.
- Pinned EPAM Indigo 1.46.0 Windows DLLs, generated MSVC import libraries,
  compiled Imago out on Windows and disabled Recognize Molecule.
- Linux CI passed in the same run; Tauri JS/core versions are aligned at 2.12.
- Activity 2 (docs → test → implement → review enforcement) also done.

## 2026-11-03 — Activity 3: publish the Windows installer

- Extracted the Windows job into `.github/actions/windows-build` (toolchain,
  pinned Indigo DLLs, sidecar build/stage, harness, smoke test, NSIS bundle).
- `ci.yml` now calls the action and uploads the artifact; `release.yml` adds a
  `windows-packages` job with the same gating as the Linux publish job and
  attaches `target/release/bundle/nsis/*.exe` to the release. Manual runs keep
  the workflow artifact.
- Added `scripts/lib/release-workflow.test.mjs` (YAML structure tests) and made
  the harness run every `scripts/lib/*.test.mjs`; 37 tests pass.
- README and `docs/architecture.md` document the Windows release artifact.

## 2026-11-03 — Activity 4: per-machine Windows install

- Installing the NSIS bundle as the default current user left WebView2 scoped to
  that account (or failed without elevation), so the app showed "Could not find
  the WebView2 Runtime".
- `src-tauri/tauri.windows.conf.json` now sets `bundle.windows.nsis.installMode`
  to `perMachine`; the installer asks for admin and installs WebView2 for every
  user. The embedded bootstrapper still needs network; offline targets can use
  `offlineInstaller` (+127 MB).
- Added `scripts/lib/windows-bundle.test.mjs` (install mode, WebView2 mode,
  Imago-free bundle). Harness green with 40 tests.
