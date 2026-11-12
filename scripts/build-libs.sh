#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="$(pwd)"
OUT_DIR="$PROJECT_DIR/build-libs/out"

echo "==> Clearing previous builds..."
rm -rf build-libs/out build-libs/backup
mkdir -p "$OUT_DIR" build-libs/backup

if ls src-tauri/lib/linux-x86_64/*.so* &>/dev/null; then
  cp -a src-tauri/lib/linux-x86_64/lib*.so* build-libs/backup/
  echo "   Backup saved to build-libs/backup/"
fi

# ----- Repo 1: Build Indigo -----
echo "==> Cloning Indigo..."
git clone --depth 1 https://github.com/epam/Indigo.git /tmp/indigo

echo "==> Building Indigo..."
mkdir -p /tmp/indigo/build
cd /tmp/indigo/build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_INDIGO_SERVICE=OFF \
  -DBUILD_INDIGO_WRAPPERS=OFF \
  -DBUILD_BINGO=OFF \
  -DBUILD_BINGO_ELASTIC=OFF
make -j"$(nproc)" indigo indigo-renderer

# ----- Extract results + transitive deps -----
echo "==> Copying .so files..."
cp /tmp/indigo/build/bin/libindigo.so "$OUT_DIR/"
cp /tmp/indigo/build/bin/libindigo-renderer.so "$OUT_DIR/"

for f in "$OUT_DIR"/libindigo.so "$OUT_DIR"/libindigo-renderer.so; do
  deps="$(LD_LIBRARY_PATH="$OUT_DIR" ldd "$f" 2>/dev/null \
    | awk '/=> \// {print $3}' | sort -u || true)"
  while read -r dep; do
    [ -z "$dep" ] && continue
    # Already produced by this build (e.g. libindigo-renderer -> libindigo.so).
    case "$dep" in "$OUT_DIR"/*) continue ;; esac
    name=$(basename "$dep")
    case "$name" in
      libc.so.*|libm.so.*|libgcc_s.so.*|libz.so.*| \
      libdl.so.*|libpthread.so.*|librt.so.*| \
      libGL*|libX11*|libxcb*|libXau*|libXdmcp*| \
      linux-vdso*|ld-linux*) continue ;;
    esac
    real=$(readlink -f "$dep")
    dir=$(dirname "$dep")
    [ "$dir" = "$OUT_DIR" ] && continue
    for link in "$dir"/lib*.so*; do
      [ -e "$link" ] || continue
      [ "$(readlink -f "$link" 2>/dev/null)" = "$real" ] || continue
      name=$(basename "$link")
      if [ -L "$link" ]; then
        # Copy the chain as relative symlinks: the builder's absolute links
        # (e.g. Debian's /lib -> /usr/lib) break once the directory lands on a
        # developer host or in a package.
        ln -sfn "$(basename "$real")" "$OUT_DIR/$name"
      else
        cp -a "$link" "$OUT_DIR/"
      fi
    done
  done <<< "$deps"
done

# ----- ONNX Runtime: shipped inference runtime -----
# The sidecar loads it dynamically through ORT_DYLIB_PATH, so the builder must
# provide the shared library next to the Indigo libs (the app itself has no
# link-time dependency). The archive is pinned and checksum-verified: never
# download-and-execute.
ORT_VERSION="1.31.0"
echo "==> Fetching ONNX Runtime ${ORT_VERSION}..."
ORT_ARCHIVE="onnxruntime-linux-x64-${ORT_VERSION}.tgz"
ORT_URL="https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz"
ORT_SHA256="cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57"
ORT_LIB_DIR="onnxruntime-linux-x64-${ORT_VERSION}/lib"
ORT_MEMBERS=(
  "${ORT_LIB_DIR}/libonnxruntime.so"
  "${ORT_LIB_DIR}/libonnxruntime.so.1"
  "${ORT_LIB_DIR}/libonnxruntime.so.${ORT_VERSION}"
)
ORT_TMP="$(mktemp -d)"
trap 'rm -rf "$ORT_TMP"' EXIT

curl -fsSL --retry 3 -o "$ORT_TMP/$ORT_ARCHIVE" "$ORT_URL"

if ! printf '%s  %s\n' "$ORT_SHA256" "$ORT_TMP/$ORT_ARCHIVE" | sha256sum -c -; then
  echo "ERROR: checksum mismatch for $ORT_ARCHIVE." >&2
  echo "  expected: $ORT_SHA256" >&2
  echo "  Refusing to extract an unverified ONNX Runtime archive." >&2
  echo "  If the pin was bumped deliberately, update ORT_VERSION/ORT_SHA256 in" >&2
  echo "  scripts/build-libs.sh and the contract in" >&2
  echo "  scripts/lib/onnx-runtime-packaging.test.mjs." >&2
  exit 1
fi

tar -xzf "$ORT_TMP/$ORT_ARCHIVE" -C "$ORT_TMP" --strip-components=2 "${ORT_MEMBERS[@]}"
cp -a "$ORT_TMP"/libonnxruntime.so* "$OUT_DIR/"

# One real file plus the .so.1/.so symlinks: copying the chain must not turn it
# into three copies of the 29 MB library.
if [ ! -f "$OUT_DIR/libonnxruntime.so.${ORT_VERSION}" ] \
  || [ ! -L "$OUT_DIR/libonnxruntime.so.1" ] \
  || [ ! -L "$OUT_DIR/libonnxruntime.so" ]; then
  echo "ERROR: ONNX Runtime extraction did not produce the shared library chain" >&2
  echo "  expected libonnxruntime.so -> libonnxruntime.so.1 -> libonnxruntime.so.${ORT_VERSION}" >&2
  exit 1
fi

cd "$PROJECT_DIR"

echo "==> Done. .so in build-libs/out/"
ls -lh "$OUT_DIR/" 2>/dev/null || true

echo "==> Removing broken symlinks..."
find "$OUT_DIR/" -type l ! -exec test -e {} \; -delete -print 2>/dev/null || true

echo "==> Setting RPATH..."
for f in "$OUT_DIR"/lib*.so*; do
  [ -e "$f" ] && patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
done
