# 0003 — Load ONNX Runtime dynamically

- **Status:** accepted
- **Date:** 2026-11-21 (reconstructed from the code on 2026-11-21; decided in B1 and activity 7)
- **Activity:** planning reconstruction (pre-development)
- **Deciders:** Repository owner

## Context

The 1.x line needs CPU inference for two models but must not turn into a machine
learning distribution. The constraints were:

- the app is a desktop editor, not a Python environment;
- installers must stay small and the runtime must not drag in OpenSSL;
- Indigo must keep working when inference is unavailable;
- the support floor is glibc 2.36 (set by `libindigo.so`), and ONNX Runtime 1.31
  itself needs only glibc 2.28 / GLIBCXX 3.4.22;
- ONNX Runtime's GitHub 1.31.0 release assets disappeared (404), so the pinned
  source had to move without changing the shipped binary.

The sidecar already links native Indigo. A second link-time dependency could fail
at process start and take Indigo down with it.

## Decision

Use `ort` 2.0.0-rc.15 with `default-features = false`, features `std`, `api-31`
and `load-dynamic`, and:

1. **Never link** `libonnxruntime`: no NEEDED entry, no `OrtGetApiBase` symbol.
2. Resolve the library at runtime through `ORT_DYLIB_PATH`. The host sets it to
   the developer `.ort/<platform>/` copy in debug (when present), otherwise to
   the bundled `lib/<platform>/` copy; release uses the bundled copy only.
3. Drop `ORT_DYLIB_PATH` when no library exists. The sidecar keeps serving Indigo
   and the classifier/OCSR routes answer `503` with an actionable message.
4. **Ship** the pinned runtime 1.31.0 on Linux and Windows: the Linux builder
   image extracts and verifies it, and `scripts/fetch-windows-libs.ps1` does the
   same for the DLL. The pinned source is the official
   `Microsoft.ML.OnnxRuntime` 1.31.0 NuGet package; the extracted Linux library is
   byte-identical to the previously shipped `.so.1.31.0`.
5. CPU execution provider only, one intra-op thread, telemetry disabled, lazy
   sessions cached for the process lifetime.

## Alternatives considered

| Alternative                                  | Why not                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Link ONNX Runtime at build time              | A missing/mismatched library would prevent the sidecar from starting and take Indigo down |
| Bundle no runtime and require a user install | Breaks the promise that recognition works after the model download; support burden        |
| Use a Python/Torch sidecar                   | Hundreds of MB, a second runtime and its dependency tree, no benefit on CPU               |
| Run ONNX in the webview via WASM             | Reintroduces the browser-inference path the native sidecar exists to avoid                |
| Keep the GitHub release tarball              | The 1.31.0 assets are gone; the NuGet package is the same binary and is still available   |
| Use the PyPI wheel's shared library          | It is a different build, not byte-identical to the pinned runtime                         |

## Consequences

- **Positive:** Indigo availability is independent of inference; `ldd` shows no
  `libonnxruntime`; the resolver failure is a `503`, never a panic. Package
  growth is bounded: the measured `.deb` delta from 0.1.6 to activity 7 is
  11,021,978 B compressed for a 29,345,384 B library.
- **Negative:** the runtime must be shipped and kept in sync with the `ort` API
  generation; a mismatched runtime is a load failure. The `.so.1`/`.so` symlink
  chain has to survive packaging, which is why `repack-native-payload.sh` exists.
- **Follow-up:** a runtime or `ort` bump is an ADR-worthy decision; verify the
  chain, the `ldd` cleanliness, the `503` fallback and the packaged clean-install
  smoke in the same change.

## References

- `docs/planning/architecture.md` §7 "Runtime" and §8 "Native libraries".
- `docs/DEVELOPMENT.md` "ONNX Runtime (inference runtime)".
- `scripts/fetch-onnxruntime.sh`, `scripts/fetch-windows-libs.ps1`,
  `scripts/build-libs.sh`, `scripts/repack-native-payload.sh`.
- Related ADRs: 0004 (model delivery).
