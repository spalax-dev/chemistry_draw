#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

NO_CACHE=""
if [ "${1:-}" = "--no-cache" ]; then
  NO_CACHE="--no-cache"
fi

echo "==> Building chemistry-builder image (Debian 12, glibc 2.36)..."
docker build $NO_CACHE -t chemistry-builder -f scripts/Dockerfile .
echo "==> Image built successfully."
