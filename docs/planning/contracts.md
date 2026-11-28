# Contracts

> The promises between the parts of Chemistry Draw. If two components are built
> or changed independently, their contract lives here.
> [`docs/architecture.md`](../architecture.md) is the detailed reference; this
> document is the human-readable contract map.
>
> **Reconstructed from the code and the existing docs on 2026-11-21.** Updated
> for the US-01 port of the `main` 0.1.8 backstage/file workflow (ADR 0009); the
> sidecar and model contracts are unchanged.
>
> Sources: `docs/architecture.md` §5 (backstage, tabs, documents), §6 (API
> surface), §7 (ONNX and models) and §8–§9 (native libraries and packaging);
> `main`'s `docs/architecture.md` §5 for the workflow contract it contributed;
> `docs/conventions.md` §8–§12; `docs/testing.md`; `src-tauri/sidecar/src/lib.rs`
> and `error.rs` for the routes and the error mapping. Where a document and the
> code disagree, the code wins for facts and the user wins for intent.

## 1. Contract inventory

| Contract                   | Producer                       | Consumer                         | Transport                                    | Version             |
| -------------------------- | ------------------------------ | -------------------------------- | -------------------------------------------- | ------------------- |
| Sidecar HTTP API           | `indigo-server`                | Ketcher webview; support tooling | HTTP/1.1 on `127.0.0.1:<port>`               | `/v2`               |
| Model catalog and manifest | Sidecar (compiled + generated) | Sidecar registry; setup UI       | Embedded JSON + `<model root>/manifest.json` | schema 1            |
| Ketcher job protocol       | Sidecar (shim)                 | Ketcher `RemoteStructService`    | HTTP POST + poll (`/v2/imago/uploads`)       | Ketcher 3.21        |
| Tauri IPC commands         | Tauri host                     | Ketcher webview                  | `invoke` over Tauri IPC                      | Tauri v2            |
| Host ↔ sidecar process     | Tauri host                     | `indigo-server`                  | Spawn, environment, stdout, stdin            | —                   |
| Sidecar ↔ Indigo           | `libindigo` / renderer         | `ffi/`                           | C ABI                                        | Indigo platform pin |
| Sidecar ↔ ONNX Runtime     | ONNX Runtime 1.31.0            | `service/ml/` through `ort`      | Dynamic library load (`ORT_DYLIB_PATH`)      | `api-31`            |
| Model download             | Hugging Face                   | Sidecar downloader               | HTTPS GET with `Range`                       | pinned by catalog   |
| Document format            | Ketcher                        | User, fs plugin, tabs            | `.ket` (UTF-8 JSON), one per tab             | Ketcher-owned       |
| Tab workspace              | Ketcher webview                | User; File menu; backstage       | Tab strip + one mounted editor               | 1.x                 |
| Recovery snapshots         | Ketcher webview                | Next launch                      | `<appDataDir>/recovery/tabs/` files          | 1.x                 |
| Recent documents list      | Ketcher webview                | File menu; backstage Open        | `localStorage` JSON array                    | —                   |

A contract without a consumer is not a contract; delete it.

## 2. Conventions

- **Base URL:** `http://127.0.0.1:<port>/v2`. `/v2/info.api_path` reports the
  **actually bound** port, which can differ from 9321 when it is busy. The
  frontend must use the reported port, never a hardcoded one.
- **Transport:** plain HTTP on loopback, JSON bodies except for raw image uploads,
  the render response (base64 text) and the check response (Indigo's JSON text).
- **CORS:** `tower-http` allows any origin, because the webview origin is not the
  loopback origin. The server is not reachable from another machine.
- **Authentication:** none. The loopback bind is the boundary; do not add a token
  without an ADR.
- **Error envelope:** every `AppError` is `{ "error": "<actionable message>" }`
  with one of `400`, `404`, `409`, `422`, `500`, `503`. The `413` from axum's
  `DefaultBodyLimit` is the documented exception: its body is plain text
  (`Failed to buffer the request body`), not JSON.
- **Idempotency:** `GET` routes are read-only. `POST /v2/models/download` is
  idempotent in the artifact sense; model operations and download runs are not
  otherwise retryable without a new request.
- **Versioning:** the `/v2` prefix is the contract generation. Additive fields and
  new routes are allowed; removing or renaming a field is breaking and needs a new
  version plus an ADR.

## 3. Sidecar HTTP API

### 3.1 Informational routes

| Method | Path              | Response                                                                                                                                                                                                                                                |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v2/info`        | `{ "Indigo": { "version": "<linked Indigo version>" }, "indigo_version": "<linked Indigo version>", "api_path": "http://127.0.0.1:9321/v2", "imago_versions": [] }`                                                                                     |
| GET    | `/v2/indigo/info` | Alias of `/v2/info`                                                                                                                                                                                                                                     |
| GET    | `/v2/health`      | `{ "status": "ok", "version": "0.1.7", "pid": 1234, "port": 9321, "uptime_seconds": 42, "indigo_version": "<linked Indigo version>", "onnxruntime_version": "onnxruntime api 1.31.x (ort 2.0.0-rc.15)", "models": ["image-classifier@Iagea/d21f4cb"] }` |

`imago_versions` is a **synthetic capability list**, not an Imago build. It is
`["local-ocsr"]` only when the manifest is usable and both models' required
artifacts exist; otherwise `[]` and Ketcher disables Recognize. The capability
check is metadata plus existence only — no hashing, no session. The examples
above show the shape; a clean install answers `[]` and may report no model ids.

`/v2/health` never fails because of the model store. `models` lists ids whose
required artifact files exist; a parsed manifest is authoritative, otherwise the
active catalog supplies the ids. `onnxruntime_version` names the API generation
`ort` targets, not the binary's patch version.

### 3.2 Indigo routes

| Method | Path                                                                |
| ------ | ------------------------------------------------------------------- |
| POST   | `/v2/indigo/convert`, `aromatize`, `dearomatize`, `layout`, `clean` |
| POST   | `/v2/indigo/render`                                                 |
| POST   | `/v2/indigo/calculate`, `check`, `calculate_cip`, `automap`         |

Generic request (`IndigoRequest`):

```json
{
  "struct": "<SMILES, molfile or other Indigo input>",
  "output_format": "chemical/x-mdl-molfile",
  "options": {}
}
```

`struct` is required. `output_format` defaults to `chemical/x-mdl-molfile`;
`options` is a free-form map passed to the backend. The response is:

```json
{ "struct": "<result in the requested format>", "format": "chemical/x-mdl-molfile" }
```

Route-specific shapes:

- **render:** request `{ struct, output_format, query?, options }` with
  `output_format` defaulting to `image/svg+xml`. `options["render-output-format"]`
  may be `"png"` or `"svg"`. The response body is base64 text with
  `Content-Type: text/plain`; the caller decodes it to the image.
- **calculate:** request `{ struct, properties, options }`, `properties`
  defaulting to `["molecular-weight"]`. The response is an object with any of
  `molecular-weight`, `gross`, `most-abundant-mass`, `monoisotopic-mass`,
  `mass-composition`, each a string, omitted when not requested/available.
- **check:** request `{ struct, types, options }` with a default type list
  (valence, ambiguous_h, query, pseudoatoms, radicals, stereo, overlapping atoms
  and bonds, 3d, sgroups, v3000, rgroups). The response is Indigo's own JSON text
  with `Content-Type: application/json`.

Errors: `400` invalid input, `500` backend failure. These routes never return
`503`; they do not use models.

### 3.3 Filter

`POST /v2/filter/classify`

- Body: raw image bytes, `Content-Type: image/png`, `image/jpeg` or
  `image/webp`. No multipart, no base64, no job id.
- Limit: 10,485,760 bytes **inclusive**. A body of exactly that size is decoded;
  larger is `413` (plain text from `DefaultBodyLimit`).
- `200`:

```json
{
  "contains_molecule": true,
  "category": "structure",
  "score": 0.0000042,
  "threshold": 0.000089,
  "logit": -12.38,
  "model": "image-classifier@Iagea/d21f4cb"
}
```

`score` is `sigmoid(logit)`, `category` is `structure` when
`contains_molecule` is true and `no-structure` otherwise, and `threshold` is
echoed so clients do not hardcode it. **Low score means structure**;
`score <= 0.000089` is `structure`.

- Errors: `400` undecodable/unsupported image (including over-limit dimensions or
  decoder allocations), `413` over the cap, `503` model or runtime unavailable.
- The handler validates the media type **before** resolving the model, so
  malformed input is `400` even without a model.

### 3.4 OCSR

`POST /v2/ocsr/recognize`

- Body, media types and cap: identical to the filter.
- `200`:

```json
{
  "smiles": "CCO",
  "confidence": 0.93,
  "incomplete": false,
  "model": "ocsr-handdrawn@zenodo:10781330"
}
```

`confidence` is the arithmetic mean of the chosen-token probabilities, including
the final end-token step. The endpoint does **not** gate on confidence: a complete
low-confidence decode is still `200`.

- `422` when the decoder stops without `end_id` (at `max_len = 302` or at the
  repetition guard). Body:
  `{ "error": "could not finish the structure; try a sharper image" }`.
  A truncated SMILES is never returned.
- Errors: `400` malformed image, `413` over the cap, `422` incomplete decode,
  `500` unexpected inference failure, `503` model/runtime unavailable.

### 3.5 Ketcher compatibility shim

Ketcher 3.21's `RemoteStructService.recognize()` hardcodes this protocol. The
route name is Ketcher's; the pipeline behind it is local.

| Method | Path                              | Contract                                                                                                                                                                                                                |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v2/imago/uploads[?version=<v>]` | Raw image body, accepted media types as above, 10 MiB cap; `200 { "upload_id": "<id>" }`                                                                                                                                |
| GET    | `/v2/imago/uploads/{id}`          | `200 { "state": "PENDING" }`, `200 { "state": "SUCCESS", "metadata": { "mol_str": "<V2000>" } }`, or `200 { "state": "FAILURE", "error": "<message>" }`; unknown/expired/restarted id is `404 { "error": "<message>" }` |

- `version` is accepted and ignored: one local OCSR model serves every request.
- POST does **not** decode the image. It validates media type and the cap, stores
  the bytes and runs the pipeline on a blocking worker. Decode failures are
  therefore `FAILURE` states, not `400`.
- Ketcher waits 300 ms, then polls every 500 ms with no fixed client-side limit.
- The pipeline order is contract: filter gate (`contains_molecule` false → fail),
  OCSR (incomplete or `confidence < confidence_threshold` → fail), SMILES →
  V2000 molfile through Indigo convert (failure → fail), then SUCCESS.
- Job bounds: a worker still running after 120 s resolves as `FAILURE` with the
  timeout message; a job still `PENDING` after 600 s resolves the same way on its
  next poll; a resolved job is discarded 600 s after it resolves. The store is
  in-memory and per-process; a restart drops every job. Uploaded bytes are
  dropped as soon as the job resolves.
- Failure messages and the `ErrorDialog` copy are a contract: the table in
  `docs/architecture.md` §7, "Recognize Molecule compatibility flow", lists every
  condition. `src/recognizeErrors.ts` maps the documented substrings; changing a
  backend message requires changing that mapping and its tests.

### 3.6 Model routes

All routes share `/v2`. There is **no SSE or WebSocket**: the client polls
`GET /v2/models`.

| Method | Path                         | Behavior                                                                                                                                                                                                    |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v2/models`                 | `200` with the status body, even with no root, manifest or models. The bundled catalog is always valid; a broken test override is `500`                                                                     |
| POST   | `/v2/models/download`        | `202` starts/resumes; `200` only when every installed artifact re-hashes to the catalog size and SHA-256 and the manifest is current (no-op); `409` while a run is active or the installed catalog is newer |
| POST   | `/v2/models/download/cancel` | `202` while downloading; `409` otherwise                                                                                                                                                                    |
| POST   | `/v2/models/verify`          | `200` with the SHA-256 report and repair hint; `409` while a run is active                                                                                                                                  |

Download and cancel answer with the same status body as `GET`; verify answers with
its report. A `409` uses the standard error envelope, and the status stays
available from `GET /v2/models`.

Status body:

```json
{
  "catalog_version": 1,
  "installed_catalog_version": null,
  "update_available": false,
  "ready": false,
  "manifest_present": false,
  "total_bytes": 323987190,
  "installed_bytes": 0,
  "models": [
    {
      "key": "image-classifier",
      "id": "image-classifier@Iagea/d21f4cb",
      "version": "Iagea/d21f4cb",
      "license": "MIT",
      "total_bytes": 8162917,
      "installed_bytes": 0,
      "installed": false,
      "missing": ["image-classifier-fp16/classifier.fp16.onnx"]
    }
  ],
  "download": {
    "state": "idle",
    "downloaded_bytes": 0,
    "total_bytes": 323987190,
    "current_file": null,
    "error": null
  }
}
```

- `download.state` is one of `idle`, `downloading`, `verifying`, `ready`,
  `cancelled`, `failed`.
- `installed` and `missing` are a cheap existence check; `GET` never hashes
  324 MB. `ready` additionally requires a usable schema-1 manifest and every
  required artifact present.
- `update_available` is true when a manifest exists and its catalog version is
  missing or lower than the bundled one. A newer installed catalog is never
  downgraded: `POST /download` answers `409`.
- `download.downloaded_bytes` is cumulative for the run (verified/skipped bytes
  plus the current `.part` length). `download.error` is `null` unless the state is
  `failed`.

Verify report:

```json
{
  "ok": false,
  "catalog_version": 1,
  "checked_bytes": 216964594,
  "artifacts": [
    { "path": "image-classifier-fp16/classifier.fp16.onnx", "status": "ok" },
    {
      "path": "ocsr-handdrawn-fp32/encoder.onnx",
      "status": "corrupt",
      "expected_sha256": "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
      "actual_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    { "path": "ocsr-handdrawn-fp32/decoder_step.onnx", "status": "missing" }
  ],
  "repair": "POST /v2/models/download"
}
```

`artifacts[].status` is `ok`, `missing` or `corrupt`; a size or checksum
mismatch is `corrupt`, with `expected_sha256` and `actual_sha256` when a hash was
computed. `ok` is true only when every artifact is present and matches; `repair`
is `null` then. Verification is read-only; the download route is the repair path.

## 4. Model catalog and manifest

### 4.1 Catalog

The catalog is compiled into the sidecar (`service/ml/model-catalog.json` +
`catalog.rs`), never read from the model root at runtime. It is the source of
truth for **what to download**:

- `catalog_version` (currently `1`).
- Per model: `id`, `version`, `license`, `source`, preprocessing/threshold/decode
  settings and the tensor contracts.
- Per artifact: `role` (`classifier`, `encoder`, `decoder`, `vocab`), `path`
  relative to the model root, `url`, `size`, `sha256`, and for graphs
  `inputs`/`output` (plus `zero_inputs` where the export exposes them).
- An absolute artifact path or one containing `..` is a catalog error.

Pinned models and artifacts:

| Key                | Provenance id                    | License   | Settings                                                                  |
| ------------------ | -------------------------------- | --------- | ------------------------------------------------------------------------- |
| `image-classifier` | `image-classifier@Iagea/d21f4cb` | MIT       | `runtime_default`, threshold `0.000089`                                   |
| `ocsr-handdrawn`   | `ocsr-handdrawn@zenodo:10781330` | CC-BY-4.0 | `decimer_ocsr`, start 13, end 14, max_len 302, confidence threshold 0.901 |

| Key                | Role         | Path                                         | Bytes       | SHA-256                                                            |
| ------------------ | ------------ | -------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `image-classifier` | `classifier` | `image-classifier-fp16/classifier.fp16.onnx` | 8,162,917   | `d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9` |
| `ocsr-handdrawn`   | `encoder`    | `ocsr-handdrawn-fp32/encoder.onnx`           | 208,801,677 | `996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52` |
| `ocsr-handdrawn`   | `decoder`    | `ocsr-handdrawn-fp32/decoder_step.onnx`      | 107,017,280 | `cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197` |
| `ocsr-handdrawn`   | `vocab`      | `ocsr-handdrawn-fp32/vocab.json`             | 5,316       | `62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd` |

Every artifact URL is
`https://huggingface.co/spalax-dev/chemistry-draw-ocsr/resolve/main/<path>`; the
total is 323,987,190 B (309.0 MiB). `CHEMISTRY_MODEL_CATALOG` is a support
override and is never set by a release build; an unreadable/invalid override is
an actionable `500` on the model routes while Indigo keeps serving.

### 4.2 Manifest

`<model root>/manifest.json` is the source of truth for **loading** models. It
keeps `schema: 1` and the `models` map, and adds `catalog_version` at the top
level. Each catalog artifact becomes a `file` + `artifact_sha256` entry; the
provenance, license, thresholds and tensor contracts are copied from the catalog.
The classifier keeps its single-artifact entry; OCSR keeps the
`encoder`/`decoder`/`vocab` slots.

Loading validates, in order:

1. the file exists and its SHA-256 matches;
2. input/output names, shapes and dtypes match the graph;
3. `-1` is accepted as a dynamic axis; every other dimension must match exactly;
4. the vocabulary's `start_id` and `end_id` match the manifest, and
   `vocab_size` equals the decoder output's class axis (156);
5. every `zero_inputs` name is an actual graph input.

A missing file, checksum mismatch or contract mismatch is `503`, never a silent
fallback. The manifest is written last, through a temporary file and an atomic
rename, after every artifact verifies; a failed run never publishes a partial
manifest.

### 4.3 Download state machine

```text
idle ──POST /download──▶ downloading ──last artifact──▶ verifying ──manifest──▶ ready
  ▲                          │                              │
  │                          ├── cancel ──▶ cancelled       └── manifest failure ──▶ failed
  │                          └── network/disk/checksum ──▶ failed
  └──────── POST /download (retry/resume) ◀── cancelled/failed
```

- Preflight requires free space for `total_bytes - installed_bytes`; a shortfall
  is `failed` with required/available bytes and writes nothing.
- Per artifact: skip a matching final file; otherwise write `<path>.part` and
  resume with `Range: bytes=<length>-` and `Accept-Encoding: identity`. A `206`
  appends only when `Content-Range` starts at the requested offset; `200`/`416`
  truncate and restart.
- Verify the `.part` size and SHA-256, then install with an atomic rename. A
  mismatch deletes the `.part`, leaves the previous final file untouched and fails
  with path, expected and actual hash.
- Cancel is cooperative, accepted only while `downloading`; the `.part` is kept
  and the next run resumes from it. `verifying` is short and not cancellable
  (`409`).
- There is no automatic retry loop. `failed`/`cancelled` are terminal for that
  run; a new POST starts again.
- v1 has **no rollback**: a failed update can leave a mix of old and new
  artifacts until the next repair run.

## 5. Document, tab and format rules

The workflow contract lives in `docs/architecture.md` §5 and
`docs/planning/sequences/`; this is the part adopted from `main` 0.1.8 under
ADR 0009. The rules that must not be broken are:

| Command | Shortcut       | Target        | Writes                                         | Changes path                | Changes format |
| ------- | -------------- | ------------- | ---------------------------------------------- | --------------------------- | -------------- |
| Save    | `Ctrl+S`       | active tab    | `.ket` to `path` (or Save As) + clean snapshot | on first save               | no             |
| Save As | `Ctrl+Shift+S` | active tab    | `.ket` to the chosen path + clean snapshot     | yes                         | no             |
| Export  | —              | active tab    | one other format to a file                     | **no**                      | **no**         |
| New     | `Ctrl+N`       | reused or new | the target tab's clean snapshot                | `null` on a new/reused tab  | stays `ket`    |
| Open…   | `Ctrl+O`       | reused or new | the tab's clean snapshot                       | the `.ket` path             | stays `ket`    |
| Import… | —              | reused or new | the tab's clean snapshot                       | `null` (imported structure) | stays `ket`    |

- `.ket` is the only document format and it is unchanged by the 1.x update.
  Export is the sole route to Molfile V2000/V3000, SMILES, InChI, SVG and PNG.
- Opening a `.mol`, `.smi`, `.sdf`, `.rxn` or other structure format imports it
  through `ketcher.setMolecule`; the tab keeps the source base name, has no
  backing path (`path: null`) and starts **clean**. Its first Save is a Save As
  prefilled `<name>.ket`. Open… accepts `.ket` only and adopts the path. The
  imported structure is serialized back to KET for its snapshot, so it restores
  on the next launch.
- Export images use `ketcher.generateImage(ket, { outputFormat })`;
  `exportImage` is not used because it supports only SVG, while `generateImage`
  covers both formats.
- The window title and dialog copy use the active tab's title: the base name
  without `.ket` (`benzene`), then `name`, then `Untitled`, plus `*` while dirty
  (`benzene*`). The strip paints a dot instead of the asterisk.
- **One editor, many tabs.** A tab is file state (`id`, `name`, `path`, committed
  `ket`, `dirty`) over the single mounted editor. Switching serializes the
  outgoing tab (`getKet`), flushes its snapshot, sets a loading flag, loads the
  incoming tab (`setMolecule`) and clears the flag. Change events during the
  load are ignored. A load never mounts a second editor, a per-tab toolbar or a
  second canvas.
- **A path belongs to at most one tab.** `pathKey` normalizes separators and a
  trailing separator; Windows drive-letter paths compare case-insensitively,
  POSIX paths case-sensitively. Open… and a recent entry that hit an open path
  activate that tab and show the **Already open** notice; Save As refuses a path
  owned by another tab. No file is read or written on a refusal.
- **Recovery snapshots are per tab:** `<appDataDir>/recovery/tabs/<id>.ket`
  (structure), `<id>.json` (`{ name, path, savedAt, dirty }`, written last) and
  `index.json` (`{ order, activeId }`, written last after structural changes).
  A `.ket` without matching metadata is never restored.
- Autosave schedules only the active tab (about 2 s debounce plus a 30 s
  interval), never while clean, never clears `dirty` and never touches `path`.
  A tab switch flushes the outgoing tab immediately. Save/Open/New rewrite the
  target tab's snapshot with `dirty: false` so the set restores; only a tab
  close or Discard clears snapshot files, metadata first.
- Launch restores the tab set silently: content, names, paths, order, dirty
  flags and the active id come back as they were. A missing, unreadable or
  invalid snapshot drops that tab; with no surviving tab launch yields one
  empty tab. A missing original file is not an error and the first Save recreates
  it. There is no recovery prompt and no index migration.
- **Close guard:** no dirty tab → close. Exactly one dirty active tab → Save /
  Discard / Cancel. Exactly one dirty inactive tab, or more than one dirty tab →
  Discard / Cancel only. Discard stops autosave, deletes the dirty snapshots,
  rewrites `index.json` with the survivors and destroys the window; clean tabs
  keep restoring. Save As cancellation aborts the close. `window.destroy()`
  bypasses the guard. A single tab's X/middle click closes a clean tab directly
  or prompts for that tab; closing the last tab leaves one fresh empty tab.
- **Backstage:** a full-window in-app overlay above the strip and Ketcher, not a
  route or a second window. Every launch opens on **Welcome**; a home button
  reopens it and the rail's **Back to editor** or `Escape` closes it. Opening or
  closing it never saves, activates a tab or calls `setMolecule`. Rail sections:
  - **Welcome** — Blank canvas, Import structure…, Open project…, four random
    cards from Ketcher's real Structure Library with Indigo-rendered previews,
    More templates, and the Recent structures table.
  - **Open** — the same Recent structures table with Remove, then the open tabs.
  - **Models** — 1.x keeps the real Models dialog and toolbar entry as the model
    setup surface; the rail button calls the App's `onOpenModels` and raises the
    real dialog above the overlay, and it never renders a fake model list or a
    mock counter.
  - **About** — app/Ketcher/React versions, Indigo version and sidecar port,
    platform, runtime and license links.
- **File menu:** New, Open…, Import…, Save, Save As…, Export… and up to 10
  recent documents. Ketcher's native Save As is hidden (it defaults to Molfile);
  native Open stays visible as "load into the current canvas". The app's
  document shortcuts are capture-phase and stop Ketcher from seeing them:
  `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O`, `Ctrl+N`, `Ctrl+W`, `Ctrl+T` and
  `Ctrl+Tab`. `Ctrl+W` closes the active tab and `Ctrl+Tab` cycles the strip.
  A matched combination is always swallowed; its command is skipped while a
  dialog, the backstage, the Models setup or a running save owns the app.
- **Command surface:** the File menu is complete. The 1.x toolbar keeps Save,
  New, Export and Models as a second entry point to the same tab-aware commands;
  Models opens the real setup dialog. Errors use the in-app `ErrorDialog` and
  `NoticeDialog`, never a native message box.
- **Recent documents:** `localStorage["chemistry-draw.recent"]`, absolute `.ket`
  paths, newest first, deduplicated and capped at 10. Recorded on a successful
  Open…, Save and Save As; a missing entry is pruned with an in-app error and
  never creates a tab. Unavailable or full storage degrades to an in-memory list
  for the session (or no list when unavailable).
- The aliased `file-saver` routes a `.ket` blob to document save and every other
  extension to the export dialog, leaving the tab's `path` and `format`
  untouched.
- **Browser fallback** (`pnpm dev` without Tauri): tabs live in memory, with no
  autosave, restore or close guard; Open/Import cannot pick a file; Save/Export
  download; the recent list still uses `localStorage`.

## 6. Host contracts

### 6.1 Tauri commands

| Command       | Request | Response         | Contract                                                             |
| ------------- | ------- | ---------------- | -------------------------------------------------------------------- |
| `indigo_port` | none    | number (`u16`)   | The port the sidecar reported; the webview builds `api_path` from it |
| `log_dir`     | none    | string or `null` | The app log directory, for support workflows                         |

These are the only custom commands. Everything else goes through plugins.

### 6.2 Capabilities

`src-tauri/capabilities/default.json` is the single source of truth for what the
webview may do. It grants `core:default`, window title/destroy, opener, dialog,
fs, log, the sidecar shell execute/spawn/kill/stdin and these fs scopes:

| Scope         | Grants                                | Why                                                                                            |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `$APPDATA/**` | the app data directory                | Per-tab snapshots (`recovery/tabs/`) and previews are written without a dialog                 |
| `$HOME/**`    | the user's home directory recursively | A document reopened in a later session, or restored from a snapshot, is saved without a dialog |
| runtime       | one picked file/directory             | Dialog `open`/`save` grants that path for the session                                          |

The fs commands are listed explicitly (`readTextFile`, `writeTextFile`,
`readFile`, `writeFile`, `mkdir`, `rename`, `remove`, `stat`, `exists`). Scope
entries grant no command on their own. A new scope or command needs a
justification in `docs/architecture.md` §5.6.1 and the capability contract test.

### 6.3 Host ↔ sidecar process

| Channel     | Contract                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn       | Tauri shell sidecar `indigo-server`; the host picks a free preferred port (default 9321) before spawning                                                                                                                                                                                                 |
| Environment | `INDIGO_PORT`; `CHEMISTRY_MODELS_DIR` (an explicit host value wins, otherwise debug `<repo>/models` and release `<app_data>/models`); `ORT_DYLIB_PATH` (debug `.ort/<platform>/` when present, otherwise the bundled copy; release bundled only); `LD_LIBRARY_PATH` (Linux) / prepended `PATH` (Windows) |
| Stdout      | The line `INDIGO_PORT=<actual>` is parsed and stored; the rest is forwarded to the log with ANSI stripped                                                                                                                                                                                                |
| Stderr      | Forwarded to the log at warn level                                                                                                                                                                                                                                                                       |
| Exit        | `Terminated` drops the child handle; the host kills the child on app exit                                                                                                                                                                                                                                |
| Watchdog    | The sidecar exits on stdin EOF (host died) and, on Unix, on a parent-PID change. `INDIGO_NO_PARENT_WATCHDOG=1` disables it                                                                                                                                                                               |

The host must never link or call Indigo/ONNX. The sidecar must keep serving
Indigo when no model or runtime is installed.

### 6.4 Sidecar ↔ native

- **Indigo:** `ffi/indigo.rs` binds the C API and owns session/handle lifetime.
  `unsafe` is confined to `ffi/`. A native error becomes `AppError::Internal` (or
  `BadRequest` when Indigo rejects the input).
- **ONNX Runtime:** loaded dynamically through `ort`'s `load-dynamic`; no
  link-time dependency and no `OrtGetApiBase` symbol in the binary. CPU only, one
  intra-op thread, sessions created lazily and cached for the process lifetime.

## 7. Compatibility rules

- Additive changes are allowed: new optional fields, new endpoints, a new model
  key in the manifest.
- Removing or renaming a field, changing an error status, or changing a
  preprocessing pipeline is breaking: it needs an ADR, a docs update and the
  affected tests in the same activity.
- Consumers ignore unknown fields. The manifest loader ignores unknown top-level
  fields such as `catalog_version`; status parsers accept extra fields.
- A contract change updates this document **and** the detailed section in
  `docs/architecture.md`, plus the contract tests and manual checks.
- Ketcher compatibility is version-bound: a Ketcher upgrade must re-check the
  `imago/uploads` protocol, the option-store adapter, the toolbar hooks, the tab
  switching API (`getKet`/`setMolecule`/`changeEvent`), the template providers
  and the patch contract before the dependency moves.
- The backstage/tab workflow is a 1.x UI contract. New UI must keep the real
  Models dialog reachable and must not expose two command surfaces for the same
  file action: the File menu owns New/Open/Import/Save/Save As/Export.

## 8. Ownership and review

- **Sidecar API and model contracts:** owned by the 1.x integration line; a
  change is reviewed against the webview consumer (`src/modelSetup.ts`,
  `src/App.tsx`) and the tests in `src-tauri/sidecar/src/tests/`.
- **Document and tab contract:** owned by the frontend; a change is reviewed
  against `src/document.ts`, `src/tabs.ts`, `src/tabStore.ts`,
  `src/saveRoute.ts`, `src/autosave.ts` and their Vitest suites.
- **Backstage and File menu contract:** owned by the frontend; a change is
  reviewed against `src/backstage.ts`, `src/fileMenu.ts`, `src/recent.ts`,
  `src/recentStructures.ts`, `src/ui/Backstage.tsx`, `src/ui/TabStrip.tsx`,
  `src/ui/FileMenu.tsx` and their Vitest suites, with the ML toolbar/Models
  entry still reachable.
- **Host process contract:** owned by the Tauri host; a change is reviewed
  against `src-tauri/src/lib.rs` and the packaged clean-install check.
- **Ketcher patch:** owned by whoever bumps Ketcher; each hunk cites its upstream
  origin and removal plan (`docs/planning/adr/0005-ketcher-parametrizeurl-patch.md`).

## 9. Open questions

- `dialog:allow-message` is granted in the capability file but no `src/` caller
  uses `message()`, and the conventions forbid it for in-app errors. Remove the
  grant, or document the one allowed native-message case.
- The `413` plain-text body forces the UI to parse a JSON error and fall back to
  size copy. Whether to replace it with a JSON `413` (and how) is undecided; it
  would change a documented exception.
- The confidence threshold `0.901` is provisional. Calibrating it on real
  Chemistry Draw inputs is a model-quality decision, not a code tweak, and needs
  the measured evidence plus a docs/manifest update.
- The backstage **Models** rail entry and the 1.x Models toolbar dialog are the
  same capability. Which surface opens the real dialog (or whether the rail entry
  is kept at all) is settled by the ACT-05 App/toolbar integration; the rail must
  not ship the placeholder list or a mock counter in the meantime.
