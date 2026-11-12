// Contract tests for the removal of Imago from packaging.
//
// The app is Indigo-only: no `libimago`, no `imago-worker` binary, no Imago
// upload routes. These tests keep the packaging layer honest after the source
// tree no longer mentions Imago, because a stray `externalBin` entry or a
// `cp` of a missing binary fails only at release time.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const IMAGO_REFERENCE = /libimago|imago-worker/;

test("the Linux bundle does not ship an imago-worker binary", () => {
  const config = JSON.parse(read("src-tauri/tauri.linux.conf.json"));
  const externalBin = config.bundle?.externalBin ?? [];

  assert.ok(
    externalBin.some((entry) => entry.includes("indigo-server")),
    "the Indigo sidecar must stay in externalBin",
  );
  assert.ok(
    externalBin.every((entry) => !entry.includes("imago-worker")),
    `externalBin must not list imago-worker, got ${JSON.stringify(externalBin)}`,
  );
});

test("the sidecar crate builds only the Indigo server binary", () => {
  const manifest = read("src-tauri/sidecar/Cargo.toml");
  const binNames = [...manifest.matchAll(/\[\[bin\]\][\s\S]*?^name\s*=\s*"([^"]+)"/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(binNames, ["indigo-server"]);
});

test("the sidecar crate does not depend on uuid", () => {
  const manifest = read("src-tauri/sidecar/Cargo.toml");

  assert.doesNotMatch(manifest, /^uuid\s*=/m, "uuid was only used by Imago job ids");
});

const SCRIPTS = [
  "scripts/build-libs.sh",
  "scripts/check-libs.sh",
  "scripts/bundle-libs.sh",
  "scripts/build-appimage.sh",
  "scripts/build-deb.sh",
  "scripts/build-rpm.sh",
  "scripts/build-packages.sh",
  "scripts/make-appimage.sh",
];

for (const script of SCRIPTS) {
  test(`${script} does not reference Imago`, () => {
    const content = read(script);

    assert.doesNotMatch(
      content,
      IMAGO_REFERENCE,
      `${script} must not mention libimago or imago-worker`,
    );
  });
}

// --- Fail-fast guard -------------------------------------------------------
//
// The `chemistry-builder` image built before Imago was removed still carries
// `libimago*`/OpenCV under `/opt/chemistry/libs`, and every packaging script
// copies that directory into `src-tauri/lib`. Without a guard the stale image
// silently re-ships Imago; with it the build stops before `tauri build`.

const GUARD = "scripts/check-native-libs.sh";
const GUARD_PATH = path.join(ROOT, GUARD);
const GUARD_CALL = "bash scripts/check-native-libs.sh --allowlist /opt/chemistry/libs";
const LIBS_COPY = 'cp -a /opt/chemistry/libs/*.so* "$LIB_DIR/"';
const PACKAGING_SCRIPTS = [
  "scripts/build-deb.sh",
  "scripts/build-rpm.sh",
  "scripts/build-appimage.sh",
  "scripts/build-packages.sh",
];

function guardOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runGuard(dirs) {
  return spawnSync("bash", [GUARD_PATH, ...dirs], { encoding: "utf8" });
}

function runGuardWithAllowlist(source, dirs) {
  return spawnSync("bash", [GUARD_PATH, "--allowlist", source, ...dirs], { encoding: "utf8" });
}

function makeTempDir(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chemistry-draw-native-libs-"));
  for (const file of files) {
    writeFileSync(path.join(dir, file), "not a real library");
  }
  return dir;
}

test(`${GUARD} exists as a bash script`, () => {
  assert.ok(existsSync(GUARD_PATH), `${GUARD} must exist`);
  assert.ok(statSync(GUARD_PATH).size > 0, `${GUARD} must not be empty`);
  assert.match(
    readFileSync(GUARD_PATH, "utf8"),
    /^#!\/usr\/bin\/env bash\n/,
    `${GUARD} must be invoked via bash, so it starts with that shebang`,
  );
});

for (const script of PACKAGING_SCRIPTS) {
  test(`${script} runs the forbidden-libs guard after copying the native libs`, () => {
    const content = read(script);
    const copyIndex = content.indexOf(LIBS_COPY);
    assert.ok(copyIndex >= 0, `${script} must copy the native libs from /opt/chemistry/libs`);

    const callIndex = content.indexOf(GUARD_CALL);
    assert.ok(callIndex >= 0, `${script} must invoke ${GUARD}`);
    assert.ok(
      callIndex > copyIndex,
      `${script} must run the guard after "${LIBS_COPY}", not before`,
    );

    const call = content.slice(callIndex, callIndex + 240);
    assert.ok(
      call.includes("/opt/chemistry/libs"),
      `the guard call must check /opt/chemistry/libs`,
    );
    assert.ok(call.includes('"$LIB_DIR"'), `the guard call must check the bundled lib dir`);
    assert.ok(
      content.includes("LIB_DIR=/app/src-tauri/lib/linux-x86_64"),
      `${script} must point LIB_DIR at src-tauri/lib/linux-x86_64`,
    );
    assert.ok(
      content.includes("LIB_SNAPSHOT=$(mktemp -d)") && content.includes("trap restore_libs EXIT"),
      `${script} must snapshot the host lib dir and restore it on exit`,
    );
    assert.doesNotMatch(
      content,
      /! -name ['"]libindigo\.so['"]/,
      `${script} must not delete host libs from the bind-mounted checkout`,
    );
  });
}

test("the guard accepts a directory shipping only Indigo libraries", () => {
  const dir = makeTempDir(["libindigo.so", "libindigo-renderer.so"]);
  try {
    const result = runGuard([dir]);
    assert.equal(result.status, 0, `expected exit 0, got ${guardOutput(result)}`);
    assert.equal(
      guardOutput(result),
      "",
      `a clean directory must produce no output, got: ${guardOutput(result)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard rejects a directory holding libimago", () => {
  const dir = makeTempDir(["libindigo.so", "libimago.so"]);
  try {
    const result = runGuard([dir]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got: ${output}`);
    assert.match(output, /libimago\.so/, "the failure must name the offending file");
    assert.match(output, /rebuild/i, "the failure must tell the operator to rebuild the image");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard rejects a directory holding an OpenCV library", () => {
  const dir = makeTempDir(["libopencv_core.so.406"]);
  try {
    const result = runGuard([dir]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got: ${output}`);
    assert.match(output, /libopencv_core\.so\.406/, "the failure must name the offending file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard rejects a mixed set of directories", () => {
  const clean = makeTempDir(["libindigo.so", "libindigo-renderer.so"]);
  const dirty = makeTempDir(["libimago.so"]);
  try {
    const result = runGuard([clean, dirty]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `one dirty directory must fail the build, got: ${output}`);
    assert.match(output, /libimago\.so/, "the failure must name the offending file");
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("the guard matches forbidden names case-insensitively", () => {
  const dir = makeTempDir(["LIBIMAGO.SO"]);
  try {
    const result = runGuard([dir]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got: ${output}`);
    assert.match(output, /LIBIMAGO\.SO/, "the failure must name the offending file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard rejects a broken imago symlink", () => {
  const dir = makeTempDir([]);
  symlinkSync("nowhere", path.join(dir, "libimago.so"));
  try {
    const result = runGuard([dir]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got: ${output}`);
    assert.match(output, /libimago\.so/, "the failure must name the offending symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the allowlist rejects a bundle file the builder image does not provide", () => {
  const source = makeTempDir(["libindigo.so", "libindigo-renderer.so"]);
  const target = makeTempDir(["libindigo.so", "libjpeg.so"]);
  try {
    const result = runGuardWithAllowlist(source, [target]);
    const output = guardOutput(result);

    assert.notEqual(result.status, 0, `an unlisted file must fail the build, got: ${output}`);
    assert.match(output, /libjpeg\.so/, "the failure must name the unlisted file");
    assert.match(
      output,
      /not provided by the builder image/i,
      "the failure must explain where the file should come from",
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("the allowlist accepts a bundle identical to the builder image", () => {
  const source = makeTempDir(["libindigo.so", "libindigo-renderer.so"]);
  try {
    const result = runGuardWithAllowlist(source, [source]);
    assert.equal(result.status, 0, `expected exit 0, got: ${guardOutput(result)}`);
    assert.equal(guardOutput(result), "", "the clean case must stay silent");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("the guard warns about a missing directory but passes a clean one", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "chemistry-draw-native-libs-"));
  const missing = path.join(parent, "does-not-exist");
  const clean = makeTempDir(["libindigo.so"]);
  try {
    const result = runGuard([missing, clean]);
    const output = guardOutput(result);

    assert.equal(result.status, 0, `expected exit 0, got: ${output}`);
    assert.equal(result.stdout, "", "the warning belongs on stderr");
    assert.match(
      result.stderr,
      /not found|skipping/i,
      "the guard must warn about the missing directory",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});
