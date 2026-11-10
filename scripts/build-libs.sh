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
      [ "$(readlink -f "$link" 2>/dev/null)" = "$real" ] && cp -a "$link" "$OUT_DIR/"
    done
  done <<< "$deps"
done

cd "$PROJECT_DIR"

echo "==> Done. .so in build-libs/out/"
ls -lh "$OUT_DIR/" 2>/dev/null || true

echo "==> Removing broken symlinks..."
find "$OUT_DIR/" -type l ! -exec test -e {} \; -delete -print 2>/dev/null || true

echo "==> Setting RPATH..."
for f in "$OUT_DIR"/lib*.so*; do
  [ -e "$f" ] && patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
done
