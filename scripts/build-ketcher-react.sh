#!/usr/bin/env bash
# Regenerate the committed multi-language `ketcher-react` 3.21.0 tarball.
#
# The published npm bundle is the English-only default: its
# `SUPPORTED_LANGUAGES` list contains only `en`, so Ketcher's Settings selector
# is hidden. The supported route is the upstream build flag
# `KETCHER_MULTI_LANGUAGE_BUILD=true`, applied while building the package from
# the pinned `v3.21.0` tag. The tag's `engines` field requires Node >= 24.20.0;
# older hosts fail the upstream build with a confusing error.
#
# Regeneration is pnpm-only: the tag is an npm-workspace monorepo, so a temporary
# pnpm workspace is written in the throwaway checkout and the npm-based
# `prebuild`/`build` scripts are bypassed with `pnpm --filter ketcher-react`.
#
# Output (committed): vendor/ketcher-react/ketcher-react-3.21.0-multi.tgz
# The tarball is committed because CI, Windows and fresh worktrees consume this
# exact build: `pnpm install` must work without a Node 24.20 build host. This
# script regenerates the committed artifact; it is not a fresh-install
# prerequisite.
set -euo pipefail

KETCHER_TAG="v3.21.0"
KETCHER_VERSION="3.21.0"
REQUIRED_NODE="24.20.0"
KETCHER_REPO="https://github.com/epam/ketcher.git"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/build/ketcher-src"
OUT_DIR="${ROOT_DIR}/vendor/ketcher-react"
TARBALL="${OUT_DIR}/ketcher-react-${KETCHER_VERSION}-multi.tgz"

# The tag requires Node >= 24.20.0. Select it before touching the checkout so
# an older host Node cannot build a broken bundle. Install it with nvm; this
# script never provisions a toolchain itself.
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>= ${REQUIRED_NODE}); install it with nvm" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 20) ? 0 : 1)'; then
  echo "error: Node >= ${REQUIRED_NODE} is required, found $(node --version); run: nvm install ${REQUIRED_NODE} && nvm use" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required; run: corepack enable" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}" "${ROOT_DIR}/build"

# Clone the pinned tag, or fetch it into an existing checkout. Never build from
# master or an unpinned working tree.
if [ -d "${SRC_DIR}/.git" ]; then
  git -C "${SRC_DIR}" fetch --depth 1 origin "refs/tags/v3.21.0:refs/tags/v3.21.0"
  git -C "${SRC_DIR}" checkout --detach "v3.21.0"
else
  git clone --depth 1 --branch "v3.21.0" "${KETCHER_REPO}" "${SRC_DIR}"
fi

checked_out_tag="$(git -C "${SRC_DIR}" describe --tags --exact-match 2>/dev/null || true)"
if [ "${checked_out_tag}" != "${KETCHER_TAG}" ]; then
  echo "error: wrong tag: expected ${KETCHER_TAG}, found '${checked_out_tag}'" >&2
  exit 1
fi

# The tag ships an npm-workspace layout. A temporary pnpm workspace lets pnpm
# install and filter the packages without touching the app's dependency graph.
cat > "${SRC_DIR}/pnpm-workspace.yaml" <<'YAML'
packages:
  - "packages/*"
YAML

cd "${SRC_DIR}"
pnpm install --ignore-scripts --no-frozen-lockfile

# Build-time feature flag consumed by @rollup/plugin-replace in
# packages/ketcher-react/rollup.config.mjs. It must be exported, not only
# mentioned, so the rollup process sees it.
export KETCHER_MULTI_LANGUAGE_BUILD=true
if [ "${KETCHER_MULTI_LANGUAGE_BUILD}" != "true" ]; then
  echo "error: KETCHER_MULTI_LANGUAGE_BUILD must be exported as true" >&2
  exit 1
fi

# Bypass the npm-based prebuild: generate the locales directly, then run Rollup
# through pnpm with the same arguments as the package's build script.
pnpm --filter ketcher-react run i18n:generate
pnpm --filter ketcher-react exec cross-env NODE_ENV=production rollup -c rollup.config.mjs -m true

# Guard the flag's observable effect: the English-only build tree-shakes the
# non-English locales away, so a missing zh-CN means the flag was ignored.
DIST_ENTRY="${SRC_DIR}/packages/ketcher-react/dist/index.js"
if [ ! -f "${DIST_ENTRY}" ]; then
  echo "error: missing build output ${DIST_ENTRY}" >&2
  exit 1
fi
if ! grep -q "zh-CN" "${DIST_ENTRY}"; then
  echo "error: build is English-only (no zh-CN in dist/index.js); KETCHER_MULTI_LANGUAGE_BUILD was not applied" >&2
  exit 1
fi

pnpm --filter ketcher-react pack --pack-destination "${OUT_DIR}"
mv "${OUT_DIR}/ketcher-react-${KETCHER_VERSION}.tgz" "${TARBALL}"

if ! tar -tzf "${TARBALL}" >/dev/null 2>&1; then
  echo "error: ${TARBALL} is not a valid tarball" >&2
  exit 1
fi

echo "wrote ${TARBALL}"
