// Structural tests for the Windows release pipeline.
//
// GitHub Actions cannot be executed here, so these tests assert the contract
// the workflows must satisfy: one shared composite action builds and validates
// the installer, CI uploads it as an artifact, and the release workflow
// attaches it to the GitHub release exactly like the Linux packages.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readYaml(relativePath) {
  return parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function runSteps(steps) {
  return (steps ?? []).filter((step) => typeof step.run === "string");
}

function usesStep(steps, action) {
  return (steps ?? []).find((step) => step.uses?.startsWith(action));
}

test("the shared action builds, tests and bundles the installer", () => {
  const file = ".github/actions/windows-build/action.yml";
  assert.ok(existsSync(path.join(ROOT, file)), `missing ${file}`);

  const action = readYaml(file);
  assert.equal(action.runs?.using, "composite");

  const steps = runSteps(action.runs.steps);
  assert.ok(
    steps.some((step) => step.run.includes("fetch-windows-libs.ps1")),
    "must fetch the pinned Indigo DLLs",
  );
  assert.ok(
    steps.some((step) => step.run.includes("harness.mjs")),
    "must run the harness before bundling",
  );
  assert.ok(
    steps.some((step) => step.run.includes("tauri build --bundles nsis")),
    "must build the NSIS installer",
  );
  assert.ok(
    steps.some((step) => step.run.includes("indigo-server.exe") && step.run.includes("Copy-Item")),
    "must stage the sidecar with the target triple",
  );
});

test("ci.yml reuses the shared action and uploads the installer", () => {
  const workflow = readYaml(".github/workflows/ci.yml");
  const job = workflow.jobs?.windows;
  assert.ok(job, "ci.yml must keep a windows job");
  assert.equal(job["runs-on"], "windows-latest");
  assert.ok(
    usesStep(job.steps, "./.github/actions/windows-build"),
    "ci must call the shared action instead of duplicating the build",
  );

  const upload = usesStep(job.steps, "actions/upload-artifact");
  assert.ok(upload, "ci must upload the installer artifact");
  assert.match(String(upload.with?.path), /bundle\/nsis\/\*\.exe/);
  assert.equal(
    usesStep(job.steps, "softprops/action-gh-release"),
    undefined,
    "ci must not publish releases",
  );
});

test("release.yml builds Windows with the same gating as Linux", () => {
  const workflow = readYaml(".github/workflows/release.yml");
  const job = workflow.jobs?.["windows-packages"];
  assert.ok(job, "release.yml must add a windows-packages job");
  assert.equal(job["runs-on"], "windows-latest");
  assert.deepEqual(job.needs, ["release-please"], "must wait for release-please outputs");

  const condition = String(job.if ?? "");
  assert.match(condition, /needs\.release-please\.outputs\.release_created/);
  assert.match(condition, /github\.event_name == 'release'/);
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);

  assert.ok(
    usesStep(job.steps, "./.github/actions/windows-build"),
    "release must reuse the shared action",
  );
});

test("release.yml attaches the installer to the release", () => {
  const workflow = readYaml(".github/workflows/release.yml");
  const job = workflow.jobs?.["windows-packages"];
  assert.ok(job);

  const publish = usesStep(job.steps, "softprops/action-gh-release");
  assert.ok(publish, "must publish the installer with action-gh-release");
  assert.match(String(publish.with?.files), /target\/release\/bundle\/nsis\/\*\.exe/);
  assert.match(
    String(publish.with?.tag_name),
    /needs\.release-please\.outputs\.tag/,
    "must publish to the tag computed by release-please",
  );
});

test("release.yml keeps a manual artifact for workflow_dispatch", () => {
  const workflow = readYaml(".github/workflows/release.yml");
  const job = workflow.jobs?.["windows-packages"];
  assert.ok(job);

  const upload = usesStep(job.steps, "actions/upload-artifact");
  assert.ok(upload, "manual runs must upload a workflow artifact");
  assert.match(String(upload.if), /workflow_dispatch/);
  assert.match(String(upload.with?.path), /bundle\/nsis\/\*\.exe/);
});
