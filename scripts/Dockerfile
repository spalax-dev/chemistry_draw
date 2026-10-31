FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential cmake git curl patchelf pkg-config \
    zlib1g-dev libcairo2-dev libpng-dev libfontconfig1-dev \
    libopencv-dev libboost-dev libboost-filesystem-dev \
    libboost-thread-dev libboost-program-options-dev \
    libfreetype-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev libssl-dev fuse3 libfuse2 \
    rpm mold clang xdg-utils python3 \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/build-libs.sh /tmp/build-libs.sh
RUN bash /tmp/build-libs.sh && \
    mkdir -p /opt/chemistry/libs && \
    cp -a build-libs/out/* /opt/chemistry/libs/ && \
    rm -rf build-libs /tmp/indigo /tmp/imago /tmp/build-libs.sh

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
ENV RUSTFLAGS="-C link-arg=-fuse-ld=mold"
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

# rpmbuild needs `cpio` to build the payload and `zstd` for compression.
# Kept as a separate layer so the heavy build-libs layer above stays cached.
RUN apt-get update && \
    apt-get install -y --no-install-recommends cpio zstd && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
