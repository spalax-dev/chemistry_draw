#!/usr/bin/env bash
# Check system dependencies needed for local development (task dev / task run).
# Packaging via Docker (task packages) does not need these.
#
# Usage: bash scripts/check-deps.sh   (or: task check-deps)

set -uo pipefail

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

MISSING_PKG=()
MISSING_CMD=()
MISSING_LIB=()

have_cmd() { command -v "$1" >/dev/null 2>&1; }

check_pkgconfig() {
  local mod="$1" label="$2" pkg="${3:-$1}"
  if ! have_cmd pkg-config; then
    MISSING_PKG+=("$label|$pkg")
    printf '  %s✗%s %-32s (pkg-config not installed)\n' "$RED" "$RESET" "$label"
    return
  fi
  if pkg-config --exists "$mod" 2>/dev/null; then
    printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$label"
  else
    MISSING_PKG+=("$label|$pkg")
    printf '  %s✗%s %s\n' "$RED" "$RESET" "$label"
  fi
}

check_cmd() {
  local cmd="$1" label="$2" hint="$3"
  if have_cmd "$cmd"; then
    printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$label"
  else
    MISSING_CMD+=("$label|$hint")
    printf '  %s✗%s %s\n' "$RED" "$RESET" "$label"
  fi
}

check_lib() {
  local name="$1"
  local dir found=0

  # 1) ldconfig cache (fast path)
  if ldconfig -p 2>/dev/null | grep -qF "$name"; then
    found=1
  else
    # 2) filesystem fallback: some distros ship variants that ldconfig does not
    # index or name differently (e.g. Fedora: libopenblaso.so.0 for openblas).
    for dir in /usr/lib64 /usr/lib /lib64 /lib /usr/local/lib64 /usr/local/lib; do
      [[ -d "$dir" ]] || continue
      if compgen -G "$dir/${name}*" >/dev/null; then
        found=1
        break
      fi
    done
  fi

  if [[ $found -eq 1 ]]; then
    printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$name"
  else
    MISSING_LIB+=("$name")
    printf '  %s✗%s %s\n' "$RED" "$RESET" "$name"
  fi
}

# ---------------------------------------------------------------- distro hint
detect_distro() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown} ${ID_LIKE:-}"
  else
    echo "unknown"
  fi
}

DISTRO="$(detect_distro)"
case "$DISTRO" in
  *fedora*|*rhel*|*centos*|*nobara*) FAMILY="fedora" ;;
  *debian*|*ubuntu*)               FAMILY="debian" ;;
  *arch*)                          FAMILY="arch" ;;
  *suse*)                          FAMILY="suse" ;;
  *)                               FAMILY="unknown" ;;
esac

echo
echo "${BOLD}System dependencies for local development${RESET}"
echo "Detected package family: ${FAMILY}"
echo

echo "${BOLD}### Toolchain${RESET}"
check_cmd pkg-config "pkg-config"                  "pkgconf-pkg-config"
check_cmd cargo      "cargo (Rust toolchain)"      "rustup"
check_cmd node       "node"                        "nodejs"
check_cmd pnpm       "pnpm"                        "corepack enable"
echo

echo "${BOLD}### GTK / WebKit / GLib (pkg-config modules)${RESET}"
check_pkgconfig glib-2.0            "glib-2.0"           glib2-devel
check_pkgconfig gtk+-3.0            "gtk+-3.0"           gtk3-devel
check_pkgconfig webkit2gtk-4.1      "webkit2gtk-4.1"     webkit2gtk4.1-devel
check_pkgconfig javascriptcoregtk-4.1 "javascriptcoregtk-4.1" webkit2gtk4.1-devel
check_pkgconfig openssl             "openssl"            openssl-devel
check_pkgconfig librsvg-2.0         "librsvg-2.0"        librsvg2-devel

for appind in ayatana-appindicator3-0.1 appindicator3-0.1; do
  if have_cmd pkg-config && pkg-config --exists "$appind" 2>/dev/null; then
    printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$appind"
    APPIND_OK=1
    break
  fi
done
if [[ -z "${APPIND_OK:-}" ]]; then
  MISSING_PKG+=("appindicator|libayatana-appindicator-gtk3-devel")
  printf '  %s✗%s %s\n' "$RED" "$RESET" "appindicator (ayatana-appindicator3-0.1)"
fi
echo

echo "${BOLD}### BLAS/LAPACK (needed by OpenCV/Imago)${RESET}"
check_lib "libopenblas"
check_lib "liblapack"
check_lib "libblas"
echo

echo "${BOLD}### OpenCV (Imago)${RESET}"
check_lib "libopencv_core"
check_lib "libopencv_imgproc"
check_lib "libopencv_imgcodecs"
echo

echo "${BOLD}### Runtime helpers${RESET}"
check_cmd patchelf "patchelf" "patchelf"
check_cmd docker   "docker (packaging only)" "docker"
echo

# --------------------------------------------------------------- summary
if [[ ${#MISSING_PKG[@]} -eq 0 && ${#MISSING_CMD[@]} -eq 0 && ${#MISSING_LIB[@]} -eq 0 ]]; then
  echo "${GREEN}${BOLD}All checks passed.${RESET}"
  echo
  exit 0
fi

echo "${YELLOW}${BOLD}Missing dependencies detected.${RESET}"
echo

if [[ ${#MISSING_CMD[@]} -gt 0 ]]; then
  echo "Commands:"
  for entry in "${MISSING_CMD[@]}"; do
    echo "  - ${entry%%|*}  ->  ${entry##*|}"
  done
  echo
fi

if [[ ${#MISSING_LIB[@]} -gt 0 ]]; then
  echo "Shared libraries:"
  for lib in "${MISSING_LIB[@]}"; do
    echo "  - $lib"
  done
  echo
fi

if [[ ${#MISSING_PKG[@]} -gt 0 ]]; then
  echo "Install with:"
  case "$FAMILY" in
    fedora)
      echo "  sudo dnf install -y \\"
      echo "    glib2-devel gtk3-devel webkit2gtk4.1-devel pkgconf-pkg-config \\"
      echo "    openssl-devel libayatana-appindicator-gtk3-devel librsvg2-devel \\"
      echo "    opencv opencv-devel opencv-imgcodecs lapack openblas \\"
      echo "    patchelf fuse3 fuse3-devel"
      ;;
    debian)
      echo "  sudo apt install -y \\"
      echo "    libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev pkg-config \\"
      echo "    libssl-dev libayatana-appindicator3-dev librsvg2-dev \\"
      echo "    libopencv-dev liblapack3 libopenblas0 \\"
      echo "    patchelf fuse3 libfuse2"
      ;;
    arch)
      echo "  sudo pacman -S --needed \\"
      echo "    glib2 gtk3 webkit2gtk-4.1 pkgconf openssl \\"
      echo "    libayatana-appindicator librsvg opencv lapack openblas \\"
      echo "    patchelf fuse3"
      ;;
    suse)
      echo "  sudo zypper install -y \\"
      echo "    glib2-devel gtk3-devel webkit2gtk4.1-devel pkg-config \\"
      echo "    libopenssl-devel libayatana-appindicator3-devel librsvg-devel \\"
      echo "    opencv-devel lapack-devel openblas-devel patchelf"
      ;;
    *)
      echo "  Unknown distro. See docs/DEVELOPMENT.md for the package list."
      ;;
  esac
  echo
fi

echo "See docs/DEVELOPMENT.md for details (including OpenCV SONAME symlinks)."
echo
exit 1
