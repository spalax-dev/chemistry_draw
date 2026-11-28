// E1 Indigo 1.49.0 contract: the Linux builder tag pin, its checkout guard and
// the pinned Windows archive version and SHA-256.
//
// These tests read the build/fetch scripts as text; they never build a library,
// download an archive, run Docker or execute the PowerShell script. The linked
// Indigo version itself is validated by the sidecar tests that run against the
// real `.so` files, not here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8");

const INDIGO_VERSION = "1.49.0";
const INDIGO_WINDOWS_SHA256 = "5bd405cc4c2b19521b88e015e7266f1a2914bc7d5ca7b769f1e1c16378871515";

test("build-libs.sh clones the indigo-1.49.0 tag with a checkout guard", () => {
  const script = read("scripts/build-libs.sh");

  assert.match(
    script,
    /git\s+clone[^\n]*--branch\s+indigo-1\.49\.0\b/,
    "build-libs.sh must clone the pinned indigo-1.49.0 tag",
  );
  assert.doesNotMatch(
    script,
    /--branch\s+["']?master\b/,
    "build-libs.sh must never clone master: it reports a 1.51.0-dev version string",
  );

  // The guard rejects a checkout whose HEAD is not exactly the pinned tag.
  assert.match(
    script,
    /git\b[^\n]*\btag\b[^\n]*--points-at\b[^\n]*HEAD/,
    "build-libs.sh must guard the checkout with `git tag --points-at HEAD`",
  );
  assert.ok(
    script.includes("indigo-1.49.0"),
    "the tag guard must name the pinned indigo-1.49.0 tag",
  );
  assert.match(script, /\bexit\s+1\b/, "the tag guard must fail the build");
});

test("build-libs.sh still builds the Indigo libs and keeps the ONNX steps", () => {
  const script = read("scripts/build-libs.sh");

  // Both targets must be built by the same `make` invocation; matching the
  // strings separately would let `indigo-renderer` satisfy the `indigo` check.
  assert.match(
    script,
    /make[^\n]*\bindigo\b[^\n]*\bindigo-renderer\b/,
    "build-libs.sh must build indigo and indigo-renderer in one make invocation",
  );

  for (const library of ["libindigo.so", "libindigo-renderer.so"]) {
    assert.match(
      script,
      new RegExp(`cp\\b[^\\n]*${library.replace(/[.]/g, "\\.")}`),
      `build-libs.sh must copy ${library} into the output directory`,
    );
  }

  // The 1.x builder ships ONNX Runtime from the pinned NuGet package; the pin
  // bump must not drop that step or its checksum verification.
  assert.ok(script.includes('ORT_VERSION="1.31.0"'), "build-libs.sh must keep the ONNX pin");
  assert.match(
    script,
    /api\.nuget\.org[^\n]*microsoft\.ml\.onnxruntime/,
    "build-libs.sh must keep fetching ONNX Runtime from NuGet",
  );
  assert.match(
    script,
    /ORT_SHA256=[^\n]*[0-9a-f]{64}/,
    "build-libs.sh must keep the ONNX package SHA-256 pin",
  );
  assert.ok(
    script.includes("ORT_LIB_SHA256"),
    "build-libs.sh must keep the extracted ONNX library SHA-256 pin",
  );
  assert.match(
    script,
    /sha256sum\s+-c\s+-/,
    "build-libs.sh must keep verifying the ONNX checksums",
  );
});

test("fetch-windows-libs.ps1 pins Indigo 1.49.0 and verifies SHA-256", () => {
  const script = read("scripts/fetch-windows-libs.ps1");

  assert.match(
    script,
    new RegExp(`\\$IndigoVersion\\s*=\\s*"${INDIGO_VERSION.replace(/\./g, "\\.")}"`),
    `fetch-windows-libs.ps1 must pin Indigo ${INDIGO_VERSION}`,
  );
  assert.match(
    script,
    /indigo-\$IndigoVersion/,
    "the download URL must use the pinned version variable",
  );
  assert.ok(
    script.includes(INDIGO_WINDOWS_SHA256),
    "the Windows archive must carry the pinned indigo-libs-windows-x86_64 SHA-256",
  );
  assert.match(script, /Get-FileHash[^\n]*SHA256/, "the script must compute the archive hash");
  assert.match(
    script,
    /\$actualSha256\s+-ne\s+\$ExpectedSha256/,
    "the script must compare the archive hash and abort on mismatch",
  );

  // The Windows side keeps its runtime extraction and import-library logic.
  for (const dll of [
    "indigo.dll",
    "indigo-renderer.dll",
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
  ]) {
    assert.ok(script.includes(`"${dll}"`), `the Windows runtime must still extract ${dll}`);
  }
  assert.match(script, /indigo\.lib/, "the script must still generate indigo.lib");
  assert.match(
    script,
    /indigo-renderer\.lib/,
    "the script must still generate indigo-renderer.lib",
  );
});
