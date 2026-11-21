#!/usr/bin/env bash
# harness-test.sh — test gate for the two-stage harness.
#
# Usage:
#   bash scripts/harness-test.sh full
#   bash scripts/harness-test.sh targeted <spec>...
#
# Keeps the three suites (Vitest, node:test, sidecar cargo tests) and the native
# library/model environment in one place so CONFIG.gates.test stays declarative.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="full"
if (($# > 0)); then
  MODE="$1"
  shift
fi

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) LIB_DIR="windows-x86_64"; ORT_NAME="onnxruntime.dll" ;;
  *) LIB_DIR="linux-x86_64"; ORT_NAME="libonnxruntime.so" ;;
esac

LIB_DIR_PATH="$ROOT/src-tauri/lib/$LIB_DIR"
export LD_LIBRARY_PATH="$LIB_DIR_PATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CHEMISTRY_MODELS_DIR="${CHEMISTRY_MODELS_DIR:-$ROOT/models}"

# Honour an explicit runtime; otherwise prefer the checkout under .ort/ and
# fall back to the bundled native lib directory.
if [[ -z "${ORT_DYLIB_PATH:-}" ]]; then
  if [[ -f "$ROOT/.ort/$LIB_DIR/$ORT_NAME" ]]; then
    ORT_DYLIB_PATH="$ROOT/.ort/$LIB_DIR/$ORT_NAME"
  elif [[ -f "$LIB_DIR_PATH/$ORT_NAME" ]]; then
    ORT_DYLIB_PATH="$LIB_DIR_PATH/$ORT_NAME"
  fi
  export ORT_DYLIB_PATH
fi

# Model-gated tests are #[ignore]d; run them only when both the manifest and a
# loadable runtime are present.
include_ignored=()
if [[ -f "$CHEMISTRY_MODELS_DIR/manifest.json" && -n "${ORT_DYLIB_PATH:-}" && -f "$ORT_DYLIB_PATH" ]]; then
  include_ignored=(--include-ignored)
fi

run_cargo_tests() {
  local -a args=("$@")
  (cd "$ROOT" && cargo test -p indigo-server "${args[@]}" -- "${include_ignored[@]}")
}

if [[ "$MODE" == "full" ]]; then
  (cd "$ROOT" && pnpm test)

  mapfile -t node_specs < <(find "$ROOT/scripts/lib" -maxdepth 1 -name '*.test.mjs' -print | sort)
  if ((${#node_specs[@]} > 0)); then
    (cd "$ROOT" && node --test "${node_specs[@]}")
  fi

  run_cargo_tests
  exit 0
fi

if [[ "$MODE" != "targeted" ]]; then
  echo "usage: bash scripts/harness-test.sh full | targeted <spec>..." >&2
  exit 2
fi

ts_specs=()
node_specs=()
rust_specs=()
for spec in "$@"; do
  case "$spec" in
    src-tauri/sidecar/src/tests/*.rs) rust_specs+=("$spec") ;;
    *.test.mjs) node_specs+=("$spec") ;;
    *.test.ts | *.test.tsx | *.spec.ts | *.spec.tsx) ts_specs+=("$spec") ;;
    *)
      echo "harness-test: unsupported spec: $spec" >&2
      exit 2
      ;;
  esac
done

if ((${#ts_specs[@]} + ${#node_specs[@]} + ${#rust_specs[@]} == 0)); then
  echo "harness-test: no specs given" >&2
  exit 2
fi

if ((${#ts_specs[@]} > 0)); then
  (cd "$ROOT" && pnpm exec vitest run "${ts_specs[@]}")
fi
if ((${#node_specs[@]} > 0)); then
  (cd "$ROOT" && node --test "${node_specs[@]}")
fi
for spec in "${rust_specs[@]}"; do
  module="$(basename "$spec" .rs)"
  # tests/models.rs is mounted as `model_delivery` (see tests/mod.rs).
  if [[ "$module" == "models" ]]; then
    module="model_delivery"
  fi
  run_cargo_tests "tests::$module"
done
