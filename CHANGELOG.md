# Changelog

## Unreleased

### Fixed

- The Indigo sidecar is now stopped when the app exits, and it also shuts itself
  down if its parent dies (crash or SIGKILL), so a dead app can't leave a port
  bound by an orphan process.
- The Indigo sidecar no longer panics when its port is already in use: it picks a
  free port (starting from 9321) and the app discovers it at runtime, so a stale
  instance or a second window can't break image recognition.
- Image recognition (Imago) no longer fails with `TypeError: Load failed` when the
  Indigo API URL contains an explicit port. Works around an upstream `ketcher-core`
  bug in `parametrizeUrl`; see `docs/KETCHER-BUG-parametrizeUrl.md`.

## [0.1.6](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.5...chemistry-draw-v0.1.6) (2026-11-04)


### Bug Fixes

* **windows:** bundle the WebView2 offline installer ([9252651](https://github.com/spalax-dev/chemistry_draw/commit/925265150d89283ecd62e32bf7c80250508e4ee4))
* **windows:** install per-machine so WebView2 is visible to every user ([c78ecc4](https://github.com/spalax-dev/chemistry_draw/commit/c78ecc49859d9a752c32c24ee67fd7a41c5fc748))
* **windows:** revert to the 0.1.5 WebView2 behaviour ([8ae8c64](https://github.com/spalax-dev/chemistry_draw/commit/8ae8c64b2b5618539f89197f0f3a5a3ab01e7b11))


### Miscellaneous

* **main:** release chemistry-draw 0.1.6 ([#7](https://github.com/spalax-dev/chemistry_draw/issues/7)) ([f046b62](https://github.com/spalax-dev/chemistry_draw/commit/f046b6271052d6ed514ef595a764e17e1aaa1e6b))
* **main:** release chemistry-draw 0.1.7 ([#8](https://github.com/spalax-dev/chemistry_draw/issues/8)) ([6faf858](https://github.com/spalax-dev/chemistry_draw/commit/6faf8588ac60dc5a9372b46a7c8729c25c45d729))
* **release:** roll the version metadata back to 0.1.5 ([a927464](https://github.com/spalax-dev/chemistry_draw/commit/a92746455e6a3366fdb9ca54a7df25bf0e5582e5))

## [0.1.5](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.4...chemistry-draw-v0.1.5) (2026-11-03)


### Features

* **release:** publish the Windows installer with GitHub Releases ([0de4e47](https://github.com/spalax-dev/chemistry_draw/commit/0de4e4756486c915152399e0accc33223c796c10))

## [0.1.4](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.3...chemistry-draw-v0.1.4) (2026-11-03)


### Features

* **windows:** add a Windows NSIS build without Imago ([e9c6982](https://github.com/spalax-dev/chemistry_draw/commit/e9c698217f816b04621bedf85a765b8a49645aba))


### Bug Fixes

* **build:** align tauri-plugin-log with its npm package ([10d4527](https://github.com/spalax-dev/chemistry_draw/commit/10d45273f55eb0b075273d9bba1eef35cc71c0f3))
* **build:** align the Tauri JS packages with the tauri 2.12 crate ([5462ef9](https://github.com/spalax-dev/chemistry_draw/commit/5462ef9d8e9f8d6ca5dcac8f14f94f15f0ebb700))
* **build:** sync Cargo.lock with tauri-plugin-log 2.10.1 ([d131fb0](https://github.com/spalax-dev/chemistry_draw/commit/d131fb0e3a21faa9d0d13471e9f132ae7837c76b))


### Documentation

* record Windows CI evidence and close activities ([0a37aac](https://github.com/spalax-dev/chemistry_draw/commit/0a37aac313f909092fdcd6966030b8916022ad61))

## [0.1.3](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.2...chemistry-draw-v0.1.3) (2026-11-03)


### Features

* **observability:** log frontend and sidecar to rotating files, add /v2/health ([2fa7adc](https://github.com/spalax-dev/chemistry_draw/commit/2fa7adccedfe52255983d6fe92b80dd6c89150b3))


### Miscellaneous

* **quality:** add a harness with formatters and linters for every language ([e2593a6](https://github.com/spalax-dev/chemistry_draw/commit/e2593a6e28078571ca08aa917c3ff8fa115fa198))
* sync Cargo.lock with 0.1.1 version bump ([3d67256](https://github.com/spalax-dev/chemistry_draw/commit/3d67256eb64e36fe48564e8aba45907ee5cf8388))
* sync workspace Cargo.lock and drop the stale src-tauri one ([7c71e43](https://github.com/spalax-dev/chemistry_draw/commit/7c71e43fab359f466a3610492f3cda6920c06706))


### Documentation

* **ketcher:** record upstream fix (epam/ketcher[#12552](https://github.com/spalax-dev/chemistry_draw/issues/12552)) and why the patch stays ([c9435d9](https://github.com/spalax-dev/chemistry_draw/commit/c9435d9eab08a53070e521143442ee27920f68c3))

## [0.1.2](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.1...chemistry-draw-v0.1.2) (2026-10-31)


### Bug Fixes

* **appimage:** assemble the AppDir ourselves instead of linuxdeploy ([f873d3b](https://github.com/spalax-dev/chemistry_draw/commit/f873d3b571657cfc1542c4ea8bfd221cac222aa8))

## [0.1.1](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.0...chemistry-draw-v0.1.1) (2026-10-31)


### Features

* .deb packaging with bundled shared libs, FHS-compliant ([d862a12](https://github.com/spalax-dev/chemistry_draw/commit/d862a12d7a8135b3434a3ac53a36f69cda0afcd3))
* AppImage build with Tauri bundler + fix CJS interop ([e24fd34](https://github.com/spalax-dev/chemistry_draw/commit/e24fd341380e92cc9a9ca103a3baecaae2a8a0a4))
* basic image-to-structure recognition with EPAM Imago v2 ([2fc888f](https://github.com/spalax-dev/chemistry_draw/commit/2fc888f3bf1b401393d9f685b6894155a4d72427))


### Bug Fixes

* add use tauri::Manager import (needed for app.path() in release mode) ([1c264cf](https://github.com/spalax-dev/chemistry_draw/commit/1c264cfb18e51bc1dc4b31ee69d94644db099bcf))
* bundle transitive deps from Docker, fix webview black screen on Wayland ([046aaee](https://github.com/spalax-dev/chemistry_draw/commit/046aaeed05b87e5ab199d0fead7a4e94fcd9dbaf))
* default check types to ['valence'] when Ketcher sends empty array ([9bf4b6f](https://github.com/spalax-dev/chemistry_draw/commit/9bf4b6f3bc6bed9271cf83c4ba66adfb4db62ef3))
* editor now fills the whole window. missing height:100% on #root was causing Ketcher to render at zero height ([50b082f](https://github.com/spalax-dev/chemistry_draw/commit/50b082f2f8faefc4b60407d7f420292f094534aa))
* **ketcher:** work around parametrizeUrl consuming the URL port ([e3fca33](https://github.com/spalax-dev/chemistry_draw/commit/e3fca337ac7931ba73439e1f852b3a3a12b48e8a))
* native save dialog, PNG/SVG render, calculate CIP, error alerts, test audit ([5ecd4e0](https://github.com/spalax-dev/chemistry_draw/commit/5ecd4e03858064bf8209ea367abf1e1c8d294aec))
* remove dir from build-sidecar task, workspace target is at project root ([e37df11](https://github.com/spalax-dev/chemistry_draw/commit/e37df116146ec61c05d1ac993bcd4641f5e45cef))
* restore missing request logs in sidecar handlers, fix Ketcher editor window sizing, add TODO.md ([0a7efb5](https://github.com/spalax-dev/chemistry_draw/commit/0a7efb52910f9e7b95eb1677257f3b9ef67134cc))
* **sidecar:** free port on busy bind and stop the child with the app ([a50771e](https://github.com/spalax-dev/chemistry_draw/commit/a50771e0937e822a8decbc8d058174e153e3ed03))


### Miscellaneous

* add base proyect and installed libindigo backend to write sidecard ([3fda79f](https://github.com/spalax-dev/chemistry_draw/commit/3fda79fcbc7a271d29c2f03e81b851687f850212))
* Add initial PKGBUILD for Arch Linux support (AUR submission pending) ([9846bc1](https://github.com/spalax-dev/chemistry_draw/commit/9846bc14fc92b84bde6155402aea31384ee13549))
* build native libs from source with Docker (glibc 2.35) ([752d444](https://github.com/spalax-dev/chemistry_draw/commit/752d44455a779751ff97219aef6aa6e2dadbf634))
* ignore sidecar/target build artifacts ([79c3ef3](https://github.com/spalax-dev/chemistry_draw/commit/79c3ef35eb5d562034746f48de1089094b53acc5))
* remove android and ios icon directories ([0cf0a62](https://github.com/spalax-dev/chemistry_draw/commit/0cf0a62115ae066582e328cdddbe40b43092cd68))
* remove stray test file ([79ae467](https://github.com/spalax-dev/chemistry_draw/commit/79ae467aa96fdc8d02e2c9ee2380eee74c694442))
* silence rustc warnings with dead_code annotations and _ prefix on unused FFI ([8c23fcc](https://github.com/spalax-dev/chemistry_draw/commit/8c23fccc8fb9081eb70cfc771cdb4b0446acd667))
* update TODO, mark .deb packaging as done ([5b83ad5](https://github.com/spalax-dev/chemistry_draw/commit/5b83ad58e7589d4c83595445264b7d90a9723fa5))


### Documentation

* rewrite README as Chemistry Draw project description ([47d545d](https://github.com/spalax-dev/chemistry_draw/commit/47d545d0f1096b4c487ed8573673c63f9f59a263))
* update README with logo, features and development guide ([be08dbe](https://github.com/spalax-dev/chemistry_draw/commit/be08dbec22e40e50fc2329b0debdb4de1a0cf918))
* update README with new features (save dialog, render, CIP, validation) ([8950320](https://github.com/spalax-dev/chemistry_draw/commit/89503206f3f8874a087e19be6f8f7c5d3bc5d94a))


### Code Refactoring

* move sidecar into src-tauri/, reorganise with layered architecture ([45993b6](https://github.com/spalax-dev/chemistry_draw/commit/45993b68fa30e7966af2e4725ae9ceca2dcb8e82))

## 0.1.0

- Initial release
