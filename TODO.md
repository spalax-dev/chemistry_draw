# TODO

## Save & export
- [x] Ensure saving works for all formats (mol, PNG, SVG, SMILES, KET, CDXML, etc.)
- [x] Allow user to choose save location (native dialog, not browser download)

## Calculate values crash
- [x] Investigate and fix crash when using "Calculate Values" option in Ketcher menu

## Code review
- [x] Audit every sidecar endpoint for silent failures, unhandled errors, or edge cases
- [x] Improve tests with real mol files (aspirin, caffeine) and structural validation
- [x] Add structural error detection tests (duplicate bonds, invalid SMILES, corrupted molfiles)

## Packaging
- [ ] Configure `.deb` packaging via Tauri bundle
- [ ] Configure Flatpak packaging
