/**
 * harness-lib.spec.mjs — pure logic tests for the two-stage harness.
 *
 * Copy to `scripts/harness-lib.spec.mjs`. No dependencies; runs in <1 s:
 *   node --test scripts/harness-lib.spec.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeStory,
  claimErrors,
  classifyChangedFiles,
  currentBatch,
  describeMode,
  findStory,
  modeForStep,
  parseBacklog,
  pathMatchesTouches,
  planBatches,
  storyActivities,
  storyIsComplete,
  touchesOverlap,
  validateActivities,
} from "./harness-lib.mjs";

const BACKLOG = `# Backlog

## US-001 — Log in
- status: active
- value: access the product without asking support
- acceptance:
  - email and password authenticate a user
  - invalid credentials return a safe error
- open questions:
  - password reset in this story?

## US-002 — Export reports
- status: pending
- value: deliver reports without opening the system
- acceptance:
  - export the current report

## Not a story
- status: ignored
`;

function activities() {
  return [
    {
      id: "ACT-01",
      storyId: "US-001",
      name: "user-model",
      status: "pending",
      dependsOn: [],
      touches: ["src/auth/model/", "db/migrations/"],
      tasks: [{ id: "T-01", description: "users table", status: "pending" }],
    },
    {
      id: "ACT-02",
      storyId: "US-001",
      name: "auth-contract",
      status: "pending",
      dependsOn: ["ACT-01"],
      touches: ["src/auth/http/", "docs/openapi/"],
      tasks: [{ id: "T-01", description: "OpenAPI", status: "pending" }],
    },
    {
      id: "ACT-03",
      storyId: "US-001",
      name: "auth-tests",
      status: "pending",
      dependsOn: ["ACT-02"],
      touches: ["src/auth/http/"],
      tasks: [{ id: "T-01", description: "specs", status: "pending" }],
    },
    {
      id: "ACT-04",
      storyId: "US-001",
      name: "auth-ui",
      status: "pending",
      dependsOn: [],
      touches: ["src/auth/ui/"],
      tasks: [{ id: "T-01", description: "login form", status: "pending" }],
    },
  ];
}

test("parseBacklog reads id, title, status, value and bullets", () => {
  const { stories, errors } = parseBacklog(BACKLOG);
  assert.deepEqual(errors, []);
  assert.equal(stories.length, 2);
  const login = findStory(stories, "US-001");
  assert.equal(login.title, "Log in");
  assert.equal(login.status, "active");
  assert.equal(login.value, "access the product without asking support");
  assert.equal(login.acceptance.length, 2);
  assert.equal(login.questions.length, 1);
  assert.equal(activeStory(stories).id, "US-001");
});

test("parseBacklog reports missing and invalid statuses", () => {
  const { errors } = parseBacklog(`## US-010 — No status\n- value: x\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing "- status:"/);

  const invalid = parseBacklog(`## US-011 — Wrong\n- status: doing\n`);
  assert.equal(invalid.errors.length, 1);
  assert.match(invalid.errors[0], /invalid status/);
});

test("validateActivities accepts a coherent plan", () => {
  const { stories } = parseBacklog(BACKLOG);
  assert.deepEqual(validateActivities(activities(), stories), []);
});

test("validateActivities rejects a missing storyId and unknown story", () => {
  const { stories } = parseBacklog(BACKLOG);
  const plan = activities();
  delete plan[0].storyId;
  plan[1].storyId = "US-999";
  const errors = validateActivities(plan, stories);
  assert.ok(errors.some((error) => /missing required field "storyId"/.test(error)));
  assert.ok(errors.some((error) => /US-999/.test(error)));
});

test("validateActivities rejects dependency cycles and self-dependency", () => {
  const { stories } = parseBacklog(BACKLOG);
  const plan = activities();
  plan[0].dependsOn = ["ACT-04"];
  plan[3].dependsOn = ["ACT-01"];
  const errors = validateActivities(plan, stories);
  assert.ok(errors.some((error) => /dependency cycle/.test(error)));
});

test("validateActivities requires at least one task and touches", () => {
  const { stories } = parseBacklog(BACKLOG);
  const plan = activities();
  plan[0].tasks = [];
  plan[0].touches = [];
  const errors = validateActivities(plan, stories);
  assert.ok(errors.some((error) => /at least one task/.test(error)));
  assert.ok(errors.some((error) => /"touches" is required/.test(error)));
});

test("planBatches parallelizes independent activities and serializes conflicts", () => {
  const { batches } = planBatches(activities(), "US-001");
  assert.deepEqual(
    batches.map((batch) => batch.map((activity) => activity.id)),
    [["ACT-01", "ACT-04"], ["ACT-02"], ["ACT-03"]],
  );
});

test("planBatches keeps conflicting ready activities in separate batches", () => {
  const plan = activities();
  plan[3].touches = ["src/auth/model/entities/"];
  const { batches } = planBatches(plan, "US-001");
  assert.deepEqual(
    batches.map((batch) => batch.map((activity) => activity.id)),
    [["ACT-01"], ["ACT-02", "ACT-04"], ["ACT-03"]],
  );
});

test("planBatches only schedules the requested story", () => {
  const plan = activities();
  plan.push({
    id: "ACT-09",
    storyId: "US-002",
    name: "export",
    status: "pending",
    dependsOn: [],
    touches: ["src/reports/"],
    tasks: [{ id: "T-01", description: "export", status: "pending" }],
  });
  const { batches } = planBatches(plan, "US-002");
  assert.deepEqual(
    batches.map((batch) => batch.map((activity) => activity.id)),
    [["ACT-09"]],
  );
});

test("planBatches reports a blocked activity and its missing dependency", () => {
  const plan = activities();
  plan[1].status = "blocked";
  const { blocked } = planBatches(plan, "US-001");
  assert.deepEqual(blocked, [{ id: "ACT-02", missing: ["ACT-01"] }]);
});

test("currentBatch returns the first batch with pending work", () => {
  const { batches } = planBatches(activities(), "US-001");
  const schedule = { batches };
  assert.deepEqual(
    currentBatch(schedule).map((activity) => activity.id),
    ["ACT-01", "ACT-04"],
  );
  schedule.batches[0].forEach((activity) => (activity.status = "done"));
  assert.deepEqual(
    currentBatch(schedule).map((activity) => activity.id),
    ["ACT-02"],
  );
});

test("claimErrors enforces dependencies, batch membership and status", () => {
  const plan = activities();
  const schedule = { batches: planBatches(plan, "US-001").batches };
  assert.deepEqual(claimErrors(plan[0], plan, schedule), []);
  assert.ok(claimErrors(plan[1], plan, schedule).some((error) => /not ready/.test(error)));
  assert.ok(
    claimErrors(plan[1], plan, schedule).some((error) => /not in the current batch/.test(error)),
  );
  plan[0].status = "done";
  assert.ok(claimErrors(plan[0], plan, schedule).some((error) => /already done/.test(error)));
});

test("storyIsComplete requires every scoped activity to be done", () => {
  const plan = activities();
  assert.equal(storyIsComplete(plan, "US-001"), false);
  plan.forEach((activity) => (activity.status = "done"));
  assert.equal(storyIsComplete(plan, "US-001"), true);
  assert.equal(storyActivities(plan, "US-002").length, 0);
});

test("touchesOverlap compares path prefixes, not raw strings", () => {
  assert.equal(touchesOverlap(["src/auth/"], ["src/auth/http/"]), true);
  assert.equal(touchesOverlap(["src/auth/**"], ["src/auth"]), true);
  assert.equal(touchesOverlap(["src/auth/"], ["src/reports/"]), false);
  assert.equal(touchesOverlap(["docs/adr/"], ["docs/adr/README.md"]), true);
  assert.equal(touchesOverlap([""], ["src/"]), true);
});

test("pathMatchesTouches accepts files under a declared prefix", () => {
  assert.equal(pathMatchesTouches("src/auth/http/login.ts", ["src/auth/"]), true);
  assert.equal(pathMatchesTouches("./src/auth/http/login.ts", ["src/auth"]), true);
  assert.equal(pathMatchesTouches("src/reports/a.ts", ["src/auth/"]), false);
});

test("modeForStep keeps story gates strict and fast gates cheap", () => {
  const story = modeForStep("story");
  assert.equal(story.test, "all");
  assert.equal(story.build, "production");
  assert.equal(story.docsgen, "yes");
  assert.equal(story.touches, "no");

  const activity = modeForStep("activity");
  assert.equal(activity.test, "targeted");
  assert.equal(activity.touches, "yes");
  assert.equal(activity.build, "skip");

  const fast = modeForStep("fast");
  assert.equal(fast.test, "skip");
  assert.equal(fast.type, "skip");
  assert.equal(fast.docsgen, "no");

  assert.match(describeMode(story), /test=all/);
});

test("classifyChangedFiles separates code from docs", () => {
  assert.equal(classifyChangedFiles(["src/a.ts"]), "code");
  assert.equal(classifyChangedFiles(["docs/planning/overview.md"]), "docs");
});
