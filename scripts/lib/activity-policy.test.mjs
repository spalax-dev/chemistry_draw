import assert from "node:assert/strict";
import { test } from "node:test";

import { validateActivities } from "./activity-policy.mjs";

/** Build a task with the agent its phase requires, unless overridden. */
function task(id, phase, overrides = {}) {
  return {
    id,
    phase,
    description: `${phase} task ${id}`,
    status: "pending",
    agent: phase === "review" ? "reviewer" : "implementer",
    ...overrides,
  };
}

/** Build a complete non-docs activity in valid phase order. */
function activity(overrides = {}) {
  return {
    id: 1,
    type: "feat",
    name: "fixture",
    title: "Fixture activity",
    description: "Activity used by the policy tests.",
    acceptance: ["policy passes"],
    tasks: [task("a", "docs"), task("b", "test"), task("c", "implement"), task("d", "review")],
    status: "pending",
    ...overrides,
  };
}

const payload = (...activities) => ({ activities });

/** Assert that at least one error matches each pattern. */
function assertError(errors, ...patterns) {
  for (const pattern of patterns) {
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `expected an error matching ${pattern}, got:\n${errors.join("\n")}`,
    );
  }
}

test("accepts a non-docs activity with docs → test → implement → review", () => {
  const { errors, warnings } = validateActivities(payload(activity()));

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("accepts several consecutive implement tasks", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [
          task("a", "docs"),
          task("b", "test"),
          task("c", "implement"),
          task("d", "implement"),
          task("e", "implement"),
          task("f", "review"),
        ],
      }),
    ),
  );

  assert.deepEqual(errors, []);
});

test("accepts a docs-only activity with docs → review", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        type: "docs",
        tasks: [task("a", "docs"), task("b", "review")],
      }),
    ),
  );

  assert.deepEqual(errors, []);
});

test("rejects a non-docs activity without a docs task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("b", "test"), task("c", "implement"), task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1.*missing required phase "docs"/);
});

test("rejects a non-docs activity without a test task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("c", "implement"), task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1.*missing required phase "test"/);
});

test("rejects a non-docs activity without an implement task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "test"), task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1.*missing required phase "implement"/);
});

test("rejects a non-docs activity without a review task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "test"), task("c", "implement")],
      }),
    ),
  );

  assertError(errors, /Activity 1.*missing required phase "review"/);
});

test("rejects a test phase that comes after implementation", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "implement"), task("c", "test"), task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1 task c.*phase "test" comes after "implement"/);
});

test("rejects a docs phase that comes after tests", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "test"), task("b", "docs"), task("c", "implement"), task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1 task b.*phase "docs" comes after "test"/);
});

test("rejects a review phase that comes before implementation", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "test"), task("c", "review"), task("d", "implement")],
      }),
    ),
  );

  assertError(errors, /Activity 1 task d.*phase "implement" comes after "review"/);
});

test("rejects a docs-only activity missing a docs task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        type: "docs",
        tasks: [task("b", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1: docs-only activity requires a "docs" task/);
});

test("rejects a docs-only activity missing a review task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        type: "docs",
        tasks: [task("a", "docs")],
      }),
    ),
  );

  assertError(errors, /Activity 1: docs-only activity requires a "review" task/);
});

test("rejects a task with the phase property omitted", () => {
  const noPhase = task("c", "implement");
  delete noPhase.phase;

  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "test"), noPhase, task("d", "review")],
      }),
    ),
  );

  assertError(errors, /Activity 1 task c: invalid phase "undefined"/);
});

test("rejects a test task in_progress while the docs task is pending", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs"),
          task("b", "test", { status: "in_progress" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1 task b: cannot be "in_progress" while earlier task "a" is "pending"/,
  );
});

test("rejects an implement task in_progress while the test task is pending", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "done" }),
          task("b", "test"),
          task("c", "implement", { status: "in_progress" }),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1 task c: cannot be "in_progress" while earlier task "b" is "pending"/,
  );
});

test("rejects a test task in_progress while the docs task is blocked", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "blocked" }),
          task("b", "test", { status: "in_progress" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1 task b: cannot be "in_progress" while earlier task "a" is "blocked"/,
  );
});

test("rejects a done task while an earlier task is pending", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [
          task("a", "docs", { status: "done" }),
          task("b", "test"),
          task("c", "implement", { status: "done" }),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(errors, /Activity 1 task c: cannot be "done" while earlier task "b" is "pending"/);
});

test("accepts a done docs task followed by an in_progress test task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "done" }),
          task("b", "test", { status: "in_progress" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assert.deepEqual(errors, []);
});

test("accepts a done activity with every task done", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "done",
        tasks: [
          task("a", "docs", { status: "done" }),
          task("b", "test", { status: "done" }),
          task("c", "implement", { status: "done" }),
          task("d", "review", { status: "done" }),
        ],
      }),
    ),
  );

  assert.deepEqual(errors, []);
});

test("accepts an in_progress activity with exactly one in_progress task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "in_progress" }),
          task("b", "test"),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assert.deepEqual(errors, []);
});

test("rejects a docs-only activity with test or implement tasks", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        type: "docs",
        tasks: [task("a", "docs"), task("b", "test"), task("c", "implement"), task("d", "review")],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1: docs-only activity must not have "test" tasks/,
    /Activity 1: docs-only activity must not have "implement" tasks/,
  );
});

test("rejects a done activity with a task that is not done", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "done",
        tasks: [
          task("a", "docs", { status: "done" }),
          task("b", "test", { status: "done" }),
          task("c", "implement", { status: "done" }),
          task("d", "review", { status: "pending" }),
        ],
      }),
    ),
  );

  assertError(errors, /Activity 1.*status "done".*task "d"/);
});

test("rejects an in_progress activity with no in_progress task", () => {
  const { errors } = validateActivities(payload(activity({ status: "in_progress" })));

  assertError(errors, /Activity 1: status "in_progress" requires exactly one in_progress task/);
});

test("rejects an in_progress activity with more than one in_progress task", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "in_progress" }),
          task("b", "test", { status: "in_progress" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(errors, /Activity 1: status "in_progress" requires exactly one in_progress task/);
});

test("rejects more than one in_progress activity", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        id: 1,
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "in_progress" }),
          task("b", "test"),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
      activity({
        id: 2,
        status: "in_progress",
        tasks: [
          task("a", "docs", { status: "in_progress" }),
          task("b", "test"),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(errors, /More than one activity is in_progress/);
});

test("rejects an invalid task phase", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [task("a", "docs"), task("b", "test"), task("c", "implement"), task("d", "deploy")],
      }),
    ),
  );

  assertError(errors, /Activity 1 task d: invalid phase "deploy"/);
});

test("rejects an incorrect agent mapping", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [
          task("a", "docs", { agent: "reviewer" }),
          task("b", "test"),
          task("c", "implement"),
          task("d", "review", { agent: "implementer" }),
        ],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1 task a.*agent "reviewer".*phase "docs".*expected "implementer"/,
    /Activity 1 task d.*agent "implementer".*phase "review".*expected "reviewer"/,
  );
});

test("rejects an invalid activity type or task status", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        type: "epic",
        tasks: [
          task("a", "docs"),
          task("b", "test", { status: "started" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(
    errors,
    /Activity 1: invalid type "epic"/,
    /Activity 1 task b: invalid status "started"/,
  );
});

test("rejects a task without a description", () => {
  const { errors } = validateActivities(
    payload(
      activity({
        tasks: [
          task("a", "docs"),
          task("b", "test", { description: "" }),
          task("c", "implement"),
          task("d", "review"),
        ],
      }),
    ),
  );

  assertError(errors, /Activity 1 task b: missing required field "description"/);
});

test("rejects an activity without a name", () => {
  const broken = activity();
  delete broken.name;

  const { errors } = validateActivities(payload(broken));

  assertError(errors, /Activity 1: missing required field "name"/);
});

test("rejects an activity with empty acceptance criteria", () => {
  const { errors } = validateActivities(payload(activity({ acceptance: [] })));

  assertError(errors, /Activity 1: missing required acceptance criteria/);
});

test("rejects data without an activities array", () => {
  const { errors } = validateActivities({});

  assertError(errors, /activities/);
});
