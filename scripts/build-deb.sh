#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Packaging builds share the same Docker volumes (cargo-target-cache) and the
# same target/release/bundle path, so concurrent runs delete each other's
# temporary files. Serialize them.
LOCK_FILE="${TMPDIR:-/tmp}/chemistry-draw-packaging.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "==> Another packaging build is running; waiting for it to finish..."
  if ! flock -w 1800 9; then
    echo "==> Timed out waiting for the packaging lock ($LOCK_FILE)."
    exit 1
  fi
fi

docker image inspect chemistry-builder &>/dev/null || bash scripts/build-image.sh

echo "==> Building .deb inside Docker..."

docker run --rm \
  -v "$(pwd):/app" -w /app \
  -v cargo-registry:/usr/local/cargo/registry \
  -v cargo-git:/usr/local/cargo/git \
  -v cargo-target-cache:/app/target \
  -v pnpm-store:/root/.local/share/pnpm/store \
  chemistry-builder bash -e -c '
  cd /app

  # The libs are copied into the bind-mounted source tree, so snapshot the host
  # state first and restore it on exit: packaging never mutates the checkout
  # and never bundles host leftovers.
  LIB_DIR=/app/src-tauri/lib/linux-x86_64
  LIB_SNAPSHOT=$(mktemp -d)
  if [ -d "$LIB_DIR" ]; then cp -a "$LIB_DIR/." "$LIB_SNAPSHOT/"; fi
  restore_libs() {
    find "$LIB_DIR" -mindepth 1 -maxdepth 1 -delete 2>/dev/null || true
    mkdir -p "$LIB_DIR"
    cp -a "$LIB_SNAPSHOT/." "$LIB_DIR/" 2>/dev/null || true
  }
  trap restore_libs EXIT

  mkdir -p "$LIB_DIR"
  find "$LIB_DIR" -mindepth 1 -maxdepth 1 -delete
  cp -a /opt/chemistry/libs/*.so* "$LIB_DIR/"
  bash scripts/check-native-libs.sh --allowlist /opt/chemistry/libs /opt/chemistry/libs "$LIB_DIR"

  # Never ship the C++ runtime: use the target distro libstdc++ instead
  # (newer and backward compatible).
  rm -f src-tauri/lib/linux-x86_64/libstdc++.so* \
        src-tauri/lib/linux-x86_64/libgcc_s.so*

  cargo build --release -p indigo-server --bin indigo-server
  cp target/release/indigo-server target/release/indigo-server-x86_64-unknown-linux-gnu

  pnpm install --frozen-lockfile --prefer-offline
  rm -rf target/release/bundle
  NO_STRIP=1 pnpm tauri build --bundles deb

  for pkg in target/release/bundle/deb/*.deb; do
    bash scripts/repack-native-payload.sh deb "$pkg"
  done

  mkdir -p /app/dist-packages
  cp -v target/release/bundle/deb/*.deb /app/dist-packages/ 2>/dev/null || true
'

echo "==> Done."
mkdir -p dist-packages
ls -lh dist-packages/*.deb 2>/dev/null || true
