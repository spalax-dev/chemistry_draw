// Contract tests for shipping the ONNX Runtime shared library.
//
// `ort` is only the Rust binding: the inference engine is the native
// libonnxruntime, loaded dynamically through ORT_DYLIB_PATH. In development it
// comes from `.ort/`, so without these packaging contracts a release build
// silently ships no runtime and the classifier answers 503. These tests pin the
// download URLs and hashes, the symlink-preserving copy and the allowlist
// behaviour before the scripts implement them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const ORT_VERSION = "1.31.0";
const ORT_LINUX_URL =
  "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-x64-1.31.0.tgz";
const ORT_LINUX_SHA256 = "cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57";
const ORT_WINDOWS_URL =
  "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-win-x64-1.31.0.zip";
const ORT_WINDOWS_SHA256 = "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195";

test("build-libs.sh pins the Linux ONNX Runtime artifact", () => {
  const content = read("scripts/build-libs.sh");

  assert.ok(content.includes(ORT_VERSION), `build-libs.sh must pin ONNX Runtime ${ORT_VERSION}`);
  assert.ok(
    content.includes(ORT_LINUX_URL),
    "build-libs.sh must download the pinned Linux ONNX Runtime archive",
  );
  assert.ok(content.includes(ORT_LINUX_SHA256), "build-libs.sh must pin the Linux archive SHA-256");
  // Match the verification command itself, not just the constant: pinning the
  // hash without running sha256sum leaves the archive unverified.
  assert.match(
    content,
    /sha256sum\s+-c\s+-/,
    "build-libs.sh must verify the downloaded archive checksum with sha256sum -c -",
  );
  assert.match(content, /\btar\b/, "build-libs.sh must extract the Linux tarball");

  // Pin the exact archive layout, not just the file name: an upstream archive
  // that moves the libraries must fail here before a package ships without a
  // runtime.
  assert.ok(
    content.includes('ORT_LIB_DIR="onnxruntime-linux-x64-${ORT_VERSION}/lib"'),
    "build-libs.sh must extract from onnxruntime-linux-x64-${ORT_VERSION}/lib/",
  );
  for (const member of [
    '"${ORT_LIB_DIR}/libonnxruntime.so"',
    '"${ORT_LIB_DIR}/libonnxruntime.so.1"',
    '"${ORT_LIB_DIR}/libonnxruntime.so.${ORT_VERSION}"',
  ]) {
    assert.ok(content.includes(member), `build-libs.sh must extract exactly ${member}`);
  }
  assert.ok(
    content.includes('"${ORT_MEMBERS[@]}"'),
    "build-libs.sh must extract only the listed runtime members, not the whole archive",
  );
  assert.match(content, /\btar\b[^\n]*\n?\s*"\$\{ORT_MEMBERS\[@\]\}"/, "tar must use ORT_MEMBERS");

  const libraryLines = content.split("\n").filter((line) => line.includes("libonnxruntime.so"));
  assert.ok(
    libraryLines.length > 0,
    "build-libs.sh must extract or copy libonnxruntime.so* into the builder output",
  );
  assert.ok(
    libraryLines.some((line) => /\b(cp|tar)\b/.test(line)),
    "the libonnxruntime.so reference must be extracted or copied, not only mentioned",
  );
});

test("fetch-windows-libs.ps1 pins the Windows ONNX Runtime artifact", () => {
  const content = read("scripts/fetch-windows-libs.ps1");

  assert.match(
    content,
    /^\$OnnxRuntimeVersion = "1\.31\.0"$/m,
    `fetch-windows-libs.ps1 must pin ONNX Runtime ${ORT_VERSION}`,
  );
  assert.ok(
    content.includes(ORT_WINDOWS_URL),
    "fetch-windows-libs.ps1 must download the pinned Windows ONNX Runtime archive",
  );
  assert.ok(
    content.includes(ORT_WINDOWS_SHA256),
    "fetch-windows-libs.ps1 must pin the Windows archive SHA-256",
  );
  assert.match(
    content,
    /Get-FileHash[\s\S]*?SHA256|SHA256[\s\S]*?Get-FileHash/i,
    "fetch-windows-libs.ps1 must verify the downloaded archive hash",
  );
  assert.match(content, /onnxruntime\.dll/, "fetch-windows-libs.ps1 must extract onnxruntime.dll");

  // Entry-level extraction: expanding the whole 82.9 MB archive writes the
  // 429 MB temp tree (PDB, headers). The contract is "one entry only".
  assert.ok(
    content.includes(
      '$ortEntryPath = "onnxruntime-win-x64-$OnnxRuntimeVersion/lib/onnxruntime.dll"',
    ),
    "fetch-windows-libs.ps1 must pin the exact onnxruntime-win-x64-<version>/lib/ entry",
  );
  assert.match(
    content,
    /\[System\.IO\.Compression\.ZipFile\]::OpenRead\(\$ortZipPath\)/,
    "fetch-windows-libs.ps1 must open the ONNX Runtime zip as an archive",
  );
  assert.match(
    content,
    /\.GetEntry\(\$ortEntryPath\)/,
    "fetch-windows-libs.ps1 must extract the onnxruntime.dll entry directly",
  );
  assert.match(
    content,
    /ExtractToFile\(\$ortEntry, \$ortDestination, \$true\)/,
    "fetch-windows-libs.ps1 must extract the single entry to the output directory",
  );
  assert.doesNotMatch(
    content,
    /Expand-Archive/,
    "fetch-windows-libs.ps1 must not expand the whole ONNX Runtime archive",
  );
});

const PACKAGING_FILES = [
  "scripts/build-deb.sh",
  "scripts/build-rpm.sh",
  "scripts/build-appimage.sh",
  "scripts/build-packages.sh",
  "Taskfile.yml",
  ".github/workflows/ci.yml",
];

test("packaging copies builder libs with cp -a", () => {
  for (const file of PACKAGING_FILES) {
    const copyLines = read(file)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("/opt/chemistry/libs/*.so*"));

    assert.ok(copyLines.length > 0, `${file} must copy /opt/chemistry/libs/*.so*`);
    for (const line of copyLines) {
      assert.match(
        line,
        /(?:^|\s)cp\s+-a\s+\/opt\/chemistry\/libs\/\*\.so\*/,
        `${file} must preserve the libonnxruntime symlink chain with "cp -a": ${line}`,
      );
    }
  }
});

const REPACK = "scripts/repack-native-payload.sh";

test("packaging scripts restore the ONNX Runtime chain after bundling", () => {
  // Tauri's resource copier dereferences symlinks, so removing any of these
  // invocations ships three 29 MB copies instead of one file plus two links.
  const invocations = [
    ["scripts/build-deb.sh", "deb"],
    ["scripts/build-rpm.sh", "rpm"],
    ["scripts/build-packages.sh", "deb"],
    ["scripts/build-packages.sh", "rpm"],
  ];

  for (const [file, format] of invocations) {
    assert.match(
      read(file),
      new RegExp(`^\\s*bash\\s+${REPACK.replaceAll("/", "\\/")}\\s+${format}\\b`, "m"),
      `${file} must run the repack script for the ${format} payload`,
    );
  }
});

test("the repack script pins the shipped ONNX Runtime and restores its chain", () => {
  const content = read(REPACK);

  assert.match(
    content,
    /^ORT_VERSION="1\.31\.0"$/m,
    "repack-native-payload.sh must pin the same ONNX Runtime as the fetchers",
  );
  assert.match(
    content,
    /^ORT_REAL="libonnxruntime\.so\.\$\{ORT_VERSION\}"$/m,
    "the repack must address the real runtime file by the pinned version",
  );
  assert.match(
    content,
    /ln -s libonnxruntime\.so\.1 "\$lib_dir\/libonnxruntime\.so"/,
    "the repack must restore libonnxruntime.so -> libonnxruntime.so.1",
  );
  assert.match(
    content,
    /ln -s "\$ORT_REAL" "\$lib_dir\/libonnxruntime\.so\.1"/,
    "the repack must restore libonnxruntime.so.1 -> libonnxruntime.so.1.31.0",
  );
});

test("the repack reads RPM metadata without eval", () => {
  const content = read(REPACK);

  // `eval` on rpm output would execute package metadata as shell code.
  assert.doesNotMatch(content, /^\s*eval\b/m, "repack-native-payload.sh must not eval rpm output");

  const fields = ["NAME", "VERSION", "RELEASE", "ARCH", "SUMMARY", "LICENSE", "GROUP"];
  for (const field of fields) {
    assert.ok(
      content.includes(`rpm -qp --qf '%{${field}}'`),
      `the repack must read the ${field} field in its own quoted rpm query`,
    );
  }
});

test("the repack fails cleanly when the builder runtime is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chemistry-draw-repack-"));
  const scriptDir = path.join(root, "scripts");
  mkdirSync(scriptDir, { recursive: true });
  copyFileSync(path.join(ROOT, REPACK), path.join(scriptDir, path.basename(REPACK)));
  mkdirSync(path.join(root, "src-tauri", "lib", "linux-x86_64"), { recursive: true });
  const packagePath = path.join(root, "chemistry-draw.deb");
  writeFileSync(packagePath, "not a real package");

  try {
    const result = spawnSync(
      "bash",
      [path.join(scriptDir, path.basename(REPACK)), "deb", packagePath],
      { encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0, "a missing runtime must fail the repack");
    assert.match(output, /missing builder runtime/i, "the failure must name the missing runtime");
    assert.match(
      output,
      /libonnxruntime\.so\.1\.31\.0/,
      "the failure must name the pinned runtime file",
    );
    assert.match(output, /task libs/, "the failure must point at the fix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const GUARD = "scripts/check-native-libs.sh";
const GUARD_PATH = path.join(ROOT, GUARD);

function guardOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// The builder provides the `.so -> .so.1 -> .so.1.31.0` chain: one regular
// file plus two symlinks.
function makeOrtChainDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chemistry-draw-ort-"));
  const real = `libonnxruntime.so.${ORT_VERSION}`;
  writeFileSync(path.join(dir, real), "not a real library");
  symlinkSync(real, path.join(dir, "libonnxruntime.so.1"));
  symlinkSync("libonnxruntime.so.1", path.join(dir, "libonnxruntime.so"));
  return dir;
}

test("the allowlist accepts the shipped ONNX Runtime", () => {
  const source = makeOrtChainDir();
  const target = makeOrtChainDir();
  try {
    const result = spawnSync("bash", [GUARD_PATH, "--allowlist", source, source, target], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `expected exit 0, got: ${guardOutput(result)}`);
    assert.equal(guardOutput(result), "", "the clean runtime chain must stay silent");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("the allowlist rejects a runtime file the builder does not provide", () => {
  const source = makeOrtChainDir();
  const target = makeOrtChainDir();
  writeFileSync(path.join(target, "libonnxruntime.so.9"), "not a real library");
  try {
    const result = spawnSync("bash", [GUARD_PATH, "--allowlist", source, source, target], {
      encoding: "utf8",
    });
    const output = guardOutput(result);

    assert.notEqual(
      result.status,
      0,
      `an unlisted runtime file must fail the build, got: ${output}`,
    );
    assert.match(output, /libonnxruntime\.so\.9/, "the failure must name the unlisted file");
    assert.match(
      output,
      /not provided by the builder image/i,
      "the failure must explain where the runtime should come from",
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// Model weights stay download-only: packaging must never ship `models/` or an
// `.onnx` artifact.
const MODEL_WEIGHT_COPY =
  /^\s*(?:cp|install|rsync|scp|tar|Copy-Item)\b[^\n]*(?:models[\\/]|\.onnx\b)/im;

test("no packaging script bundles model weights", () => {
  for (const file of PACKAGING_FILES) {
    assert.doesNotMatch(
      read(file),
      MODEL_WEIGHT_COPY,
      `${file} must not copy models/ or *.onnx into a package`,
    );
  }
});
