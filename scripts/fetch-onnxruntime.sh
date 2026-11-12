#!/usr/bin/env bash
# Fetch the pinned ONNX Runtime shared library for local development and tests.
#
# The sidecar loads ONNX Runtime dynamically (`ort` with `load-dynamic`) and B1
# never links or bundles it. This script downloads the pinned upstream release,
# verifies its SHA-256 and extracts only the shared library chain
# (`libonnxruntime.so -> libonnxruntime.so.1 -> libonnxruntime.so.1.31.0`) into
# the gitignored `.ort/linux-x86_64/` directory.
#
# Model weights are separate: they live in `models/` and are never downloaded
# here. Shipping the runtime is a follow-up activity; this is a dev tool.
#
# Usage: scripts/fetch-onnxruntime.sh (idempotent)
set -euo pipefail

VERSION="1.31.0"
ARCHIVE="onnxruntime-linux-x64-${VERSION}.tgz"
URL="https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/${ARCHIVE}"
SHA256="cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/.ort/linux-x86_64"
ARCHIVE_ROOT="onnxruntime-linux-x64-${VERSION}"

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
TMP_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/onnxruntime-${VERSION}.XXXXXX.tgz")"
cleanup() {
  rm -f -- "${TMP_ARCHIVE}"
}
trap cleanup EXIT

echo "Downloading ONNX Runtime ${VERSION} from ${URL}"
if ! curl --fail --silent --show-error --location --retry 3 --output "${TMP_ARCHIVE}" "${URL}"; then
  echo "fetch-onnxruntime: download failed." >&2
  echo "  Check network access to github.com and retry: scripts/fetch-onnxruntime.sh" >&2
  exit 1
fi

ACTUAL_SHA256="$(sha256sum "${TMP_ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${SHA256}" ]]; then
  echo "fetch-onnxruntime: checksum mismatch for ${ARCHIVE}" >&2
  echo "  expected ${SHA256}" >&2
  echo "  actual   ${ACTUAL_SHA256}" >&2
  echo "  Refusing to extract the archive." >&2
  exit 1
fi

MEMBERS=(
  "${ARCHIVE_ROOT}/lib/libonnxruntime.so"
  "${ARCHIVE_ROOT}/lib/libonnxruntime.so.1"
  "${ARCHIVE_ROOT}/lib/libonnxruntime.so.${VERSION}"
)
if ! tar --extract --gzip --file "${TMP_ARCHIVE}" --directory "${TARGET_DIR}" \
  --strip-components=2 "${MEMBERS[@]}"; then
  echo "fetch-onnxruntime: ${ARCHIVE} does not contain lib/libonnxruntime.so*" >&2
  exit 1
fi

if [[ ! -f "${SO_REAL}" || ! -e "${SO_MAJOR}" || ! -e "${SO_LINK}" ]]; then
  echo "fetch-onnxruntime: extraction did not produce the shared library chain" >&2
  echo "  expected ${SO_LINK} -> ${SO_MAJOR} -> ${SO_REAL}" >&2
  exit 1
fi

echo "Installed ONNX Runtime ${VERSION} in ${TARGET_DIR}"
echo "Set ORT_DYLIB_PATH=${SO_LINK} (the harness and the debug host do it for you)."
