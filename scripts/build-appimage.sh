#!/usr/bin/env bash
set -euo pipefail

APP=chemistry-draw
VER=0.1.0
BUNDLE="target/release/bundle/appimage"
APPDIR="$BUNDLE/$APP.AppDir"
LIBDIR_src="src-tauri/lib/linux-x86_64"
LIBDIR_dst="$APPDIR/usr/lib/$APP/lib/linux-x86_64"

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$LIBDIR_dst"

# Binaries
install -Dm755 "target/release/$APP" "$APPDIR/usr/bin/$APP"
install -Dm755 "target/release/indigo-server" "$APPDIR/usr/bin/indigo-server"

# Desktop file
mkdir -p "$APPDIR/usr/share/applications"
cat > "$APPDIR/usr/share/applications/$APP.desktop" << ENDOF
[Desktop Entry]
Type=Application
Name=Chemistry Draw
Comment=Desktop chemical structure editor
Exec=$APP
Icon=$APP
Categories=Education;
Terminal=false
ENDOF
# appimagetool expects a desktop file in the root of the AppDir
ln -sf "usr/share/applications/$APP.desktop" "$APPDIR/$APP.desktop"

# Icons
mkdir -p "$APPDIR/usr/share/icons/hicolor/32x32/apps"
cp src-tauri/icons/32x32.png "$APPDIR/usr/share/icons/hicolor/32x32/apps/$APP.png"
mkdir -p "$APPDIR/usr/share/icons/hicolor/128x128/apps"
cp src-tauri/icons/128x128.png "$APPDIR/usr/share/icons/hicolor/128x128/apps/$APP.png"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp src-tauri/icons/128x128@2x.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APP.png"
mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"
cp src-tauri/icons/icon.png "$APPDIR/usr/share/icons/hicolor/scalable/apps/$APP.png"
# Icon in AppDir root (required by appimagetool)
cp src-tauri/icons/128x128@2x.png "$APPDIR/$APP.png"

# Bundled libraries
find "$LIBDIR_src" -name '*.so*' -exec cp -n {} "$LIBDIR_dst/" \;

# Find appimagetool (bundled with linuxdeploy)
APPIMAGETOOL=""
for candidate in \
  "$HOME/.local/share/linuxdeploy-extracted/plugins/linuxdeploy-plugin-appimage/usr/bin/appimagetool" \
  "/usr/bin/appimagetool" \
  "/usr/local/bin/appimagetool"; do
  if [ -x "$candidate" ]; then
    APPIMAGETOOL="$candidate"
    break
  fi
done

if [ -z "$APPIMAGETOOL" ]; then
  echo "ERROR: appimagetool not found. Install linuxdeploy-appimage from AUR." >&2
  exit 1
fi

mkdir -p "$BUNDLE"
"$APPIMAGETOOL" "$APPDIR" "$BUNDLE/$APP-$VER-x86_64.AppImage"
echo "AppImage created: $BUNDLE/$APP-$VER-x86_64.AppImage"
