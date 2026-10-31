#!/usr/bin/env bash
# Assemble and package the AppImage ourselves.
#
# Tauri delegates AppImage to linuxdeploy, which copies the whole ELF dependency
# closure (GTK, WebKit, Wayland, ~230 libraries). Mixing Debian's Wayland client
# with the host's libEGL makes WebKit fail with:
#
#     Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
#
# Tauri's AppImageConfig has no exclude list, so we build a minimal AppDir with
# only our binary, the sidecars and our own libraries. GTK/WebKit/EGL come from
# the host, exactly like the .deb and .rpm.
#
# Runs inside the builder container (needs $APPIMAGETOOL).
#
# Usage: bash scripts/make-appimage.sh [out-dir]
set -euo pipefail

OUT_DIR="${1:-dist-packages}"
VERSION="${VERSION:-$(node -p "require('./src-tauri/tauri.conf.json').version")}"
APPDIR="${APPDIR:-/tmp/ChemistryDraw.AppDir}"
APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"

echo "==> Assembling AppDir for chemistry-draw $VERSION"

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" \
         "$APPDIR/usr/lib/chemistry-draw/lib/linux-x86_64" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps"

install -m755 target/release/chemistry-draw "$APPDIR/usr/bin/"
install -m755 target/release/indigo-server "$APPDIR/usr/bin/"
install -m755 target/release/imago-worker "$APPDIR/usr/bin/"

cp -a src-tauri/lib/linux-x86_64/. \
      "$APPDIR/usr/lib/chemistry-draw/lib/linux-x86_64/"

ICON=src-tauri/icons/128x128@2x.png
install -m644 "$ICON" "$APPDIR/usr/share/icons/hicolor/256x256/apps/chemistry-draw.png"
install -m644 "$ICON" "$APPDIR/chemistry-draw.png"

cat > "$APPDIR/chemistry-draw.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Chemistry Draw
Comment=Desktop chemical structure editor
Exec=chemistry-draw
Icon=chemistry-draw
Categories=Education;Science;
Terminal=false
DESKTOP
install -m644 "$APPDIR/chemistry-draw.desktop" \
          "$APPDIR/usr/share/applications/chemistry-draw.desktop"

# The AppImage runtime sets $APPDIR/$APPIMAGE; Tauri derives the resource dir
# from it and the app sets LD_LIBRARY_PATH for the sidecar itself.
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/chemistry-draw" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/chemistry-draw_${VERSION}_amd64.AppImage"
rm -f "$OUT"

echo "==> Running appimagetool"
ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"

ls -lh "$OUT"
