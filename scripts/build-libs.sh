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
make -j$(nproc) indigo indigo-renderer

# ----- Repo 1.5: Build a minimal OpenCV -----
# The distro's OpenCV drags in GDAL (-> GEOS, HDF5, Poppler, ...): 120+ shared
# libraries. Imago only needs core/imgproc/imgcodecs with PNG+JPEG, so we build
# a small one and link Imago against it. That keeps the packages self-contained
# without shipping half of Debian.
echo "==> Cloning OpenCV..."
git clone --depth 1 --branch 4.6.0 https://github.com/opencv/opencv.git /tmp/opencv

echo "==> Building minimal OpenCV (core, imgproc, imgcodecs)..."
cmake -S /tmp/opencv -B /tmp/opencv/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/tmp/opencv-install \
  -DBUILD_LIST=core,imgproc,imgcodecs \
  -DBUILD_SHARED_LIBS=ON \
  -DBUILD_TESTS=OFF \
  -DBUILD_PERF_TESTS=OFF \
  -DBUILD_EXAMPLES=OFF \
  -DBUILD_opencv_apps=OFF \
  -DBUILD_JAVA=OFF \
  -DBUILD_opencv_python3=OFF \
  -DWITH_GDAL=OFF \
  -DWITH_OPENEXR=OFF \
  -DWITH_TIFF=OFF \
  -DWITH_WEBP=OFF \
  -DWITH_OPENJPEG=OFF \
  -DWITH_JASPER=OFF \
  -DWITH_JPEG=ON \
  -DWITH_PNG=ON \
  -DWITH_ZLIB=ON \
  -DWITH_IPP=OFF \
  -DWITH_ITT=OFF \
  -DWITH_OPENCL=OFF \
  -DWITH_LAPACK=OFF
cmake --build /tmp/opencv/build --target install -j"$(nproc)"

# ----- Repo 2: Build Imago -----
echo "==> Cloning Imago..."
git clone --depth 1 https://github.com/epam/Imago.git /tmp/imago

mkdir -p /tmp/imago/third_party/indigo
cat > /tmp/imago/third_party/indigo/CMakeLists.txt << 'INNER_EOF'
add_library(indigo SHARED IMPORTED)
set_target_properties(indigo PROPERTIES
    IMPORTED_LOCATION /tmp/indigo/build/bin/libindigo.so
    INTERFACE_INCLUDE_DIRECTORIES /tmp/indigo/api/c/indigo)
add_library(indigo-renderer SHARED IMPORTED)
set_target_properties(indigo-renderer PROPERTIES
    IMPORTED_LOCATION /tmp/indigo/build/bin/libindigo-renderer.so
    INTERFACE_INCLUDE_DIRECTORIES /tmp/indigo/api/c/indigo-renderer)
INNER_EOF

mkdir -p /tmp/imago/third_party/indigo/cmake
touch /tmp/imago/third_party/indigo/cmake/setup.cmake

mkdir -p /tmp/imago/third_party/opencv/include
echo 'find_package(OpenCV REQUIRED)' > /tmp/imago/third_party/opencv/CMakeLists.txt
ln -sf /tmp/opencv-install/include/opencv4/opencv2 /tmp/imago/third_party/opencv/include/opencv2

printf 'add_subdirectory(indigo)\nadd_subdirectory(opencv)\n' > /tmp/imago/third_party/CMakeLists.txt

sed -i 's/indigo-static/indigo/g' /tmp/imago/core/CMakeLists.txt
sed -i 's|PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src|&\n    PUBLIC /tmp/indigo/api/c/indigo\n    PUBLIC /tmp/indigo/api/c/indigo-renderer|' /tmp/imago/core/CMakeLists.txt
sed -i '/^target_link_libraries(imago-core/a target_link_directories(imago-core PUBLIC /tmp/indigo/build/bin)' /tmp/imago/core/CMakeLists.txt

echo "==> Building Imago..."
mkdir -p /tmp/imago/build
cd /tmp/imago/build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DOpenCV_DIR=/tmp/opencv-install/lib/cmake/opencv4 \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DIMAGO_ENABLE_TESTS=OFF
make -j$(nproc) imago-c

# ----- Extract results + transitive deps -----
echo "==> Copying .so files..."
cp /tmp/indigo/build/bin/libindigo.so "$OUT_DIR/"
cp /tmp/indigo/build/bin/libindigo-renderer.so "$OUT_DIR/"
cp /tmp/imago/build/api/c/libimago.so "$OUT_DIR/"

for f in "$OUT_DIR"/libindigo.so "$OUT_DIR"/libindigo-renderer.so "$OUT_DIR"/libimago.so; do
  deps="$(LD_LIBRARY_PATH="$OUT_DIR:/tmp/opencv-install/lib" ldd "$f" 2>/dev/null \
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
