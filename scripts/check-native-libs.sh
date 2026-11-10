#!/usr/bin/env bash
# Fail fast when the native libs bundle carries files the builder image did not
# provide — in particular Imago or OpenCV leftovers.
#
# The app is Indigo-only. Packaging scripts wipe `src-tauri/lib/linux-x86_64`,
# copy /opt/chemistry/libs into it and bundle the result. Host leftovers (for
# example an Imago-era `libjpeg*` trio) or a stale `chemistry-builder` image
# would silently re-ship removed dependencies. Run this right after that copy:
# it stops the build before `tauri build` instead of at release time.
#
# Usage: check-native-libs.sh [--allowlist <source-dir>] <dir> [<dir>...]
#
# With --allowlist, every regular file or symlink in each target directory must
# also exist by basename in <source-dir>; anything else is reported as "not
# provided by the builder image". Forbidden-name checks always run.
#
# Exit codes: 0 clean, 1 violations, 2 usage (including no existing directory).
# Missing directories are warned about and skipped; the build only fails when a
# directory that exists holds forbidden or unlisted files.
set -euo pipefail

usage() {
  echo "Usage: $0 [--allowlist <source-dir>] <dir> [<dir>...]" >&2
  exit 2
}

allowlist=""
if [ "${1:-}" = "--allowlist" ]; then
  if [ "$#" -lt 2 ]; then
    usage
  fi
  allowlist=$2
  shift 2
fi

if [ "$#" -eq 0 ]; then
  usage
fi

if [ -n "$allowlist" ] && [ ! -d "$allowlist" ]; then
  echo "ERROR: allowlist source directory not found: $allowlist" >&2
  usage
fi

found=""
unlisted=""
checked=0

for dir in "$@"; do
  if [ ! -d "$dir" ]; then
    echo "WARNING: directory not found, skipping: $dir" >&2
    continue
  fi
  checked=$((checked + 1))

  hits=$(find "$dir" -mindepth 1 -maxdepth 1 \( -iname '*imago*' -o -iname '*opencv*' \) -print | sort)
  if [ -n "$hits" ]; then
    found="${found}${hits}"$'\n'
  fi

  if [ -n "$allowlist" ]; then
    while IFS= read -r path; do
      name=$(basename "$path")
      case "${name,,}" in
        *imago* | *opencv*) continue ;;
      esac
      if [ ! -e "$allowlist/$name" ] && [ ! -L "$allowlist/$name" ]; then
        unlisted="${unlisted}  $path (not provided by the builder image)"$'\n'
      fi
    done < <(find "$dir" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -print | sort)
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "ERROR: none of the given directories exist." >&2
  usage
fi

if [ -z "$found" ] && [ -z "$unlisted" ]; then
  exit 0
fi

if [ -n "$found" ]; then
  echo "ERROR: forbidden libraries found in the native libs bundle:" >&2
  printf '%s' "$found" | while IFS= read -r path; do
    echo "  $path" >&2
  done
  echo "" >&2
  echo "The builder image still ships forbidden libraries. Rebuild it with:" >&2
  echo "  task builder-image -- --no-cache" >&2
fi

if [ -n "$unlisted" ]; then
  echo "ERROR: files in the native libs bundle were not provided by the builder image:" >&2
  printf '%s' "$unlisted" | while IFS= read -r line; do
    echo "$line" >&2
  done
  echo "" >&2
  echo "Packaging must bundle only the libraries built by the builder image." >&2
fi

exit 1
