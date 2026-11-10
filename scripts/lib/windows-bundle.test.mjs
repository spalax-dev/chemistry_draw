// Contract tests for the Windows bundle configuration.
//
// WebView2 ships with normal Windows 10/11 installations, so the bundle stays
// small: Tauri's default per-user install plus the embedded bootstrapper. The
// offline runtime (~215 MB) and the per-machine installer were tried and
// reverted; systems with Edge/WebView2 removed are unsupported.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(
  readFileSync(path.join(ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"),
);

test("the Windows installer keeps Tauri's default per-user mode", () => {
  assert.equal(
    config.bundle?.windows?.nsis?.installMode,
    undefined,
    "do not require administrator privileges; the default per-user install is intentional",
  );
});

test("the bundle embeds only the WebView2 bootstrapper", () => {
  const mode = config.bundle?.windows?.webviewInstallMode;
  assert.deepEqual(
    mode,
    { type: "embedBootstrapper", silent: true },
    "WebView2 is expected from Windows; do not bundle the ~215 MB offline installer",
  );
});

test("the Windows bundle ships the Indigo sidecar and DLLs", () => {
  assert.deepEqual(config.bundle?.externalBin, ["../target/release/indigo-server"]);
  assert.ok(
    config.bundle?.resources?.["lib/windows-x86_64/*.dll"],
    "the Indigo DLLs must be bundled as resources",
  );
});
