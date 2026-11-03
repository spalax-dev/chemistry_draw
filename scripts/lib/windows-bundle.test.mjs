// Contract tests for the Windows bundle configuration.
//
// The WebView2 runtime is only visible to the account it was installed for.
// A per-user NSIS install therefore surfaces "Could not find the WebView2
// Runtime" when the app runs under another account, so the installer must be
// per-machine. These tests pin that decision and the Imago-free bundle.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(
  readFileSync(path.join(ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"),
);

test("the Windows installer is per-machine", () => {
  assert.equal(
    config.bundle?.windows?.nsis?.installMode,
    "perMachine",
    "the default per-user install hides the WebView2 runtime from other accounts",
  );
});

test("the bundle uses a supported WebView2 install mode", () => {
  const mode = config.bundle?.windows?.webviewInstallMode;
  assert.ok(mode, "webviewInstallMode must be explicit");
  assert.ok(
    ["embedBootstrapper", "offlineInstaller", "downloadBootstrapper", "fixedRuntime"].includes(
      mode.type,
    ),
    `unexpected webviewInstallMode: ${mode.type}`,
  );
  if (mode.type === "embedBootstrapper" || mode.type === "downloadBootstrapper") {
    assert.equal(
      typeof mode.silent,
      "boolean",
      "bootstrapper modes must declare whether the installer runs silently",
    );
  }
});

test("the Windows bundle ships Indigo without Imago", () => {
  assert.deepEqual(config.bundle?.externalBin, ["../target/release/indigo-server"]);
  assert.ok(
    config.bundle?.resources?.["lib/windows-x86_64/*.dll"],
    "the Indigo DLLs must be bundled as resources",
  );
});
