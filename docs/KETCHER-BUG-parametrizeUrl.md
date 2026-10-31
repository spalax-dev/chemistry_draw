# Ketcher bug: `parametrizeUrl` consumes the URL port

Status: **confirmed upstream** (Ketcher team reproduced it and is landing a fix).
Local workaround: `patches/ketcher-core@3.18.0.patch` (see [Removing the patch](#removing-the-patch)).

## Symptom

In the desktop app, image recognition (Imago) fails with:

```
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
(`parametrizeUrl`, ~line 73):

```js
function parametrizeUrl(url, params) {
  return url.replace(/:(\w+)/g, function (_, val) {
    return params[val];
  });
}
```

It is only invoked from `request()` when the call is a `GET` **with** a data payload:

```js
function request(method, url, data, headers, responseHandler) {
  var requestUrl = url;
  if (data && method === 'GET') requestUrl = parametrizeUrl(url, data);
  ...
}
```

`\w` matches digits, so in `http://127.0.0.1:9321/v2/imago/uploads/:id` the regex
also matches `:9321` and treats the port as a placeholder named `"9321"`. That key
is not in `params`, so the substitution yields the string `"undefined"`:

```
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
const url = 'http://localhost:8000/v2/imago/uploads/:id';
url.replace(/:(\w+)/g, (_, v) => ({ id: 'abc' })[v]);
// -> 'http://localhostundefined/v2/imago/uploads/abc'
```

## Why only Recognize breaks

`parametrizeUrl` runs only for `GET` requests with a payload. `remoteStructService`
has exactly two `GET`s:

| Call | Method | Payload | Goes through `parametrizeUrl` |
| --- | --- | --- | --- |
| `info()` | GET | no | no |
| Imago status poll | GET | `{ id }` | **yes** |

Everything else is `POST` through `indigoCall` (convert, layout, clean, aromatize,
dearomatize, calculate, check, aromap, render, ...), so it never touches the helper.

## Blast radius

Any `apiPath` that contains an explicit port triggers it, which includes the common
Docker setup `http://localhost:8000/v2/`.

It is not triggered by the environment used in Ketcher's example `.env`
(`REACT_APP_API_PATH=/v2`, a relative path with no port) — which is why CI never
caught it.

Confirmed on `ketcher-core@3.15.0` and `ketcher-core@3.18.0`, in both
`dist/index.js` and `dist/infrastructure/services/struct/remoteStructService{.modern}.js`.

## Incorrect leads we discarded

- **Race condition / missing `upload_id`.** Wrong. The failure is deterministic: the
  port is in every URL, so it fails on every poll.
- **"Could not connect to 127.0.0.1: Connection refused".** This second symptom was
  caused by our own interim workaround, which replaced the port with an empty
  string (`http://127.0.0.1:9321/...` → `http://127.0.0.1/...`, i.e. port 80). It
  was reverted and is not part of the upstream report.
- **Server not running / standalone mode.** Wrong. The sidecar was up and serving.

## Fix

Upstream (Ketcher team is landing this themselves, with a failing test first):

```diff
 function parametrizeUrl(url, params) {
-  return url.replace(/:(\w+)/g, function (_, val) {
-    return params[val];
+  return url.replace(/:([A-Za-z_]\w*)/g, function (match, key) {
+    if (params && Object.prototype.hasOwnProperty.call(params, key)
+        && params[key] !== undefined && params[key] !== null) {
+      return String(params[key]);
+    }
+    return match;
   });
 }
```

1. A placeholder must start with a letter or `_`, so `:9321` is never a candidate.
2. Unknown parameters leave the placeholder intact, so a missing value produces an
   obviously malformed URL instead of a silent `undefined`.

## Local workaround

Until a published release contains the fix, the project applies the same change via
`patch-package`-style `pnpm` patch:

- `patches/ketcher-core@3.18.0.patch`
- `pnpm-workspace.yaml` → `patchedDependencies: ketcher-core@3.18.0: patches/...`

`pnpm install` re-applies it automatically.

### Removing the patch

As soon as a published `ketcher-core` includes the upstream fix:

1. Bump `ketcher-core` / `ketcher-react` to that version.
2. Delete `patches/ketcher-core@3.18.0.patch`.
3. Remove the `patchedDependencies` entry from `pnpm-workspace.yaml`.
4. `pnpm install` and verify the Imago flow still works.

## Verification

- `tsc --noEmit` passes.
- Sidecar isolation test: upload → `GET /v2/info` → `200`, process alive.
- In-app flow after the patch: `POST /v2/imago/uploads` → `Imago job ... -> SUCCESS`
  with no `Failed to load resource` and no `TypeError: Load failed`.

## Upstream

- Reported to the Ketcher team with the reproduction above.
- Their conclusion: confirmed in source, `\w` matching digits, blast radius matches
  (only the Imago status poll), and CI missed it because the example `.env` uses a
  relative `/v2` path with no port.
- They are landing the fix themselves, test-first (`recognize()` through the public
  API with a stubbed `fetch`, asserting the poll URL keeps the port), so we are not
  opening a competing PR.
