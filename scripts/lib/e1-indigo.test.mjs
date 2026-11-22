// E1 Indigo 1.49.0 contract: the Linux builder tag, the pinned Windows archive
// and the sidecar's real linked-version assertion.
//
// These tests read the build/fetch scripts and the sidecar test source; they
// never build a library, download an archive or link Indigo. The linked-version
// behaviour itself is the `info_reports_pinned_indigo_version` sidecar test,
// which runs against the real .so files.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    "build-libs.sh must never clone master: it reports a 1.51.0-dev version",
  );

  // The tag guard rejects a checkout that is not exactly the pinned tag.
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

test("build-libs.sh still builds Indigo/Imago/OpenCV for the 0.x line", () => {
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

  assert.match(script, /Imago\.git/, "build-libs.sh must still clone Imago");
  assert.match(script, /make[^\n]*\bimago-c\b/, "build-libs.sh must still build Imago");
  assert.ok(script.includes("libimago.so"), "build-libs.sh must still ship libimago.so");

  assert.match(script, /opencv\.git/, "build-libs.sh must still clone OpenCV");
  assert.match(
    script,
    /BUILD_LIST=core,imgproc,imgcodecs/,
    "build-libs.sh must keep the minimal OpenCV build (core, imgproc, imgcodecs)",
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

  // The Windows side keeps its Indigo runtime/import-library logic; Imago is
  // intentionally absent (no OCR on Windows).
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
  assert.match(
    script,
    /Imago is intentionally absent/i,
    "the script must keep documenting that Imago is unavailable on Windows",
  );
});

test("the sidecar pins the linked Indigo version through /v2/info", () => {
  const infoTests = read("src-tauri/sidecar/src/tests/info.rs");

  assert.ok(
    infoTests.includes("info_reports_pinned_indigo_version"),
    "info.rs must run info_reports_pinned_indigo_version against the real linked library",
  );
  assert.ok(
    infoTests.includes('starts_with("1.49.0")'),
    "the sidecar test must assert indigo_version starts with 1.49.0",
  );
  assert.ok(
    existsSync(path.join(ROOT, "src-tauri", "lib", "linux-x86_64")),
    "the native libraries directory must exist for the sidecar test",
  );
});
