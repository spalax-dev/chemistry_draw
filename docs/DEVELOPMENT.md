# Development dependencies

This project uses [Tauri](https://v2.tauri.app/), a Rust + Web frontend. For local development you need system libraries for GTK/WebKit/GLib. For packaging we use the Docker builder (`task packages`), so you don't need these if you only build RPM/DEB/AppImage via Docker.

## Local development (`task dev` / `task run`)

These are **development packages** (`-devel`/`-dev`) because `pkg-config` and headers are required to compile crates like `glib-sys`, `gtk-sys`, `webkit2gtk-sys`.

### Fedora / RHEL / Nobara

```bash
sudo dnf install -y \
  glib2-devel \
  gtk3-devel \
  webkit2gtk4.1-devel \
  pkgconf-pkg-config \
  openssl-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  opencv \
  opencv-devel \
  opencv-imgcodecs \
  lapack \
  openblas \
  patchelf \
  fuse3 \
  fuse3-devel
```

### Debian / Ubuntu

```bash
sudo apt install -y \
  libglib2.0-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  pkg-config \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libopencv-dev \
  liblapack3 \
  libopenblas0 \
  patchelf \
  fuse3 \
  libfuse2
```

### Arch Linux

```bash
sudo pacman -S --needed \
  glib2 \
  gtk3 \
  webkit2gtk-4.1 \
  pkgconf \
  openssl \
  libayatana-appindicator \
  librsvg \
  opencv \
  lapack \
  openblas \
  patchelf \
  fuse3
```

## Native libraries (Indigo / Imago)

The `indigo-server` sidecar links against prebuilt Indigo/Imago/OpenCV libraries.

- They are **not committed** (they are binaries). Generate them with:

```bash
task libs
```

That builds the Docker builder image and copies the runtime libraries into
`src-tauri/lib/linux-x86_64/`, which is gitignored. It includes the minimal
OpenCV that Imago needs (`libopencv_*.so.406`) plus `libpng`/`libjpeg`, so no
host-specific SONAME shims are required.

- Packaging builds (`.deb`/`.rpm`/AppImage) copy the same set from
  `/opt/chemistry/libs/` inside the container and ship it in the package.
- `libstdc++` and `libgcc_s` are deliberately **not** shipped: the target
  distro's runtime is used.

## Supported distros

The packages are built in a Debian 12 container, and the native Indigo/Imago
libraries use symbols from its C library (`arc4random@GLIBC_2.36`), so the real
floor is **glibc 2.36**:

| Distro | glibc | Status |
| --- | --- | --- |
| Debian 12 (bookworm) | 2.36 | supported |
| Debian 13 (trixie) | 2.41 | supported |
| Ubuntu 24.04 | 2.39 | supported |
| Ubuntu 22.04 | 2.35 | **not supported** (`GLIBC_2.36 not found`) |
| Debian 11 | 2.31 | not supported |

GTK3 and the `webkit2gtk-4.1` runtime are required too, which Debian 11 does not
provide. CI runs on `ubuntu-24.04` for the same reason: linking a test binary
against the libraries fails on an older glibc.

Lowering the floor would mean building Indigo/Imago *and* the Tauri app on
Debian 11, which is not possible today because Tauri v2 needs
`webkit2gtk-4.1` (Debian 12+).

## Quick checks

```bash
# Check pkg-config deps
pkg-config --exists glib-2.0 gtk+-3.0 webkit2gtk-4.1 && echo "GTK/WebKit OK"

# Check missing runtime deps for the sidecar
ldd target/debug/indigo-server 2>/dev/null | grep "not found"
```

## Notes

- **Packaged `.rpm/.deb/.AppImage`**: Runtime deps are declared in the bundle. You don't need `*-devel` packages to run them.
- **Docker builds**: Ignore all of this. Use `task builder-image`, `task packages`, `task rpm`, etc. All deps are inside the `chemistry-builder` image.
