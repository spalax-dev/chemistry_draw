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

## 0.1.0

- Initial release
