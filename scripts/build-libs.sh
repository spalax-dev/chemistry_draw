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
      libfontconfig*|libfreetype*|libexpat*|libpng*|libbrotli*| \
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
# link-time dependency). The upstream GitHub 1.31.0 release asset is gone (404),
# so the pinned source is the official Microsoft.ML.OnnxRuntime NuGet package,
# which carries the same Linux shared library. The .nupkg is checksum-verified
# before extraction: never download-and-execute.
ORT_VERSION="1.31.0"
echo "==> Fetching ONNX Runtime ${ORT_VERSION} from NuGet..."
ORT_PACKAGE="microsoft.ml.onnxruntime.${ORT_VERSION}.nupkg"
ORT_URL="https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ORT_VERSION}/microsoft.ml.onnxruntime.${ORT_VERSION}.nupkg"
ORT_SHA256="7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b"
ORT_REAL="libonnxruntime.so.${ORT_VERSION}"
ORT_MEMBER="runtimes/linux-x64/native/libonnxruntime.so"
ORT_LIB_SHA256="469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e"
ORT_TMP="$(mktemp -d)"
trap 'rm -rf "$ORT_TMP"' EXIT

curl -fsSL --retry 3 -o "$ORT_TMP/$ORT_PACKAGE" "$ORT_URL"

if ! printf '%s  %s\n' "$ORT_SHA256" "$ORT_TMP/$ORT_PACKAGE" | sha256sum -c -; then
  echo "ERROR: checksum mismatch for $ORT_PACKAGE." >&2
  echo "  expected: $ORT_SHA256" >&2
  echo "  Refusing to extract an unverified ONNX Runtime package." >&2
  echo "  If the pin was bumped deliberately, move the URL/member/hash pins together:" >&2
  echo "  ORT_URL, ORT_MEMBER, ORT_SHA256 and ORT_LIB_SHA256 in scripts/build-libs.sh," >&2
  echo "  and the contract in scripts/lib/onnx-runtime-packaging.test.mjs." >&2
  exit 1
fi

# A .nupkg is a zip archive: extract the single runtime member, not the whole
# package (it also carries Windows, macOS, headers and metadata).
if ! python3 - "$ORT_TMP/$ORT_PACKAGE" "$OUT_DIR/$ORT_REAL" "$ORT_MEMBER" <<'PY'
import sys
import zipfile

archive, destination, member = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(archive) as package, package.open(member) as source:
    with open(destination, "wb") as target:
        target.write(source.read())
PY
then
  echo "ERROR: $ORT_PACKAGE does not contain $ORT_MEMBER." >&2
  echo "  The package layout changed; move ORT_URL, ORT_MEMBER, ORT_SHA256 and" >&2
  echo "  ORT_LIB_SHA256 together in scripts/build-libs.sh and update the contract" >&2
  echo "  in scripts/lib/onnx-runtime-packaging.test.mjs." >&2
  rm -f "$OUT_DIR/$ORT_REAL"
  exit 1
fi

if ! printf '%s  %s\n' "$ORT_LIB_SHA256" "$OUT_DIR/$ORT_REAL" | sha256sum -c -; then
  echo "ERROR: checksum mismatch for $ORT_MEMBER." >&2
  echo "  expected: $ORT_LIB_SHA256" >&2
  echo "  Refusing to ship an unverified ONNX Runtime library." >&2
  echo "  If the pin was bumped deliberately, move ORT_URL, ORT_MEMBER, ORT_SHA256" >&2
  echo "  and ORT_LIB_SHA256 together in scripts/build-libs.sh." >&2
  exit 1
fi

# One real file plus the .so.1/.so symlinks: copying the chain must not turn it
# into three copies of the 29 MB library.
ln -sfn "$ORT_REAL" "$OUT_DIR/libonnxruntime.so.1"
ln -sfn "libonnxruntime.so.1" "$OUT_DIR/libonnxruntime.so"

if [ ! -f "$OUT_DIR/$ORT_REAL" ] \
  || [ ! -L "$OUT_DIR/libonnxruntime.so.1" ] \
  || [ ! -L "$OUT_DIR/libonnxruntime.so" ]; then
  echo "ERROR: ONNX Runtime extraction did not produce the shared library chain" >&2
  echo "  expected libonnxruntime.so -> libonnxruntime.so.1 -> $ORT_REAL" >&2
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
