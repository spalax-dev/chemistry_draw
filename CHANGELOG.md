# Changelog

## [0.1.1](https://github.com/spalax-dev/chemistry_draw/compare/chemistry-draw-v0.1.0...chemistry-draw-v0.1.1) (2026-06-16)


### Features

* .deb packaging with bundled shared libs, FHS-compliant ([d862a12](https://github.com/spalax-dev/chemistry_draw/commit/d862a12d7a8135b3434a3ac53a36f69cda0afcd3))
* AppImage build with Tauri bundler + fix CJS interop ([e24fd34](https://github.com/spalax-dev/chemistry_draw/commit/e24fd341380e92cc9a9ca103a3baecaae2a8a0a4))
* basic image-to-structure recognition with EPAM Imago v2 ([2fc888f](https://github.com/spalax-dev/chemistry_draw/commit/2fc888f3bf1b401393d9f685b6894155a4d72427))


### Bug Fixes

* add use tauri::Manager import (needed for app.path() in release mode) ([1c264cf](https://github.com/spalax-dev/chemistry_draw/commit/1c264cfb18e51bc1dc4b31ee69d94644db099bcf))
* default check types to ['valence'] when Ketcher sends empty array ([9bf4b6f](https://github.com/spalax-dev/chemistry_draw/commit/9bf4b6f3bc6bed9271cf83c4ba66adfb4db62ef3))
* editor now fills the whole window. missing height:100% on #root was causing Ketcher to render at zero height ([50b082f](https://github.com/spalax-dev/chemistry_draw/commit/50b082f2f8faefc4b60407d7f420292f094534aa))
* native save dialog, PNG/SVG render, calculate CIP, error alerts, test audit ([5ecd4e0](https://github.com/spalax-dev/chemistry_draw/commit/5ecd4e03858064bf8209ea367abf1e1c8d294aec))
* remove dir from build-sidecar task, workspace target is at project root ([e37df11](https://github.com/spalax-dev/chemistry_draw/commit/e37df116146ec61c05d1ac993bcd4641f5e45cef))
* restore missing request logs in sidecar handlers, fix Ketcher editor window sizing, add TODO.md ([0a7efb5](https://github.com/spalax-dev/chemistry_draw/commit/0a7efb52910f9e7b95eb1677257f3b9ef67134cc))


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
