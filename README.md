# Chemistry Draw

<p align="center">
  <img src="src-tauri/icons/icon.png" width="64" alt="Chemistry Draw logo">
</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Desktop wrapper of the chemical structure editor [Ketcher](https://github.com/epam/ketcher) (© EPAM Systems, Apache License 2.0) for Linux.

> Not an official EPAM product. Community-maintained packaging without affiliation or official support.


## Features

- Full Ketcher editor with molecule, reaction and macromolecule drawing
- Native Indigo backend via Rust sidecar for faster cheminformatics (replaces WASM)
- Basic image-to-structure recognition powered by EPAM Imago v2
- Offline-first — runs entirely on your machine

## Development

```bash
pnpm install
pnpm tauri dev
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
