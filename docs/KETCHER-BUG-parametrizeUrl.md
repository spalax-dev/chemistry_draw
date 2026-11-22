# Ketcher bug: `parametrizeUrl` consumes the URL port

Status: **fixed upstream (not in 3.21.0)**. PR #12552 was merged on
**2026-11-02** and shipped in **3.22.0-rc.1** (a prerelease published
2026-11-12); `3.21.0` (latest stable, published 2026-11-18) still has the bug.
The npm `beta` dist-tag currently resolves to `3.21.0-rc.3`, not to
`3.22.0-rc.1`. Local workaround: `patches/ketcher-core@3.21.0.patch`, narrowed
to this bug only (see [Removing the patch](#removing-the-patch)).

## Symptom

In the desktop app, image recognition (Imago) fails with:

```text
[Error] Failed to load resource: Error resolving "127.0.0.1undefined": Name or service not known
[Error] Ketcher error: – "TypeError: Load failed"
```

and the app shows the generic "The chemistry server is not responding..." dialog.

Nothing else is affected: drawing, layout, cleaning, calculations and the image
upload itself all work. Only **Recognize** breaks.

The `indigo-server` sidecar is healthy the whole time:

- it logs `indigo-server listening on http://127.0.0.1:9321`
- `GET /v2/info` returns `200`
- `POST /v2/imago/uploads` is accepted
- it keeps answering `200` after an upload (verified in isolation)

## Root cause

`packages/ketcher-core/src/infrastructure/services/struct/remoteStructService.ts`
(`parametrizeUrl`):

```js
function parametrizeUrl(url, params) {
  return url.replace(/:(\w+)/g, (_, val) => params[val]);
}
```

It is only invoked from `request()` when the call is a `GET` **with** a data
payload:

```js
function request(method, url, data, headers, responseHandler) {
  let requestUrl = url;
  if (data && method === 'GET') requestUrl = parametrizeUrl(url, data);
  ...
}
```

`\w` matches digits, so in `http://127.0.0.1:9321/v2/imago/uploads/:id` the
regex also matches `:9321` and treats the port as a placeholder named `"9321"`.
That key is not in `params`, so the substitution yields the string `"undefined"`:

```text
http://127.0.0.1:9321/v2/imago/uploads/:id
       └───┬────┘
     :9321 → params["9321"] → undefined

→ http://127.0.0.1undefined/v2/imago/uploads/<uuid>
```

The WebView then tries to resolve `127.0.0.1undefined` as a DNS name, fails, and
`fetch` rejects with `TypeError: Load failed`. `pollDeferred` propagates the
rejection to `recognize()`, which forwards it to `editor.errorHandler(e)`.

Reproducible with plain JavaScript — no Ketcher, no Tauri, no browser:

```js
const url = "http://localhost:8000/v2/imago/uploads/:id";
url.replace(/:(\w+)/g, (_, v) => ({ id: "abc" })[v]);
// -> 'http://localhostundefined/v2/imago/uploads/abc'
```

## Why only Recognize breaks

`parametrizeUrl` runs only for `GET` requests with a payload.
`remoteStructService` has exactly two `GET`s:

| Call              | Method | Payload  | Goes through `parametrizeUrl` |
| ----------------- | ------ | -------- | ----------------------------- |
| `info()`          | GET    | no       | no                            |
| Imago status poll | GET    | `{ id }` | **yes**                       |

Everything else is `POST` through `indigoCall` (convert, layout, clean, aromatize,
dearomatize, calculate, check, aromap, render, ...), so it never touches the
helper.

## Blast radius

Any `apiPath` that contains an explicit port triggers it, which includes the
common Docker setup `http://localhost:8000/v2/`.

It is not triggered by the environment used in Ketcher's example `.env`
(`REACT_APP_API_PATH=/v2`, a relative path with no port) — which is why CI never
caught it.

Confirmed on `ketcher-core@3.15.0`, `ketcher-core@3.18.0` and
`ketcher-core@3.21.0`, in both `dist/infrastructure/services/struct/remoteStructService.js`
and `remoteStructService.modern.js`.

## Incorrect leads we discarded

- **Race condition / missing `upload_id`.** Wrong. The failure is deterministic:
  the port is in every URL, so it fails on every poll.
- **"Could not connect to 127.0.0.1: Connection refused".** This second symptom
  was caused by our own interim workaround, which replaced the port with an empty
  string (`http://127.0.0.1:9321/...` → `http://127.0.0.1/...`, i.e. port 80). It
  was reverted and is not part of the upstream report.
- **Server not running / standalone mode.** Wrong. The sidecar was up and serving.

## Fix

Our patch (same behaviour as upstream):

```diff
 function parametrizeUrl(url, params) {
-  return url.replace(/:(\w+)/g, (_, val) => params[val]);
+  return url.replace(/:([A-Za-z_]\w*)/g, (match, key) => {
+    if (params && Object.prototype.hasOwnProperty.call(params, key)
+        && params[key] !== undefined && params[key] !== null) {
+      return String(params[key]);
+    }
+    return match;
+  });
 }
```

1. A placeholder must start with a letter or `_`, so `:9321` is never a
   candidate.
2. Unknown parameters leave the placeholder intact, so a missing value produces
   an obviously malformed URL instead of a silent `undefined`.

## Local workaround

The project applies the fix via a `patch-package`-style `pnpm` patch:

- `patches/ketcher-core@3.21.0.patch`
- `pnpm-workspace.yaml` → `patchedDependencies: ketcher-core@3.21.0: patches/...`

`pnpm install` re-applies it automatically. The patch is **only** this bug now:
the ReBond half-bond guard it used to carry is upstream in 3.21.0
([epam/ketcher#11165](https://github.com/epam/ketcher/pull/11165)), so those
`rebond.js` / `rebond.modern.js` hunks were dropped when the patch moved from
3.18.0 to 3.21.0.

`ketcher-react` is not patched: it comes from the committed multi-language
tarball built from the `v3.21.0` tag (`docs/architecture.md` §4.1).

### Removing the patch

As soon as a published stable `ketcher-core` includes the upstream fix:

1. Bump `ketcher-core` / `ketcher-react` to that version (3.22.0 stable or
   later; 3.22.0-rc.1 already has the fix but is a pre-release).
2. Delete `patches/ketcher-core@3.21.0.patch`.
3. Remove the `patchedDependencies` entry from `pnpm-workspace.yaml`.
4. `pnpm install` and run `node scripts/harness.mjs`.

Recognition on the 0.x line still runs through the Linux Imago worker and its
`/v2/imago/uploads` poll, so the patch stays required for the status-poll URL
with an explicit port until that bump.

## Verification

- `tsc --noEmit` passes.
- Sidecar isolation test: upload → `GET /v2/info` → `200`, process alive.
- In-app flow after the patch returns `Imago job ... -> SUCCESS` for
  `POST /v2/imago/uploads`, with no `Failed to load resource` and no
  `TypeError: Load failed`.
- The patch-contract test executes the installed `parametrizeUrl` with
  `{ id: "abc" }` and asserts
  `http://127.0.0.1:9321/v2/imago/uploads/abc` (`docs/testing.md` §4.3).

## Upstream

- Reported to the Ketcher team with the reproduction above.
- Their conclusion: confirmed in source, `\w` matching digits, blast radius
  matches (only the Imago status poll), and CI missed it because the example
  `.env` uses a relative `/v2` path with no port.
- **Fixed upstream** in [PR #12552](https://github.com/epam/ketcher/pull/12552)
  ("Recognize fails when Indigo apiPath contains explicit port"), merged on
  2026-11-02 and shipped in 3.22.0-rc.1. The change has the **same behaviour as
  our patch, not an identical implementation**: our patch uses
  `url.replace(/:([A-Za-z_]\w*)…` plus `hasOwnProperty`, while upstream uses
  `split(/(:[A-Za-z_]\w*)/)` plus `hasOwnProperty`; both leave unknown
  placeholders untouched and keep the explicit port.
- They also added a regression test
  (`packages/ketcher-core/src/infrastructure/services/struct/__tests__/remoteStructService.test.ts`)
  that asserts the poll URL keeps the port:
  `http://127.0.0.1:9321/v2/imago/uploads/abc`.

### Why the patch is still applied

The fix is published only on `master` and in the 3.22.0 prerelease line (not the
npm `beta` tag, which still resolves to `3.21.0-rc.3`); the latest stable release
does not contain it:

| Version                         | Published  | Has the fix |
| ------------------------------- | ---------- | ----------- |
| 3.21.0 (`latest`)               | 2026-11-18 | **no**      |
| 3.22.0-rc.1 (prerelease)        | 2026-11-12 | yes         |
| 3.21.0-rc.3 (`beta` tag)        | 2026-11-16 | no          |
| 3.20.0 (`latest` before 3.21.0) | 2026-11-17 | no          |
| 3.18.0                          | 2026-09-02 | no          |

Verified on 2026-11-21 in the published `ketcher-core@3.21.0` dist: both
`remoteStructService.js` and `remoteStructService.modern.js` still contain
`return url.replace(/:(\w+)/g, (_, val) => params[val]);`. The project stays on
3.21.0 stable with the narrowed patch; the patch is deleted when 3.22.0 stable
ships. Check with `pnpm info ketcher-core dist-tags`.
