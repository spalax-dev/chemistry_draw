#!/usr/bin/env bash
set -euo pipefail
# Bundles all transitive .so dependencies for the sidecar into lib/linux-x86_64/
# so .deb and AppImage packages work on Debian 12 / Ubuntu 22.04+ without system OpenCV.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$PROJECT_DIR/src-tauri/lib/linux-x86_64"
TMP_PROCESSED=$(mktemp)

cleanup() { rm -f "$TMP_PROCESSED"; }
trap cleanup EXIT

# Libraries we skip (available on any modern Linux)
SKIP_PATTERNS=(
  ^libc\.so\.
  ^libm\.so\.
  ^libgcc_s\.so\.
  ^libz\.so\.
  ^libdl\.so\.
  ^libpthread\.so\.
  ^librt\.so\.
  ^libGL\.so\.
  ^libGLdispatch\.
  ^libGLX\.
  ^libX11\.
  ^libxcb\.
  ^libXau\.
  ^libXdmcp\.
  ^linux-vdso\.
  ^ld-linux\.
)

should_skip() {
  local name="$1"
  local pat
  for pat in "${SKIP_PATTERNS[@]}"; do
    if [[ "$name" =~ $pat ]]; then return 0; fi
  done
  return 1
}

copy_recursive() {
  local lib="$1"
  local name
  name=$(basename "$lib")

  # Already processed this name?
  grep -qxF "$name" "$TMP_PROCESSED" 2>/dev/null && return
  echo "$name" >> "$TMP_PROCESSED"

  # Skip standard system libs
  if should_skip "$name"; then
    return
  fi

  if [[ ! -f "$lib" ]]; then
    echo "  WARNING: $lib not found, skipping" >&2
    return
  fi

  # Copy if not already present
  if [[ ! -f "$LIB_DIR/$name" ]]; then
    echo "  bundling $name"
    cp -n "$lib" "$LIB_DIR/$name"
  fi

  # Recurse into dependencies
  ldd "$lib" 2>/dev/null | grep "=> /" | awk '{print $3}' | while read -r dep; do
    copy_recursive "$dep"
  done
}

echo "==> Bundling shared library dependencies into $LIB_DIR"

# Start from our own libs and imago
copy_recursive "$LIB_DIR/libindigo.so"
copy_recursive "$LIB_DIR/libindigo-renderer.so"
copy_recursive "$LIB_DIR/libimago.so"

# Set RPATH para que linuxdeploy resuelva dependencias entre .so
echo "==> Setting RPATH on bundled libraries..."
for f in "$LIB_DIR"/*.so*; do
  patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
done

echo "==> Done. Libraries in $LIB_DIR:"
ls -1 "$LIB_DIR"/
