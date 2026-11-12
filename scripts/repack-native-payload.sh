#!/usr/bin/env bash
# Re-link the shipped ONNX Runtime chain inside .deb/.rpm payloads.
#
# Tauri's resource bundler copies every matched file with fs::copy, which
# dereferences symlinks: the runtime chain produced by build-libs.sh / `task
# libs` reaches the artifact as three 29 MB copies. The payload must carry one
# real `libonnxruntime.so.1.31.0` plus the `.so.1`/`.so` symlinks, so this
# script extracts the package, restores the chain and repacks it with the same
# name and compression (gzip, so `ar p ... data.tar.gz` and `rpm2cpio` keep
# working).
#
# The version pin below MUST match scripts/build-libs.sh,
# scripts/fetch-windows-libs.ps1 and scripts/fetch-onnxruntime.sh (1.31.0).
# Bump them together; the packaging contract test
# (scripts/lib/onnx-runtime-packaging.test.mjs) fails when they drift.
#
# RPM metadata: the rebuilt package keeps the original Name/Version/Release/
# Epoch-less metadata, summary, license, description and explicit soname
# requires, but rpmbuild regenerates the implicit capabilities. That normalizes
# the dependency arch spelling (`chemistry-draw(x86_64)` ->
# `chemistry-draw(x86-64)`) and emits its own `rpmlib(...)` requirements with
# `<=` instead of the original `=`. Both spellings are equivalent: rpm's
# dependency solver canonicalizes the arch qualifier, and `rpmlib(...)` is a
# build-time capability set that rpmbuild owns. Carrying the original strings
# verbatim would mean patching the RPM header after the build; we do not.
#
# Runs inside the Debian builder image (needs dpkg-deb / rpmbuild).
#
# Usage: repack-native-payload.sh <deb|rpm> <package> [<out-package>]
set -euo pipefail

FORMAT="${1:?usage: $0 <deb|rpm> <package> [<out-package>]}"
PACKAGE="${2:?usage: $0 <deb|rpm> <package> [<out-package>]}"
OUT="${3:-$PACKAGE}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NATIVE_DIR="${REPO_ROOT}/src-tauri/lib/linux-x86_64"
ORT_VERSION="1.31.0"
ORT_REAL="libonnxruntime.so.${ORT_VERSION}"

if [ ! -f "$PACKAGE" ]; then
  echo "ERROR: package not found: $PACKAGE" >&2
  exit 1
fi
if [ ! -f "$NATIVE_DIR/$ORT_REAL" ]; then
  echo "ERROR: missing builder runtime: $NATIVE_DIR/$ORT_REAL" >&2
  echo "  Run 'task libs' (or rebuild the builder image) first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Replace the dereferenced copies with the symlink chain shipped from the
# builder. Fails loudly if the payload lost the real library.
relink_ort() {
  local root="$1"
  local lib_dir
  lib_dir="$(find "$root" -type d -path '*/lib/linux-x86_64' -print -quit)"
  if [ -z "$lib_dir" ]; then
    echo "ERROR: no lib/linux-x86_64 directory in the payload" >&2
    exit 1
  fi

  if [ ! -f "$lib_dir/$ORT_REAL" ]; then
    echo "ERROR: payload is missing $ORT_REAL in $lib_dir" >&2
    exit 1
  fi

  rm -f "$lib_dir/libonnxruntime.so" "$lib_dir/libonnxruntime.so.1"
  ln -s libonnxruntime.so.1 "$lib_dir/libonnxruntime.so"
  ln -s "$ORT_REAL" "$lib_dir/libonnxruntime.so.1"

  if [ "$(readlink "$lib_dir/libonnxruntime.so")" != "libonnxruntime.so.1" ] \
    || [ "$(readlink "$lib_dir/libonnxruntime.so.1")" != "$ORT_REAL" ]; then
    echo "ERROR: could not restore the ONNX Runtime symlink chain in $lib_dir" >&2
    exit 1
  fi
}

repack_deb() {
  local root="$WORK/root"
  dpkg-deb -R "$PACKAGE" "$root"
  relink_ort "$root"

  # Installed-Size is the sum of the regular files in KiB; the two removed
  # copies no longer count.
  local installed_size
  installed_size="$(find "$root" -path "$root/DEBIAN" -prune -o -type f -printf '%s\n' \
    | awk '{ total += $1 } END { print int((total + 1023) / 1024) }')"
  sed -i "s/^Installed-Size: .*/Installed-Size: ${installed_size}/" "$root/DEBIAN/control"

  # dpkg's md5sums convention excludes symlinks: regenerate after the relink.
  (cd "$root" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' \
    | sort -z | xargs -0 -r md5sum) > "$root/DEBIAN/md5sums"

  rm -f "$OUT"
  dpkg-deb -Zgzip --root-owner-group -b "$root" "$OUT"
}

repack_rpm() {
  local root="$WORK/root"
  mkdir -p "$root"
  # rpm2cpio in the Debian builder returns 1 even on a complete extraction, so
  # trust the extracted payload instead of its status code.
  rpm2cpio "$PACKAGE" > "$WORK/payload.cpio" || true
  if [ ! -s "$WORK/payload.cpio" ]; then
    echo "ERROR: could not extract $PACKAGE" >&2
    exit 1
  fi
  (cd "$root" && cpio -idm --quiet < "$WORK/payload.cpio")
  if [ ! -x "$root/usr/bin/indigo-server" ]; then
    echo "ERROR: rpm payload does not contain usr/bin/indigo-server" >&2
    exit 1
  fi
  relink_ort "$root"

  # Read each field with its own quoted query: never eval rpm output as shell
  # code (a `%{SUMMARY}`/`%{LICENSE}` value could contain command substitutions).
  local name version release arch summary license group
  name="$(rpm -qp --qf '%{NAME}' "$PACKAGE")"
  version="$(rpm -qp --qf '%{VERSION}' "$PACKAGE")"
  release="$(rpm -qp --qf '%{RELEASE}' "$PACKAGE")"
  arch="$(rpm -qp --qf '%{ARCH}' "$PACKAGE")"
  summary="$(rpm -qp --qf '%{SUMMARY}' "$PACKAGE")"
  license="$(rpm -qp --qf '%{LICENSE}' "$PACKAGE")"
  group="$(rpm -qp --qf '%{GROUP}' "$PACKAGE")"
  name="${name:-chemistry-draw}"
  version="${version:?could not read package version}"
  release="${release:?could not read package release}"
  arch="${arch:?could not read package architecture}"
  summary="${summary:-Desktop chemical structure editor}"
  license="${license:-Apache-2.0}"
  group="${group:-Unspecified}"

  # `%files` includes a directory recursively, so keep the top-level directory
  # entry and drop the individual files it already covers (rpmbuild warns
  # "File listed twice" otherwise).
  rpm -qpl "$PACKAGE" | awk -v dir="/usr/lib/chemistry-draw" '
    $0 == dir { print; next }
    index($0, dir "/") == 1 { next }
    { print }
  ' > "$WORK/files"
  rpm -qp --qf '%{DESCRIPTION}\n' "$PACKAGE" > "$WORK/description"
  rpm -qpR "$PACKAGE" | grep -v '^rpmlib(' > "$WORK/requires" || true

  {
    echo "Name: $name"
    echo "Version: $version"
    echo "Release: $release"
    echo "Summary: $summary"
    echo "License: $license"
    echo "Group: $group"
    echo "BuildArch: $arch"
    # Keep the metadata of the original artifact: Tauri disables automatic
    # dependency generation, so reuse its explicit soname requirements.
    echo "AutoReqProv: no"
    while IFS= read -r requirement; do
      [ -n "$requirement" ] && echo "Requires: $requirement"
    done < "$WORK/requires"
    echo
    echo "%define _build_id_links none"
    echo "%define __os_install_post %{nil}"
    echo "%define _binary_payload w6.gzdio"
    echo
    echo "%description"
    cat "$WORK/description"
    echo
    echo "%install"
    echo "cp -a \"$root/.\" %{buildroot}/"
    echo
    echo "%files -f $WORK/files"
  } > "$WORK/$name.spec"

  rm -f "$OUT"
  if ! rpmbuild -bb \
    --define "_topdir $WORK/rpm" \
    --define "_rpmdir $WORK/out" \
    "$WORK/$name.spec" > "$WORK/rpmbuild.log" 2>&1; then
    echo "ERROR: rpmbuild failed for $PACKAGE" >&2
    tail -40 "$WORK/rpmbuild.log" >&2
    exit 1
  fi

  local built
  built="$(find "$WORK/out" -name '*.rpm' -print -quit)"
  if [ -z "$built" ]; then
    echo "ERROR: rpmbuild produced no package" >&2
    exit 1
  fi
  cp -a "$built" "$OUT"
}

case "$FORMAT" in
  deb) repack_deb ;;
  rpm) repack_rpm ;;
  *)
    echo "ERROR: unsupported package format: $FORMAT" >&2
    exit 2
    ;;
esac

echo "==> Restored the ONNX Runtime symlink chain in $(basename "$OUT")"
