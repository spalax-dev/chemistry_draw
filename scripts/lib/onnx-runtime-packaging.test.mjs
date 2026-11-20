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
// The GitHub release assets for 1.31.0 now return 404. The official NuGet
// package carries the same Linux library and Windows DLL; the PyPI wheel does
// not, so it must never be used as a fallback.
const ORT_NUPKG_SHA256 = "7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b";
const ORT_LINUX_MEMBER = "runtimes/linux-x64/native/libonnxruntime.so";
const ORT_LINUX_LIB_SHA256 = "469849977cb60744ea160927e1a3a0643fd4c55c0aff743251c6d293402e334e";
const ORT_WINDOWS_MEMBER = "runtimes/win-x64/native/onnxruntime.dll";
const ORT_WINDOWS_DLL_SHA256 = "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c";
const ORT_WINDOWS_DLL_SIZE = 17253176;

// The scripts interpolate the pinned version, so match that same shape instead
// of a frozen literal URL: bumping the pin in one place must be visible here.
function nupkgUrlPattern(versionExpression) {
  return new RegExp(
    String.raw`https://api\.nuget\.org/v3-flatcontainer/microsoft\.ml\.onnxruntime/` +
      `${versionExpression}/microsoft\\.ml\\.onnxruntime\\.${versionExpression}\\.nupkg`,
  );
}

// A `.nupkg` is a zip. The Linux fetchers extract the single member with
// Python's zipfile; `tar` cannot read it.
function assertNugetExtraction(content, script) {
  assert.match(
    content,
    /python3[\s\S]{0,600}?\bzipfile\b/,
    `${script} must extract the nupkg with Python's zipfile`,
  );
  assert.doesNotMatch(
    content,
    /^\s*tar\b.*\n?.*nupkg|\btar\b[^\n]*\$\{?ORT_PACKAGE/m,
    `${script} must not extract the nupkg with tar`,
  );
}

// Reading the first entry (or relying on a comment) would ship whatever the
// package happens to contain. The pinned member must reach the extractor.
function assertPinnedMemberExtraction(content, script, memberExpression) {
  assert.match(
    content,
    new RegExp(`python3[^\\n]*${memberExpression}`),
    `${script} must pass the pinned member to the Python zipfile extractor`,
  );
  assert.match(
    content,
    /zipfile[\s\S]{0,400}?package\.open\(member\)/,
    `${script} must open the pinned member inside the Python zipfile snippet`,
  );
}

test("build-libs.sh pins the Linux ONNX Runtime NuGet package", () => {
  const content = read("scripts/build-libs.sh");

  assert.ok(content.includes(ORT_VERSION), `build-libs.sh must pin ONNX Runtime ${ORT_VERSION}`);
  assert.match(
    content,
    nupkgUrlPattern(String.raw`\$\{ORT_VERSION\}`),
    "build-libs.sh must download the pinned Microsoft.ML.OnnxRuntime nupkg",
  );
  assert.ok(content.includes(ORT_NUPKG_SHA256), "build-libs.sh must pin the nupkg SHA-256");
  // Match the verification command itself, not just the constant: pinning the
  // hash without running sha256sum leaves the download unverified.
  assert.match(
    content,
    /sha256sum\s+-c\s+-/,
    "build-libs.sh must verify the downloaded nupkg checksum with sha256sum -c -",
  );
  // Bind the pinned hash to the check: removing the check must fail even though
  // the constant assignment remains.
  assert.match(
    content,
    /\$ORT_SHA256[^\n]*sha256sum/,
    "build-libs.sh must verify the downloaded nupkg against $ORT_SHA256 with sha256sum",
  );

  // Pin the exact member: a package that moves the library must fail here
  // before a package ships without a runtime.
  assert.ok(content.includes(ORT_LINUX_MEMBER), `build-libs.sh must extract ${ORT_LINUX_MEMBER}`);
  assert.ok(
    content.includes(ORT_LINUX_LIB_SHA256),
    "build-libs.sh must pin the extracted libonnxruntime.so SHA-256",
  );
  assert.match(
    content,
    /\$ORT_LIB_SHA256[^\n]*sha256sum/,
    "build-libs.sh must verify the extracted library against $ORT_LIB_SHA256 with sha256sum",
  );
  assertNugetExtraction(content, "build-libs.sh");
  assertPinnedMemberExtraction(content, "build-libs.sh", String.raw`"\$ORT_MEMBER"`);

  // One real file plus the .so.1/.so symlinks: extracting must not produce
  // three copies of the 29 MB library.
  assert.match(
    content,
    /ln -sfn "\$\{?ORT_REAL\}?"/,
    "build-libs.sh must link libonnxruntime.so.1 to the real file",
  );
  assert.match(
    content,
    /ln -sfn "[^"]*libonnxruntime\.so\.1"/,
    "build-libs.sh must link libonnxruntime.so to libonnxruntime.so.1",
  );
  assert.match(
    content,
    /did not produce the shared library chain/,
    "build-libs.sh must keep the chain check",
  );
  assert.doesNotMatch(
    content,
    /ORT_LIB_DIR|onnxruntime-linux-x64-\$\{ORT_VERSION\}\/lib/,
    "build-libs.sh must not keep the old tarball layout",
  );
});

test("fetch-onnxruntime.sh pins the Linux ONNX Runtime NuGet package", () => {
  const content = read("scripts/fetch-onnxruntime.sh");

  assert.match(
    content,
    nupkgUrlPattern(String.raw`\$\{VERSION\}`),
    "fetch-onnxruntime.sh must download the pinned Microsoft.ML.OnnxRuntime nupkg",
  );
  assert.ok(content.includes(ORT_NUPKG_SHA256), "fetch-onnxruntime.sh must pin the nupkg SHA-256");
  assert.ok(
    content.includes(ORT_LINUX_MEMBER),
    `fetch-onnxruntime.sh must extract ${ORT_LINUX_MEMBER}`,
  );
  assert.ok(
    content.includes(ORT_LINUX_LIB_SHA256),
    "fetch-onnxruntime.sh must verify the extracted library SHA-256",
  );
  // The download is only verified when the computed hash is compared to the
  // pin; deleting the comparison must fail while the constants survive.
  assert.match(
    content,
    /\[\[\s*"\$\{ACTUAL_SHA256\}"\s*!=\s*"\$\{SHA256\}"\s*\]\]/,
    "fetch-onnxruntime.sh must compare the nupkg hash to the pinned SHA256",
  );
  assert.match(
    content,
    /\[\[\s*"\$\{ACTUAL_LIB_SHA256\}"\s*!=\s*"\$\{LIB_SHA256\}"\s*\]\]/,
    "fetch-onnxruntime.sh must compare the extracted library hash to the pinned LIB_SHA256",
  );
  assertNugetExtraction(content, "fetch-onnxruntime.sh");
  assertPinnedMemberExtraction(content, "fetch-onnxruntime.sh", String.raw`"\$\{MEMBER\}"`);
  assert.match(
    content,
    /ln -sfn "[^"]*libonnxruntime\.so\.\$\{?VERSION\}?"/,
    "fetch-onnxruntime.sh must link libonnxruntime.so.1 to the real file",
  );
  assert.match(
    content,
    /ln -sfn "[^"]*libonnxruntime\.so\.1"/,
    "fetch-onnxruntime.sh must link libonnxruntime.so to libonnxruntime.so.1",
  );
  assert.match(
    content,
    /mktemp[^\n]*\.nupkg/,
    "fetch-onnxruntime.sh must keep the .nupkg temp suffix",
  );
});

test("fetch-windows-libs.ps1 pins the Windows ONNX Runtime NuGet package", () => {
  const content = read("scripts/fetch-windows-libs.ps1");

  assert.match(
    content,
    /^\$OnnxRuntimeVersion = "1\.31\.0"$/m,
    `fetch-windows-libs.ps1 must pin ONNX Runtime ${ORT_VERSION}`,
  );
  assert.match(
    content,
    nupkgUrlPattern(String.raw`\$OnnxRuntimeVersion`),
    "fetch-windows-libs.ps1 must download the pinned Microsoft.ML.OnnxRuntime nupkg",
  );
  assert.ok(
    content.includes(ORT_NUPKG_SHA256),
    "fetch-windows-libs.ps1 must pin the nupkg SHA-256",
  );
  assert.match(
    content,
    /Get-FileHash[\s\S]*?SHA256|SHA256[\s\S]*?Get-FileHash/i,
    "fetch-windows-libs.ps1 must verify the downloaded nupkg hash",
  );
  // Each check must compare the computed value to its pin: deleting only the
  // comparison must fail even though the constant assignment remains.
  assert.match(
    content,
    /\$actualOrtSha256\s+-ne\s+\$OnnxRuntimeSha256/,
    "fetch-windows-libs.ps1 must compare the nupkg hash to $OnnxRuntimeSha256",
  );
  assert.ok(
    content.includes(ORT_WINDOWS_DLL_SHA256),
    "fetch-windows-libs.ps1 must pin the extracted DLL SHA-256",
  );
  assert.match(
    content,
    /\$ortDllSha256\s+-ne\s+\$OnnxRuntimeDllSha256/,
    "fetch-windows-libs.ps1 must compare the DLL hash to $OnnxRuntimeDllSha256",
  );
  assert.ok(
    content.includes(String(ORT_WINDOWS_DLL_SIZE)),
    "fetch-windows-libs.ps1 must pin the extracted DLL size",
  );
  assert.match(
    content,
    /\$ortDllSize\s+-ne\s+\$OnnxRuntimeDllSize/,
    "fetch-windows-libs.ps1 must compare the DLL size to $OnnxRuntimeDllSize",
  );

  // Entry-level extraction: a nupkg is a zip archive, and expanding it as a
  // folder would write every runtime and metadata file. The contract is "one
  // entry only".
  assert.ok(
    content.includes(`$ortEntryPath = "${ORT_WINDOWS_MEMBER}"`),
    `fetch-windows-libs.ps1 must pin the exact ${ORT_WINDOWS_MEMBER} entry`,
  );
  assert.match(
    content,
    /\[System\.IO\.Compression\.ZipFile\]::OpenRead\(\$ortPackagePath\)/,
    "fetch-windows-libs.ps1 must open the ONNX Runtime nupkg as a zip",
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
    "fetch-windows-libs.ps1 must not expand the whole ONNX Runtime nupkg",
  );
  assert.doesNotMatch(
    content,
    /onnxruntime-win-x64-|onnxruntime-win-x64-\$OnnxRuntimeVersion\/lib/,
    "fetch-windows-libs.ps1 must not keep the old zip layout",
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
