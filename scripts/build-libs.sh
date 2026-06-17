#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Clearing previous builds..."
rm -rf build-libs/out build-libs/Dockerfile
mkdir -p build-libs/out build-libs/backup

# Backup current libs
if ls src-tauri/lib/linux-x86_64/*.so* &>/dev/null; then
  cp -a src-tauri/lib/linux-x86_64/lib*.so* build-libs/backup/
  echo "   Backup saved to build-libs/backup/"
fi

echo "==> Generating Dockerfile..."
cat > build-libs/Dockerfile << 'DOCKER_EOF'
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# Dependencies for both Indigo and Imago
RUN apt-get update && apt-get install -y \
    build-essential cmake git \
    zlib1g-dev libcairo2-dev libpng-dev \
    libfontconfig1-dev libopencv-dev \
    libboost-dev libboost-filesystem-dev \
    libboost-thread-dev libboost-program-options-dev \
    && rm -rf /var/lib/apt/lists/*

# ----- Repo 1: Build Indigo (shared libs for sidecar) -----
RUN git clone --depth 1 \
    https://github.com/epam/Indigo.git /src/indigo

WORKDIR /src/indigo/build
RUN cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_INDIGO_SERVICE=OFF \
    -DBUILD_INDIGO_WRAPPERS=OFF \
    -DBUILD_BINGO=OFF \
    -DBUILD_BINGO_ELASTIC=OFF \
    && make -j$(nproc) \
    indigo indigo-renderer

# ----- Repo 2: Build Imago (links dynamically against pre-built Indigo) -----
RUN git clone --depth 1 \
    https://github.com/epam/Imago.git /src/imago

# Stub third_party/indigo: import pre-built libindigo.so (no rebuild)
RUN mkdir -p /src/imago/third_party/indigo && \
    cat > /src/imago/third_party/indigo/CMakeLists.txt << 'INNER_EOF'
add_library(indigo SHARED IMPORTED)
set_target_properties(indigo PROPERTIES
    IMPORTED_LOCATION /src/indigo/build/bin/libindigo.so
    INTERFACE_INCLUDE_DIRECTORIES /src/indigo/api/c/indigo)
add_library(indigo-renderer SHARED IMPORTED)
set_target_properties(indigo-renderer PROPERTIES
    IMPORTED_LOCATION /src/indigo/build/bin/libindigo-renderer.so
    INTERFACE_INCLUDE_DIRECTORIES /src/indigo/api/c/indigo-renderer)
INNER_EOF

# Stub setup.cmake (needed by Imago's root CMakeLists.txt)
RUN mkdir -p /src/imago/third_party/indigo/cmake && \
    touch /src/imago/third_party/indigo/cmake/setup.cmake

# Stub third_party/opencv: use system OpenCV
RUN mkdir -p /src/imago/third_party/opencv/include && \
    echo 'find_package(OpenCV REQUIRED)' > /src/imago/third_party/opencv/CMakeLists.txt && \
    ln -sf /usr/include/opencv4/opencv2 /src/imago/third_party/opencv/include/opencv2

# third_party/CMakeLists.txt: only opencv (indigo handled via stub)
RUN printf 'add_subdirectory(indigo)\nadd_subdirectory(opencv)\n' > /src/imago/third_party/CMakeLists.txt

# Patch core/CMakeLists.txt: indigo-static → indigo (shared)
RUN sed -i 's/indigo-static/indigo/g' /src/imago/core/CMakeLists.txt

# Add Indigo include paths directly (IMPORTED target include propagation is unreliable)
RUN sed -i 's|PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src|&\n    PUBLIC /src/indigo/api/c/indigo\n    PUBLIC /src/indigo/api/c/indigo-renderer|' /src/imago/core/CMakeLists.txt

# Add Indigo library path for linker (IMPORTED target doesn't set search path)
RUN sed -i '/^target_link_libraries(imago-core/a target_link_directories(imago-core PUBLIC /src/indigo/build/bin)' /src/imago/core/CMakeLists.txt

WORKDIR /src/imago/build
RUN cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DIMAGO_ENABLE_TESTS=OFF \
    && make -j$(nproc) imago-c

# ----- Extract results + transitive deps -----
RUN mkdir -p /out && \
    cp /src/indigo/build/bin/libindigo.so /out/ && \
    cp /src/indigo/build/bin/libindigo-renderer.so /out/ && \
    cp /src/imago/build/api/c/libimago.so /out/ && \
    # Copy all transitive shared library dependencies (skip system libs)
    for f in /out/libindigo.so /out/libindigo-renderer.so /out/libimago.so; do \
      LD_LIBRARY_PATH=/out ldd "$f" 2>/dev/null | grep "=> /" | awk '{print $3}' | sort -u | while read dep; do \
        case "$dep" in /out/*) continue ;; esac; \
        name=$(basename "$dep"); \
        case "$name" in \
          libc.so.*|libm.so.*|libgcc_s.so.*|libz.so.*| \
          libdl.so.*|libpthread.so.*|librt.so.*| \
          libGL*|libX11*|libxcb*|libXau*|libXdmcp*| \
          linux-vdso*|ld-linux*) ;; \
          *) \
            real=$(readlink -f "$dep"); \
            dir=$(dirname "$dep"); \
            for link in "$dir"/lib*.so*; do \
              [ -e "$link" ] || continue; \
              [ "$(readlink -f "$link" 2>/dev/null)" = "$real" ] && cp -a "$link" /out/; \
            done ;; \
        esac; \
      done; \
    done

# Final stage: tiny image with just the .so files
FROM alpine:latest
COPY --from=0 /out/ /sofiles/
DOCKER_EOF

echo "==> Building Docker image (this will take a while)..."
docker build -t indigo-builder build-libs

echo "==> Extracting .so..."
docker run --rm -v "$(pwd)/build-libs/out:/mnt" indigo-builder sh -c 'cp -a /sofiles/. /mnt/'

echo "==> Done. .so in build-libs/out/"
ls -lh build-libs/out/

echo "==> Removing broken symlinks..."
find build-libs/out/ -type l ! -exec test -e {} \; -delete -print

echo "==> Setting RPATH on bundled libraries..."
for f in build-libs/out/lib*.so*; do
  patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true
done
