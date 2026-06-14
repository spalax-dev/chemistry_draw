# Maintainer: Your Name <your@email>
# Contributor: Chemistry Draw Contributors

pkgname=chemistry-draw
pkgver=0.1.0
pkgrel=1
pkgdesc="Desktop chemical structure editor — Ketcher wrapper with native Indigo backend"
arch=('x86_64')
url="https://github.com/spalax/chemistry-draw"
license=('Apache-2.0')
depends=(
    'glibc'
    'gcc-libs'
    'libgl'
    'webkit2gtk-4.1'
    'gtk3'
    'libappindicator-gtk3'
    'librsvg'
    'libx11'
)
makedepends=(
    'cargo'
    'nodejs'
    'pnpm'
    'base-devel'
)
source=("${pkgname}-${pkgver}.tar.gz::${url}/archive/v${pkgver}.tar.gz")
sha256sums=('SKIP')

prepare() {
    cd "${srcdir}/${pkgname}-${pkgver}"
    pnpm install --frozen-lockfile
}

build() {
    cd "${srcdir}/${pkgname}-${pkgver}"

    # Bundle shared libraries
    bash scripts/bundle-libs.sh

    # Build sidecar
    cargo build --release -p indigo-server --bin indigo-server
    cp target/release/indigo-server target/release/indigo-server-x86_64-unknown-linux-gnu

    # Build frontend
    pnpm build

    # Build Tauri app
    cargo build --release -p chemistry-draw
}

package() {
    cd "${srcdir}/${pkgname}-${pkgver}"

    local dest="${pkgdir}/usr/lib/${pkgname}"

    install -Dm755 "target/release/chemistry-draw" "${dest}/chemistry-draw"
    install -Dm755 "target/release/indigo-server" "${dest}/indigo-server"
    install -Dm644 "target/release/indigo-server-x86_64-unknown-linux-gnu" "${dest}/indigo-server-x86_64-unknown-linux-gnu"

    # Shared libraries
    install -dm755 "${dest}/lib/linux-x86_64"
    cp -r src-tauri/lib/linux-x86_64/*.so* "${dest}/lib/linux-x86_64/"

    # Desktop file
    install -Dm644 "src-tauri/icons/icon.png" "${pkgdir}/usr/share/icons/hicolor/256x256/apps/${pkgname}.png"

    mkdir -p "${pkgdir}/usr/share/applications"
    cat > "${pkgdir}/usr/share/applications/${pkgname}.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Chemistry Draw
Comment=${pkgdesc}
Exec=/usr/lib/${pkgname}/chemistry-draw
Icon=${pkgname}
Categories=Science;Chemistry;
Terminal=false
EOF
}
