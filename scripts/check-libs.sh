#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <new_dir> <old_dir>"
  echo "Ex:   $0 build-libs/out build-libs/backup"
  exit 1
fi

NEW="$1"
OLD="$2"
HAS_ERROR=0

LIBS=(libindigo.so libindigo-renderer.so libimago.so)

for f in "${LIBS[@]}"; do
  if [ ! -f "$NEW/$f" ]; then
    echo "❌ $f not found in $NEW (build failed?)"
    HAS_ERROR=1
    continue
  fi
  if [ ! -f "$OLD/$f" ]; then
    echo "⚠️  $f not found in $OLD (first run?): no reference to compare"
    continue
  fi

  old_syms=$(nm -D "$OLD/$f" 2>/dev/null | grep ' T ' | awk '{print $3}' | sort)
  new_syms=$(nm -D "$NEW/$f" 2>/dev/null | grep ' T ' | awk '{print $3}' | sort)

  missing=$(comm -23 <(echo "$old_syms") <(echo "$new_syms"))

  if [ -n "$missing" ]; then
    echo "❌ $f lost $(echo "$missing" | wc -l) symbols (incompatible!):"
    echo "$missing"
    HAS_ERROR=1
  else
    echo "✅ $f: all symbols present"
  fi
done

exit $HAS_ERROR
