// Contract tests for the B3 clean-install and model-free packaging guarantees.
//
// Models are delivered at runtime into the app-data model root: no installer
// may carry `models/`, `*.onnx` or a generated manifest, and a model-less
// machine must report an unready catalog instead of a stale recognition
// capability. These tests read the real packaging scripts, the Tauri bundle
// configuration and the Windows CI smoke; they never build a package, launch
// the app or download the 324 MB of weights.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const MODEL_ROOT_REFERENCE = /\bmodels?\//i;
const ONNX_WEIGHT = /\.onnx\b/i;
const MODEL_MANIFEST = /manifest\.json/i;
const MODEL_CATALOG = /model-catalog\.json/i;
const PARENT_MODELS = /(?:^|[\s"'])\.\.\/models\b/i;

function assertNoModelPayload(file, content) {
  assert.doesNotMatch(
    content,
    MODEL_ROOT_REFERENCE,
    `${file} must not reference a models/ payload`,
  );
  assert.doesNotMatch(content, ONNX_WEIGHT, `${file} must not reference ONNX weights`);
  assert.doesNotMatch(content, MODEL_MANIFEST, `${file} must not copy a model manifest`);
  assert.doesNotMatch(content, MODEL_CATALOG, `${file} must not copy the compiled model catalog`);
  assert.doesNotMatch(content, PARENT_MODELS, `${file} must not reference ../models`);
}

// --- Packaged payloads -----------------------------------------------------

const PACKAGING_SCRIPTS = [
  "scripts/build-packages.sh",
  "scripts/build-deb.sh",
  "scripts/build-rpm.sh",
  "scripts/build-appimage.sh",
  "scripts/make-appimage.sh",
];

for (const script of PACKAGING_SCRIPTS) {
  test(`${script} keeps model weights out of the payload`, () => {
    assertNoModelPayload(script, read(script));
  });
}

test("Taskfile.yml keeps model weights out of the payload", () => {
  assertNoModelPayload("Taskfile.yml", read("Taskfile.yml"));
});

const BUNDLE_CONFIGS = [
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.linux.conf.json",
  "src-tauri/tauri.windows.conf.json",
];

test("the Tauri bundle configuration ships no model files", () => {
  for (const file of BUNDLE_CONFIGS) {
    const content = read(file);
    assertNoModelPayload(file, content);

    const { bundle = {} } = JSON.parse(content);
    const entries = [
      ...(bundle.externalBin ?? []),
      ...Object.entries(bundle.resources ?? {}).flatMap(([source, target]) => [source, target]),
    ];
    for (const entry of entries) {
      assertNoModelPayload(`${file} bundle entry "${entry}"`, String(entry));
    }
  }
});

test("the bundle keeps the Indigo sidecar and native libraries", () => {
  const configs = {
    "src-tauri/tauri.linux.conf.json": JSON.parse(read("src-tauri/tauri.linux.conf.json")),
    "src-tauri/tauri.windows.conf.json": JSON.parse(read("src-tauri/tauri.windows.conf.json")),
  };

  for (const [file, config] of Object.entries(configs)) {
    assert.ok(
      (config.bundle?.externalBin ?? []).some((entry) => entry.includes("indigo-server")),
      `${file} must keep indigo-server in externalBin`,
    );
  }

  assert.deepEqual(configs["src-tauri/tauri.linux.conf.json"].bundle?.resources, {
    "lib/linux-x86_64/**/*": "lib/linux-x86_64/",
  });
  assert.deepEqual(configs["src-tauri/tauri.windows.conf.json"].bundle?.resources, {
    "lib/windows-x86_64/*.dll": "lib/windows-x86_64/",
  });
});

test("the bundled catalog is compiled into the sidecar, not shipped as a file", () => {
  const catalog = read("src-tauri/sidecar/src/service/ml/catalog.rs");

  assert.match(
    catalog,
    /include_str!\("model-catalog\.json"\)/,
    "the sidecar must compile the catalog with include_str!, so packaging ships no catalog file",
  );
  assert.ok(
    existsSync(path.join(ROOT, "src-tauri/sidecar/src/service/ml/model-catalog.json")),
    "the compile-time catalog file must exist in the sidecar crate",
  );
});

// --- Windows clean-root smoke ---------------------------------------------

const ACTION = ".github/actions/windows-build/action.yml";
const action = parse(read(ACTION));
const runSteps = (action.runs?.steps ?? []).filter((step) => typeof step.run === "string");
const smokeStep = runSteps.find((step) => step.run.includes("INDIGO_NO_PARENT_WATCHDOG"));

function smokeRun() {
  assert.ok(
    smokeStep,
    `${ACTION} must keep a smoke step that runs the sidecar with INDIGO_NO_PARENT_WATCHDOG=1`,
  );
  return smokeStep.run;
}

function assertFieldCheck(text, field, expected, expectation) {
  const escapedField = field.replace(/\./g, "\\.");
  const patterns = [
    new RegExp(`\\.${escapedField}\\s+-ne\\s+(?:${expected})`, "i"),
    new RegExp(`-not\\s+\\$[\\w.]+(?:\\.${escapedField})\\b`, "i"),
  ];

  // A falsy field may be rejected with a bare truthiness check.
  if (expected === "\\$false" || expected === "0") {
    patterns.push(new RegExp(`if\\s*\\(\\s*\\$[\\w.]+(?:\\.${escapedField})\\s*\\)`, "i"));
  }

  assert.ok(
    patterns.some((pattern) => pattern.test(text)),
    `the Windows smoke must assert ${field} ${expectation}`,
  );
}

test("the Windows smoke starts the sidecar with an empty model root", () => {
  const smoke = smokeRun();

  assert.match(
    smoke,
    /CHEMISTRY_MODELS_DIR/,
    "the smoke must point CHEMISTRY_MODELS_DIR at an empty root",
  );
  assert.match(smoke, /RUNNER_TEMP/, "the empty model root must live under RUNNER_TEMP");
});

test("the Windows smoke asserts the empty /v2/models status", () => {
  const smoke = smokeRun();

  assert.match(smoke, /\$base\/models\b/, "the smoke must call GET /v2/models");
  assert.match(smoke, /\.StatusCode\s+-ne\s+200/, "GET /v2/models must assert a 200 status");
  assertFieldCheck(smoke, "ready", "\\$false", "false on the empty root");
  assertFieldCheck(smoke, "manifest_present", "\\$false", "false on the empty root");
  assertFieldCheck(smoke, "installed_bytes", "0", "0 on the empty root");
  assertFieldCheck(smoke, "total_bytes", "323987190", "323987190 on the empty root");
  assertFieldCheck(smoke, "download.state", "[\"']idle[\"']", "idle on the empty root");
});

test("the Windows smoke expects no recognition capability on an empty root", () => {
  const smoke = smokeRun();

  assert.doesNotMatch(
    smoke,
    /local-ocsr/,
    "a model-less runner must not expect the local-ocsr capability",
  );
  assert.match(smoke, /imago_versions/, "the smoke must inspect /v2/info imago_versions");
  assert.match(
    smoke,
    /imago_versions\)?[^\n]*\.(?:Count|Length)\s+(?:-ne\s+0|-gt\s+0)|-not\s+\$[\w.]+\.imago_versions/i,
    "the smoke must assert /v2/info imago_versions is empty",
  );
});

test("the Windows action never downloads model weights", () => {
  const allRuns = runSteps.map((step) => step.run).join("\n");

  assert.doesNotMatch(
    allRuns,
    /models\/download/i,
    "the runner must never start the model download",
  );
  assert.doesNotMatch(
    allRuns,
    /huggingface|hf\.co/i,
    "the runner must never contact the model host",
  );
});

test("the Windows smoke keeps the compatibility upload checks", () => {
  const smoke = smokeRun();

  assert.match(smoke, /imago\/uploads/, "the smoke must POST the compatibility upload");
  assert.match(smoke, /upload_id/, "the smoke must read the upload_id");
  assert.match(
    smoke,
    /00000000-0000-0000-0000-000000000000/,
    "the smoke must probe an unknown upload id",
  );
  assert.match(smoke, /\.StatusCode\s+-ne\s+404/, "an unknown upload id must be 404");
  assert.match(smoke, /imago_worker/, "/v2/health must stay free of imago_worker");
  assert.match(smoke, /\.state\b/, "the smoke must poll the recognition job state");
});

// --- Packaged clean-root smoke (documented commands) ----------------------

function extractSection(text, heading) {
  const marker = `### ${heading}`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `docs/verification.md must document "${heading}"`);

  const body = text.slice(start + marker.length);
  const end = body.search(/\n#{2,3} /);
  return end >= 0 ? body.slice(0, end) : body;
}

test("docs/verification.md documents the model-free payload inspection", () => {
  const section = extractSection(read("docs/verification.md"), "Clean install (B3)");

  assert.ok(
    section.includes("grep -Ei '\\.onnx$|/models/|manifest\\.json'"),
    "the payload absence grep must cover .onnx, models/ and manifest.json",
  );
  assert.match(
    section,
    /find [^\n]*squashfs-root[\s\S]{0,160}-iname '\*\.onnx'/,
    "the AppImage inspection must look for .onnx files",
  );
  assert.match(
    section,
    /find [^\n]*squashfs-root[\s\S]{0,160}-ipath '\*\/models\/\*'/,
    "the AppImage inspection must look for models/ paths",
  );

  for (const presence of ["usr/bin/indigo-server", "libindigo", "libonnxruntime"]) {
    assert.ok(section.includes(presence), `the payload inspection must prove ${presence} ships`);
  }
});

test("docs/verification.md documents the packaged-sidecar empty-root smoke", () => {
  const section = extractSection(read("docs/verification.md"), "Clean install (B3)");

  assert.ok(section.includes("CLEAN=$(mktemp -d)"), "the smoke must use a fresh empty model root");
  assert.match(section, /CHEMISTRY_MODELS_DIR=\$CLEAN/, "the packaged sidecar must use that root");
  assert.match(section, /"\$BASE\/v2\/models"/, "the smoke must call GET /v2/models");
  assert.match(section, /# 200/, "GET /v2/models must be documented as 200");
  assert.match(section, /"ready":\s*false/, "the empty root must report ready: false");
  assert.match(section, /"manifest_present":\s*false/, "the empty root must report no manifest");
  assert.match(section, /"installed_bytes":\s*0/, "the empty root must report 0 installed bytes");
  assert.match(section, /"total_bytes":\s*323987190/, "the catalog total must be pinned");
  assert.match(section, /"download":\s*"idle"/, "no download may run on the empty root");
  assert.match(section, /"\$BASE\/v2\/info"/, "the smoke must call GET /v2/info");
  assert.match(section, /imago_versions/, "the smoke must inspect the capability list");
  assert.match(section, /# \[\]/, "the empty root must advertise imago_versions: []");
});

test("docs/verification.md documents the packaged download, verify and inference smoke", () => {
  const section = extractSection(read("docs/verification.md"), "Clean install (B3)");

  assert.match(section, /POST "\$BASE\/v2\/models\/download"/, "the smoke must start the download");
  assert.match(section, /# 202/, "the download start must be documented as 202");
  assert.match(section, /POST "\$BASE\/v2\/models\/verify"/, "the smoke must verify the download");
  assert.match(section, /filter\/classify/, "the smoke must run the classifier");
  assert.match(section, /ocsr\/recognize/, "the smoke must run OCSR");
  assert.match(
    section,
    /find "\$CLEAN" -name '\*\.part'/,
    "the smoke must prove no partial download remains",
  );
});
