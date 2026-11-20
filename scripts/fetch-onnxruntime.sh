#!/usr/bin/env bash
# Fetch the pinned ONNX Runtime shared library for local development and tests.
#
# The sidecar loads ONNX Runtime dynamically (`ort` with `load-dynamic`) and
# never links it. Release packages ship their own copy (Linux: the builder
# image via `task libs`/packages; Windows: scripts/fetch-windows-libs.ps1);
# this script only provides the developer override used by the harness and the
# debug host. The upstream GitHub 1.31.0 release asset is gone (404), so the
# pinned source is the official Microsoft.ML.OnnxRuntime NuGet package, which
# carries the same Linux shared library. The script verifies the package and
# the extracted library SHA-256, then recreates the shared library chain
# (`libonnxruntime.so -> libonnxruntime.so.1 -> libonnxruntime.so.1.31.0`) in
# the gitignored `.ort/linux-x86_64/` directory. A `.nupkg` is a zip archive;
# do not substitute the PyPI wheel, whose library is a different build.
#
# Model weights are separate: they live in `models/` and are never downloaded
# here. They are not bundled with the app.
#
# Usage: scripts/fetch-onnxruntime.sh (idempotent)
set -euo pipefail

VERSION="1.31.0"
PACKAGE="microsoft.ml.onnxruntime.${VERSION}.nupkg"
URL="https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${VERSION}/microsoft.ml.onnxruntime.${VERSION}.nupkg"
SHA256="7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b"
MEMBER="runtimes/linux-x64/native/libonnxruntime.so"
LIB_SHA256="469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/.ort/linux-x86_64"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) ;;
  *)
    echo "fetch-onnxruntime: only Linux x86_64 is supported by this script." >&2
    echo "  Host: $(uname -s) $(uname -m)." >&2
    echo "  Windows developers place the pinned onnxruntime.dll under" >&2
    echo "  .ort/windows-x86_64/ and set ORT_DYLIB_PATH to it." >&2
    exit 1
    ;;
esac

SO_REAL="${TARGET_DIR}/libonnxruntime.so.${VERSION}"
SO_MAJOR="${TARGET_DIR}/libonnxruntime.so.1"
SO_LINK="${TARGET_DIR}/libonnxruntime.so"

if [[ -f "${SO_REAL}" && -e "${SO_MAJOR}" && -e "${SO_LINK}" ]]; then
  echo "ONNX Runtime ${VERSION} already present in ${TARGET_DIR}"
  exit 0
fi

mkdir -p "${TARGET_DIR}"
TMP_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/onnxruntime-${VERSION}.XXXXXX.nupkg")"
cleanup() {
  rm -f -- "${TMP_ARCHIVE}"
}
trap cleanup EXIT

echo "Downloading ONNX Runtime ${VERSION} from ${URL}"
if ! curl --fail --silent --show-error --location --retry 3 --output "${TMP_ARCHIVE}" "${URL}"; then
  echo "fetch-onnxruntime: download failed." >&2
  echo "  Check network access to api.nuget.org and retry:" >&2
  echo "  scripts/fetch-onnxruntime.sh" >&2
  exit 1
fi

ACTUAL_SHA256="$(sha256sum "${TMP_ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${SHA256}" ]]; then
  echo "fetch-onnxruntime: checksum mismatch for ${PACKAGE}" >&2
  echo "  expected ${SHA256}" >&2
  echo "  actual   ${ACTUAL_SHA256}" >&2
  echo "  Refusing to extract the package." >&2
  echo "  If the pin changed, move URL, MEMBER, SHA256 and LIB_SHA256 together in" >&2
  echo "  scripts/fetch-onnxruntime.sh and the contract in" >&2
  echo "  scripts/lib/onnx-runtime-packaging.test.mjs." >&2
  exit 1
fi

# A .nupkg is a zip archive: extract the single Linux runtime member.
if ! python3 - "${TMP_ARCHIVE}" "${SO_REAL}" "${MEMBER}" <<'PY'
import sys
import zipfile

archive, destination, member = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(archive) as package:
    with package.open(member) as source, open(destination, "wb") as target:
        target.write(source.read())
PY
then
  echo "fetch-onnxruntime: ${PACKAGE} does not contain ${MEMBER}" >&2
  rm -f -- "${SO_REAL}"
  exit 1
fi

ACTUAL_LIB_SHA256="$(sha256sum "${SO_REAL}" | awk '{print $1}')"
if [[ "${ACTUAL_LIB_SHA256}" != "${LIB_SHA256}" ]]; then
  echo "fetch-onnxruntime: checksum mismatch for ${MEMBER}" >&2
  echo "  expected ${LIB_SHA256}" >&2
  echo "  actual   ${ACTUAL_LIB_SHA256}" >&2
  echo "  Refusing to use an unverified ONNX Runtime library." >&2
  echo "  If the pin changed, move URL, MEMBER, SHA256 and LIB_SHA256 together in" >&2
  echo "  scripts/fetch-onnxruntime.sh and the contract in" >&2
  echo "  scripts/lib/onnx-runtime-packaging.test.mjs." >&2
  rm -f -- "${SO_REAL}"
  exit 1
fi

ln -sfn "libonnxruntime.so.${VERSION}" "${SO_MAJOR}"
ln -sfn "libonnxruntime.so.1" "${SO_LINK}"

if [[ ! -f "${SO_REAL}" || ! -e "${SO_MAJOR}" || ! -e "${SO_LINK}" ]]; then
  echo "fetch-onnxruntime: extraction did not produce the shared library chain" >&2
  echo "  expected ${SO_LINK} -> ${SO_MAJOR} -> ${SO_REAL}" >&2
  exit 1
fi

echo "Installed ONNX Runtime ${VERSION} in ${TARGET_DIR}"
echo "Set ORT_DYLIB_PATH=${SO_LINK} (the harness and the debug host do it for you)."
