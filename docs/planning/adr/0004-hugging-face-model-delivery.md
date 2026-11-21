# 0004 — Deliver models from Hugging Face on demand

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code on 2026-11-21; decided in B3)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

The two model families total 323,987,190 B (~324 MB / 309 MiB): an 8 MB
classifier, a 208.8 MB encoder, a 107.0 MB decoder and a 5 KB vocabulary. Bundling
them would multiply every installer by roughly ten and force every user to pay for
a feature they may not use. Downloading at startup would surprise users, break
offline use of an otherwise offline app, and make the editor's first launch depend
on a network.

The models are third-party weights with their own licenses (MIT and CC-BY-4.0),
and the OCSR model in particular must not be silently replaced or partially
installed — a truncated decoder is worse than no recognition.

## Decision

Ship **no model weights** and deliver them through a sidecar-owned, opt-in
downloader:

1. **Bundled catalog.** `service/ml/model-catalog.json` + `catalog.rs` compile the
   catalog into the sidecar: provenance id, version, license, source, settings,
   artifact path/URL/size/SHA-256/role and tensor contracts. The catalog is the
   source of truth for what to download; `CHEMISTRY_MODEL_CATALOG` is a support
   override only.
2. **Release model root.** `<app_data>/models` is created by the host and passed
   as `CHEMISTRY_MODELS_DIR`; debug uses `<repo>/models` unless overridden.
3. **Opt-in download.** No startup path fetches anything. The four routes
   (`GET /v2/models`, `POST /download`, `POST /download/cancel`,
   `POST /verify`) expose status, install/repair/update, cooperative cancel and a
   read-only SHA-256 report. The client polls; there is no SSE or WebSocket.
4. **Integrity.** Each artifact streams to `<path>.part` with HTTP Range resume,
   is checked against the catalog size and SHA-256, and is installed with an
   atomic rename. The schema-1 `manifest.json` is written **last**, through a
   temporary file and an atomic rename, after every artifact verifies.
5. **Versioning.** `catalog_version` drives install, repair and forward update. A
   newer installed catalog is never downgraded (`409`); v1 has no rollback.
6. **Capability gating.** `/v2/info` advertises `imago_versions: ["local-ocsr"]`
   only when the manifest is usable and the required artifacts exist, so Ketcher
   keeps Recognize disabled on a clean install.
7. **First-run UI.** The conditional **Models** toolbar entry and in-app dialog
   explain the download, show families/sizes/progress/errors, keep Later
   available, and update Ketcher's option store in place when the install becomes
   ready — no remount, no canvas loss.

## Alternatives considered

| Alternative                                  | Why not                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bundle the weights in every installer        | ~+324 MB per artifact, every user pays for an optional feature                                                      |
| Download automatically at first launch       | Surprises users, breaks offline-first expectations, and makes drawing depend on the network                         |
| Separate model installer or manual file drop | Poor UX and easy to install a partial/corrupt set; the manifest contract would move outside the app                 |
| Host our own download service/CDN            | Extra service to operate; Hugging Face already hosts the pinned artifacts with stable URLs                          |
| Trust the downloaded files without hashes    | A corrupted or substituted model fails at inference time with no actionable cause; checksums make failure explicit  |
| Allow rollback to an older catalog           | v1 has no need for it and it complicates the manifest contract; a newer installed catalog is left untouched instead |

## Consequences

- **Positive:** installers stay ~30 MB on Linux and ~20 MB compressed without
  weights; a ready install stores 324 MB per user; the download is resumable,
  cancellable and verifiable; the app works fully offline for drawing and Indigo
  operations with or without models.
- **Negative:** the first recognition requires a network download and free disk
  space; a broken install needs the dialog or a repair run; there is no rollback;
  the catalog is bundled, so a new model version requires an app release (or the
  support override) rather than a server-side change.
- **Follow-up:** model updates and license attribution are tracked in `NOTICE`
  and the docs; a future rollback or delta-download design would be a new ADR.
  Calibration of the confidence threshold is ADR 0006.

## References

- `docs/planning/architecture.md` §7 "Model delivery (B3)".
- `docs/planning/contracts.md` §3.6 and §4.
- `docs/planning/sequences/model-setup.puml`.
- `docs/verification.md` §2 "Model delivery (B3)" and "Clean install (B3)".
- Related ADRs: 0003 (runtime), 0006 (OCSR model).
