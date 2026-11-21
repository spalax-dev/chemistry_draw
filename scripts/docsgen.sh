#!/usr/bin/env bash
# Generate the API documentation for both halves of the app:
#
#   TypeDoc  -> docs/generated/api   (frontend, gitignored)
#   rustdoc  -> target/doc           (Tauri host and Indigo sidecar, gitignored)
#
# The harness engine calls this script as a gate, so it must fail on any
# generator error. TypeDoc is pinned: it is not a package.json dependency
# (the harness scripts are owned elsewhere), so a local install is preferred
# and the pinned npx fallback bootstraps the same version on a fresh checkout.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TYPEDOC_VERSION="0.28.20"

if [[ -x node_modules/.bin/typedoc ]]; then
  TYPEDOC=(node_modules/.bin/typedoc)
else
  TYPEDOC=(npx --yes "typedoc@${TYPEDOC_VERSION}")
fi

echo "docsgen: TypeDoc (frontend) -> docs/generated/api"
"${TYPEDOC[@]}" --options typedoc.json

echo "docsgen: rustdoc (Tauri host) -> target/doc"
cargo doc --no-deps --manifest-path src-tauri/Cargo.toml

echo "docsgen: rustdoc (Indigo sidecar) -> target/doc"
cargo doc --no-deps --manifest-path src-tauri/sidecar/Cargo.toml

echo "docsgen: ok"
