/**
 * Policy validation for `activities.json`.
 *
 * Enforces the mandatory delivery order docs → test → implement → review:
 * every task declares a phase, phases never move backwards, and each phase is
 * paired with the right agent. Returns `{ errors, warnings }`; the harness
 * fails on any error.
 *
 * Docs-only activities (`type: "docs"`) are the exception: they run docs →
 * review and must not contain test/implement tasks.
 */

const ACTIVITY_TYPES = new Set(["fix", "feat", "chore", "docs"]);
const ACTIVITY_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);
const PHASES = ["docs", "test", "implement", "review"];
const PHASE_RANK = new Map(PHASES.map((phase, index) => [phase, index]));
const PHASE_AGENT = new Map([
  ["docs", "implementer"],
  ["test", "implementer"],
  ["implement", "implementer"],
  ["review", "reviewer"],
]);
const PHASE_ORDER = PHASES.join(" → ");

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const hasId = (value) =>
  isNonEmptyString(value) || (typeof value === "number" && Number.isFinite(value));

/**
 * Validate the parsed contents of `activities.json`.
 *
 * @param {unknown} data Parsed JSON: `{ activities: [...] }` or the array itself.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateActivities(data) {
  const errors = [];
  const warnings = [];
  const activities = Array.isArray(data) ? data : data?.activities;

  if (!Array.isArray(activities)) {
    errors.push('Missing "activities" array in activities.json');
    return { errors, warnings };
  }

  const running = activities.filter((activity) => activity?.status === "in_progress");
  if (running.length > 1) {
    const ids = running.map((activity) => activity?.id ?? "?").join(", ");
    errors.push(`More than one activity is in_progress: ${ids} (max 1)`);
  }

  for (const activity of activities) {
    validateActivity(activity, errors, warnings);
  }

  return { errors, warnings };
}

/** Validate one activity and append its errors/warnings. */
function validateActivity(activity, errors, warnings) {
  if (!isPlainObject(activity)) {
    errors.push("Activity entry must be an object");
    return;
  }

  const id = activity.id ?? "?";
  const prefix = `Activity ${id}`;

  if (!Number.isInteger(activity.id)) {
    errors.push(`${prefix}: missing required field "id"`);
  }
  for (const field of ["name", "title", "description"]) {
    if (!isNonEmptyString(activity[field])) {
      errors.push(`${prefix}: missing required field "${field}"`);
    }
  }
  if (!Array.isArray(activity.acceptance) || activity.acceptance.length === 0) {
    errors.push(`${prefix}: missing required acceptance criteria`);
  }
  if (!ACTIVITY_TYPES.has(activity.type)) {
    errors.push(
      `${prefix}: invalid type "${activity.type}" (allowed: ${[...ACTIVITY_TYPES].join(", ")})`,
    );
  }
  if (!ACTIVITY_STATUSES.has(activity.status)) {
    errors.push(
      `${prefix}: invalid status "${activity.status}" (allowed: ${[...ACTIVITY_STATUSES].join(", ")})`,
    );
  }
  if (!Array.isArray(activity.tasks)) {
    errors.push(`${prefix}: missing required "tasks" array`);
    return;
  }

  const phases = new Set();
  let lastRank = -1;
  let lastPhase = null;

  for (const task of activity.tasks) {
    if (!isPlainObject(task)) {
      errors.push(`${prefix}: task entry must be an object`);
      continue;
    }

    const taskId = task.id ?? "?";
    const taskPrefix = `${prefix} task ${taskId}`;

    if (!hasId(task.id)) {
      errors.push(`${taskPrefix}: missing required field "id"`);
    }
    if (!isNonEmptyString(task.description)) {
      errors.push(`${taskPrefix}: missing required field "description"`);
    }
    if (!TASK_STATUSES.has(task.status)) {
      errors.push(
        `${taskPrefix}: invalid status "${task.status}" (allowed: ${[...TASK_STATUSES].join(", ")})`,
      );
    }
    if (!PHASE_RANK.has(task.phase)) {
      errors.push(`${taskPrefix}: invalid phase "${task.phase}" (allowed: ${PHASES.join(", ")})`);
      continue;
    }

    const phase = task.phase;
    phases.add(phase);

    const expectedAgent = PHASE_AGENT.get(phase);
    if (task.agent !== expectedAgent) {
      errors.push(
        `${taskPrefix}: agent "${task.agent}" does not match phase "${phase}" (expected "${expectedAgent}")`,
      );
    }

    const rank = PHASE_RANK.get(phase);
    if (rank < lastRank) {
      errors.push(
        `${taskPrefix}: phase "${phase}" comes after "${lastPhase}" (order must be ${PHASE_ORDER})`,
      );
    } else {
      lastRank = rank;
      lastPhase = phase;
    }
  }

  validateSequentialStatus(activity.tasks, prefix, errors);
  validatePhaseRequirements(activity, phases, prefix, errors);

  for (const task of activity.tasks) {
    if (activity.status === "done" && task?.status !== "done") {
      errors.push(
        `${prefix}: status "done" requires every task to be done ` +
          `(task "${task?.id ?? "?"}" is "${task?.status}")`,
      );
    }
  }

  if (activity.status === "in_progress") {
    const active = activity.tasks.filter((task) => task?.status === "in_progress");
    if (active.length !== 1) {
      errors.push(
        `${prefix}: status "in_progress" requires exactly one in_progress task ` +
          `(found ${active.length})`,
      );
    }
  }

  const allDone =
    activity.tasks.length > 0 && activity.tasks.every((task) => task?.status === "done");
  if (activity.status === "blocked" && allDone) {
    warnings.push(`${prefix}: status "blocked" but all tasks are done`);
  }
  if (
    activity.status !== "in_progress" &&
    activity.tasks.some((task) => task?.status === "in_progress")
  ) {
    warnings.push(`${prefix}: has an in_progress task but the activity is "${activity.status}"`);
  }
}

/**
 * A task may be `done` or `in_progress` only when every earlier task is done.
 * Phase order alone is not enough: the work itself must progress in order.
 */
function validateSequentialStatus(tasks, prefix, errors) {
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!isPlainObject(task)) continue;
    if (task.status !== "done" && task.status !== "in_progress") continue;

    const blocker = tasks.slice(0, index).find((earlier) => earlier?.status !== "done");
    if (!blocker) continue;

    errors.push(
      `${prefix} task ${task.id ?? "?"}: cannot be "${task.status}" while earlier task ` +
        `"${blocker.id ?? "?"}" is "${blocker.status}"`,
    );
  }
}

/** Check the required phase set for docs-only and regular activities. */
function validatePhaseRequirements(activity, phases, prefix, errors) {
  if (activity.type === "docs") {
    if (!phases.has("docs")) {
      errors.push(`${prefix}: docs-only activity requires a "docs" task`);
    }
    if (!phases.has("review")) {
      errors.push(`${prefix}: docs-only activity requires a "review" task`);
    }
    for (const phase of ["test", "implement"]) {
      if (phases.has(phase)) {
        errors.push(`${prefix}: docs-only activity must not have "${phase}" tasks`);
      }
    }
    return;
  }

  for (const phase of PHASES) {
    if (!phases.has(phase)) {
      errors.push(`${prefix}: missing required phase "${phase}" (order: ${PHASE_ORDER})`);
    }
  }
}
