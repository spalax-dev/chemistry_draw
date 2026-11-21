# Chemistry Draw — Overview

> The foundation document for the 1.x line. Everything else in `docs/planning/`
> builds on this.

## 1. What it is

Chemistry Draw is an **offline-first desktop chemical structure editor**: a Tauri
v2 shell around EPAM's Ketcher React editor, backed by a native Rust sidecar that
serves the Indigo v2 HTTP API from EPAM's C++ libraries. It exists so that a
chemist, teacher or student can draw molecules, reactions and macromolecules,
save a real document and turn a picture of a structure into an editable molecule
**without an account, a cloud service or a network connection**.

It is an unofficial community packaging of Ketcher (Apache 2.0), not an EPAM
product. The app bundles no Imago and no OpenCV: recognition is a local ONNX
pipeline (a binary structure filter plus a hand-drawn OCSR model) whose weights
are downloaded explicitly on first use.

The foundation describes the **1.x integration line** (`develop`). The separate
**0.x support line** (`main`) is summarized in section 6 but is not modelled here.
The technical shape is in [`architecture.md`](architecture.md); the promises
between the parts are in [`contracts.md`](contracts.md).

## 2. Intended users (working assumptions)

The evidence is the product itself: the installer category is `Education`, the
README targets people drawing structures, and the document model is a
word-processor-like one-document-per-window editor. The four groups below are
**working assumptions**, not researched personas; “personas” here simply means
the target user profiles. Confirm or replace them before UX stories rely on
them.

| Actor                          | Needs                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Chemistry student or teacher   | Draw and label structures quickly, keep a `.ket` document, export a picture or molfile for an assignment    |
| Bench or computational chemist | Draw or correct a structure offline, convert between formats, get a starting structure from a photo or scan |
| Occasional user                | Open a `.ket` file from a colleague, edit it, save it back without installing a chemistry platform          |
| Contributor or packager        | Build the sidecar and native libraries, run the harness, produce `.deb`/`.rpm`/AppImage/NSIS artifacts      |

## 3. Goals

- **Offline and private by default.** Drawing, Indigo operations, recognition and
  document handling run on the user's machine. Only the opt-in model download
  touches the network, and it only fetches model files.
- **Native chemistry, not a browser approximation.** Indigo and Indigo Renderer
  run in a local sidecar over C FFI, so conversion, layout, rendering and
  validation match the native library.
- **A real document format.** Save writes `.ket` only; Export is the single route
  to Molfile, SMILES, InChI, SVG and PNG and never changes the document.
- **Recognition that is honest about its limits.** The filter is binary, the OCSR
  model is a single hand-drawn compromise, and an unfinished decode is an error,
  never a truncated structure.
- **Small installers.** No model weights are bundled; a clean install downloads
  ~324 MB (323,987,190 B) only when the user asks.
- **A supportable desktop product.** Rotating logs, a health endpoint, checksummed
  models and a documented clean-install state.

## 4. Non-goals

- Online accounts, telemetry, cloud sync or a hosted recognition service.
- Reimplementing Ketcher's editor UI or editing its published bundles outside the
  documented patches.
- Shipping prebuilt native binaries or model weights in git.
- Shipping Imago, OpenCV, Python, TensorFlow or a GPU inference path.
- Supporting glibc below 2.36 or webkit2gtk below 4.1. **macOS is out of scope
  for now** (no package or CI); Android is a possible future target, not planned.
- Multi-molecule counting and reaction detection in the recognition UX. The
  filter cannot do either, and the copy must not promise it.

A non-goal is a decision, not a backlog item. If it becomes one later, it enters
`BACKLOG.md` as a story, not as an unannounced change.

## 5. Success

The foundation is successful when:

- a new contributor can explain the shell, the sidecar, the model pipeline and
  the two release lines after reading `docs/planning/`;
- a story can be decomposed without inventing architecture or contracts;
- every boundary between the webview, the host, the sidecar, Indigo, ONNX Runtime
  and Hugging Face is written down in `docs/planning/contracts.md`;
- the reconstructed documents agree with the code, and any disagreement is
  recorded rather than quietly fixed.

## 6. The two lines

Chemistry Draw maintains two lines. They are both real, they are not the same
product generation, and they must not be cross-merged by accident.

| Line      | Version | Role                                               | Content                                                                                                                 |
| --------- | ------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `main`    | 0.x     | Maintenance/support for the builds users run today | Backstage/file workflow, tabs, the E1 Ketcher/Indigo/language upgrade, releases                                         |
| `develop` | 1.x     | Integration line for the next generation           | Imago-free native Indigo sidecar, B1 ONNX filter, B2 OCSR, B3 model delivery, Phase D parity work, NuGet runtime source |

Rules:

- Base a branch on its target line and merge it back to that line. E1 is
  `main`-only. A fix that both lines need is cherry-picked, not cross-merged.
- At the official launch the **1.x line updates from `main`** — the 0.1.8
  baseline, backstage/file workflow, build layout and release policy — and cuts
  1.0.0. The detailed unification ADR is written at launch, not by a background
  merge before it.

This foundation models the 1.x line only. The 0.x line is recorded so the
boundary is explicit, not so its architecture is documented here.

## 7. Glossary

| Term               | Meaning                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Ketcher            | EPAM's React chemical editor (`ketcher-react` / `ketcher-core`), embedded in the webview and patched at install time                   |
| Indigo             | EPAM's C++ cheminformatics toolkit, used through a C FFI in the sidecar                                                                |
| Sidecar            | `indigo-server`, the Rust/axum process that serves `/v2/*` on `127.0.0.1`                                                              |
| `.ket`             | Ketcher's JSON document format; the only format Save writes                                                                            |
| Molfile V2000      | MDL connection table used by Export and by the recognition result                                                                      |
| OCSR               | Optical Chemical Structure Recognition: image to SMILES                                                                                |
| B1 / B2 / B3       | Roadmap phases: ONNX filter, OCSR pipeline plus the Recognize shim, model delivery and setup UI                                        |
| Catalog            | The model list compiled into the sidecar: provenance, URLs, sizes, SHA-256 values, licenses and tensor contracts                       |
| Manifest           | `<model root>/manifest.json`, generated by a successful download and the source of truth for loading models                            |
| Compatibility shim | `/v2/imago/uploads` and `/v2/imago/uploads/{id}`: Ketcher's hardcoded job protocol served by the local filter → OCSR → Indigo pipeline |
| Parity pilot       | The Phase D `pilot300` comparison of the shipped models against the toolchain's frozen predictions                                     |
| Line               | One of the two maintained branches (`main` 0.x support, `develop` 1.x integration)                                                     |

## 8. Open questions

- The final product identity (name, icon, bundle identifier, app-data path) is
  provisional and is **US-05, deferred**; it is independent of model delivery
  and no model change is involved. If the identity/app-data path changes, that is
  a separate packaging decision.
- macOS is **out of scope** (no package or CI); Android is a possible future
  target, not planned.
- The intended-user groups in §2 are working assumptions; confirm them before UX
  stories.
- At the official launch the 1.x line **updates from `main`** (0.1.8 baseline,
  backstage, layout and release policy) and cuts 1.0.0; the detailed unification
  ADR belongs to that launch.
