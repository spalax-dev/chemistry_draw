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

echo "==> Building .deb, .rpm and AppImage inside Docker (one pass)..."

docker run --rm \
  -e CARGO_NET_OFFLINE=${CARGO_NET_OFFLINE:-false} \
  --security-opt apparmor:unconfined \
  -v "$(pwd):/app" -w /app \
  -v cargo-registry:/usr/local/cargo/registry \
  -v cargo-git:/usr/local/cargo/git \
  -v cargo-target-cache:/app/target \
  -v pnpm-store:/root/.local/share/pnpm/store \
  chemistry-builder bash -e -c '
  cd /app

  mkdir -p src-tauri/lib/linux-x86_64/
  cp /opt/chemistry/libs/*.so* src-tauri/lib/linux-x86_64/

  # Never ship the C++ runtime: use the target distro libstdc++ instead
  # (newer and backward compatible).
  rm -f src-tauri/lib/linux-x86_64/libstdc++.so* \
        src-tauri/lib/linux-x86_64/libgcc_s.so*

  cargo build --release -p indigo-server --bin indigo-server --bin imago-worker
  cp target/release/indigo-server target/release/indigo-server-x86_64-unknown-linux-gnu
  cp target/release/imago-worker target/release/imago-worker-x86_64-unknown-linux-gnu

  pnpm install --frozen-lockfile --prefer-offline
  rm -rf target/release/bundle
  NO_STRIP=1 pnpm tauri build --bundles deb,rpm

  bash scripts/make-appimage.sh /app/dist-packages

  # The libs above were copied into the bind-mounted source tree; keep only the
  # tracked ones so the host checkout stays clean.
  find src-tauri/lib/linux-x86_64 -maxdepth 1 \( -type f -o -type l \) \
    ! -name 'libimago.so' ! -name 'libindigo.so' ! -name 'libindigo-renderer.so' \
    -delete

  mkdir -p /app/dist-packages
  cp -v target/release/bundle/deb/*.deb /app/dist-packages/ 2>/dev/null || true
  cp -v target/release/bundle/rpm/*.rpm /app/dist-packages/ 2>/dev/null || true
'

echo "==> Done."
echo "---"
mkdir -p dist-packages
ls -lh dist-packages/ 2>/dev/null || true
