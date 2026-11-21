/**
 * harness-lib.mjs — pure decision logic for the two-stage harness.
 *
 * STACK: generic. Copy to `scripts/harness-lib.mjs`.
 * No I/O, no child_process, no framework imports: everything here is testable
 * with `node --test scripts/harness-lib.spec.mjs`.
 *
 * Model:
 *   PLANNING  -> BACKLOG.md + docs/planning/**  (no code, no tests)
 *   DEVELOPMENT -> story -> activities -> tasks
 *
 * An activity belongs to exactly one story (`storyId`). Activities declare
 * their dependencies (`dependsOn`) and the paths they are allowed to touch
 * (`touches`). The scheduler turns that into sequential batches of independent
 * activities that can run in parallel.
 */

export const STAGES = ["planning", "development"];

export const STATUSES = ["pending", "in_progress", "done", "blocked"];

export const STORY_STATUSES = ["pending", "active", "awaiting-approval", "done", "dropped"];

/** Activities in these states are no longer scheduled. */
const CLOSED_STATUSES = ["done", "blocked"];

/** Files the orchestrator owns; executables never write them. */
export const STATE_PATHS = ["activities.json", "BACKLOG.md", "progress/", ".harness/"];

// ─── BACKLOG.md ─────────────────────────────────────────────────────────────

/**
 * Parse BACKLOG.md user stories. Deliberately forgiving: a story only needs a
 * heading and a status. Acceptance bullets and open questions are optional.
 *
 * ## US-001 — Log in
 * - status: pending
 * - value: ...
 * - acceptance:
 *   - ...
 * - open questions:
 *   - ...
 */
export function parseBacklog(markdown) {
  const stories = [];
  const errors = [];
  const lines = String(markdown ?? "").split("\n");
  let inFence = false;
  let current = null;
  let section = null;

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const heading = /^##\s+(US-\d+)\s+[—–:-]\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      current = {
        id: heading[1],
        title: heading[2].trim(),
        status: null,
        value: "",
        acceptance: [],
        questions: [],
      };
      stories.push(current);
      section = null;
      continue;
    }

    if (!current) {
      continue;
    }
    if (/^##\s+/.test(raw)) {
      current = null;
      section = null;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const text = bullet[1].trim();
      const status = /^status:\s*(\S+)/i.exec(text);
      if (status) {
        current.status = status[1].toLowerCase();
        section = null;
        continue;
      }
      const value = /^value:\s*(.+)$/i.exec(text);
      if (value) {
        current.value = value[1].trim();
        section = null;
        continue;
      }
      if (/^acceptance:\s*$/i.test(text)) {
        section = "acceptance";
        continue;
      }
      if (/^open questions:\s*$/i.test(text)) {
        section = "questions";
        continue;
      }
      if (section === "acceptance") {
        current.acceptance.push(text);
      } else if (section === "questions") {
        current.questions.push(text);
      }
      continue;
    }

    if (!raw.trim()) {
      section = null;
    }
  }

  for (const story of stories) {
    if (!story.status) {
      errors.push(`${story.id}: missing "- status:" line`);
    } else if (!STORY_STATUSES.includes(story.status)) {
      errors.push(
        `${story.id}: invalid status "${story.status}" (expected ${STORY_STATUSES.join(", ")})`,
      );
    }
  }

  return { stories, errors };
}

export function findStory(stories, storyId) {
  return (stories ?? []).find((story) => story.id === storyId) ?? null;
}

export function activeStory(stories) {
  const active = (stories ?? []).filter((story) => story.status === "active");
  return active.length === 1 ? active[0] : null;
}

export function awaitingApprovalStory(stories) {
  return (stories ?? []).find((story) => story.status === "awaiting-approval") ?? null;
}

// ─── activities.json ────────────────────────────────────────────────────────

export function normalizeActivities(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.activities)) {
    return data.activities;
  }
  return [];
}

const ACTIVITY_FIELDS = ["id", "storyId", "name", "status", "tasks"];
const TASK_FIELDS = ["id", "description", "status"];

/** Returns an array of human-readable errors. Empty array means valid. */
export function validateActivities(activities, stories) {
  const errors = [];
  const storyIds = new Set((stories ?? []).map((story) => story.id));
  const ids = new Set();

  for (const activity of activities ?? []) {
    const label = activity?.id ?? "?";
    for (const field of ACTIVITY_FIELDS) {
      if (!(field in (activity ?? {}))) {
        errors.push(`activity ${label}: missing required field "${field}"`);
      }
    }
    if (ids.has(activity.id)) {
      errors.push(`activity ${label}: duplicate id`);
    }
    ids.add(activity.id);

    if (!storyIds.has(activity.storyId)) {
      errors.push(`activity ${label}: storyId "${activity.storyId}" does not exist in BACKLOG.md`);
    }
    if (!STATUSES.includes(activity.status)) {
      errors.push(`activity ${label}: invalid status "${activity.status}"`);
    }
    if (!Array.isArray(activity.tasks) || activity.tasks.length === 0) {
      errors.push(`activity ${label}: needs at least one task`);
    }
    if (!Array.isArray(activity.touches) || activity.touches.length === 0) {
      errors.push(`activity ${label}: "touches" is required (paths this activity may write)`);
    }
    if (activity.dependsOn !== undefined && !Array.isArray(activity.dependsOn)) {
      errors.push(`activity ${label}: "dependsOn" must be an array`);
    }

    const taskIds = new Set();
    for (const task of activity.tasks ?? []) {
      for (const field of TASK_FIELDS) {
        if (!(field in (task ?? {}))) {
          errors.push(`task ${label}/${task?.id ?? "?"}: missing field "${field}"`);
        }
      }
      if (taskIds.has(task.id)) {
        errors.push(`task ${label}/${task.id}: duplicate id`);
      }
      taskIds.add(task.id);
      if (!STATUSES.includes(task.status)) {
        errors.push(`task ${label}/${task?.id}: invalid status "${task.status}"`);
      }
    }
  }

  const byId = new Map((activities ?? []).map((activity) => [activity.id, activity]));
  for (const activity of activities ?? []) {
    for (const dependency of activity.dependsOn ?? []) {
      const target = byId.get(dependency);
      if (!target) {
        errors.push(`activity ${activity.id}: dependsOn "${dependency}" does not exist`);
        continue;
      }
      if (target.storyId !== activity.storyId) {
        errors.push(
          `activity ${activity.id}: dependsOn "${dependency}" belongs to ${target.storyId}, not ${activity.storyId}`,
        );
      }
      if (dependency === activity.id) {
        errors.push(`activity ${activity.id}: depends on itself`);
      }
    }
  }

  const cycle = findCycle(activities ?? []);
  if (cycle) {
    errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  return errors;
}

function findCycle(activities) {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (id) => {
    if (visited.has(id)) {
      return null;
    }
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    const activity = byId.get(id);
    if (!activity) {
      return null;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of activity.dependsOn ?? []) {
      const found = visit(dependency);
      if (found) {
        return found;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const activity of activities) {
    const found = visit(activity.id);
    if (found) {
      return found;
    }
  }
  return null;
}

export function storyActivities(activities, storyId) {
  return (activities ?? []).filter((activity) => activity.storyId === storyId);
}

export function storyIsComplete(activities, storyId) {
  const scoped = storyActivities(activities, storyId);
  return scoped.length > 0 && scoped.every((activity) => activity.status === "done");
}

// ─── scheduling ─────────────────────────────────────────────────────────────

function splitPattern(pattern) {
  return String(pattern)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\/\*\*$/, "")
    .replace(/\*+$/, "")
    .replace(/\/+$/, "");
}

/** True when two `touches` lists can write the same path. */
export function touchesOverlap(left, right) {
  for (const rawLeft of left ?? []) {
    const a = splitPattern(rawLeft);
    if (!a) {
      return true; // an empty pattern means "everything"
    }
    for (const rawRight of right ?? []) {
      const b = splitPattern(rawRight);
      if (!b) {
        return true;
      }
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return true;
      }
    }
  }
  return false;
}

/** True when `file` is inside one of the `touches` prefixes. */
export function pathMatchesTouches(file, touches) {
  const normalized = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  return (touches ?? []).some((pattern) => {
    const prefix = splitPattern(pattern);
    if (!prefix) {
      return true;
    }
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function conflicts(left, right) {
  return touchesOverlap(left.touches, right.touches);
}

/**
 * Build the execution schedule for one story.
 *
 * - `ready` = pending activities whose dependsOn are all done.
 * - The first conflict-free subset of `ready` becomes the next batch.
 * - Batches are sequential; everything inside a batch can run in parallel.
 *
 * Returns `{ batches: Activity[][], blocked: [{id, missing[]}] }`.
 */
export function planBatches(activities, storyId) {
  const scoped = storyActivities(activities, storyId);
  const done = new Set(
    scoped.filter((activity) => activity.status === "done").map((activity) => activity.id),
  );
  const remaining = scoped.filter((activity) => !CLOSED_STATUSES.includes(activity.status));
  const blocked = scoped
    .filter((activity) => activity.status === "blocked")
    .map((activity) => ({
      id: activity.id,
      missing: (activity.dependsOn ?? []).filter((id) => !done.has(id)),
    }));

  const batches = [];
  let guard = 0;

  while (remaining.length > 0 && guard < scoped.length + 1) {
    guard += 1;
    const ready = remaining.filter((activity) =>
      (activity.dependsOn ?? []).every((id) => done.has(id)),
    );
    if (ready.length === 0) {
      break;
    }
    const batch = [];
    for (const activity of ready) {
      if (batch.every((other) => !conflicts(activity, other))) {
        batch.push(activity);
      }
    }
    batches.push(batch);
    for (const activity of batch) {
      done.add(activity.id);
      remaining.splice(remaining.indexOf(activity), 1);
    }
  }

  if (remaining.length > 0 && batches.length === 0) {
    for (const activity of remaining) {
      const missing = (activity.dependsOn ?? []).filter((id) => !done.has(id));
      blocked.push({ id: activity.id, missing });
    }
  }

  return { batches, blocked };
}

/** First batch that still has work; null when the story is finished. */
export function currentBatch(schedule) {
  if (!schedule || !Array.isArray(schedule.batches)) {
    return null;
  }
  return (
    schedule.batches.find((batch) => batch.some((activity) => activity.status !== "done")) ?? null
  );
}

/** Everything an executor needs to know before claiming an activity. */
export function claimErrors(activity, activities, schedule) {
  const errors = [];
  if (!activity) {
    return ["activity not found"];
  }
  if (activity.status === "done") {
    errors.push(`${activity.id} is already done`);
  }
  if (activity.status === "blocked") {
    errors.push(`${activity.id} is blocked`);
  }
  const missing = (activity.dependsOn ?? []).filter((id) => {
    const dependency = activities.find((item) => item.id === id);
    return !dependency || dependency.status !== "done";
  });
  if (missing.length > 0) {
    errors.push(`${activity.id} is not ready: waiting on ${missing.join(", ")}`);
  }
  const batch = currentBatch(schedule);
  if (!batch) {
    errors.push("no open batch; run --schedule first");
  } else if (!batch.some((item) => item.id === activity.id)) {
    errors.push(
      `${activity.id} is not in the current batch (${batch.map((item) => item.id).join(", ")})`,
    );
  }
  return errors;
}

// ─── verification steps ─────────────────────────────────────────────────────

/** `--fast`, `activity`, `story` — the three development verification steps. */
export function modeForStep(step) {
  switch (step) {
    case "story":
      return {
        step,
        format: "all",
        lint: "all",
        type: "all",
        build: "production",
        test: "all",
        contract: "yes",
        structure: "yes",
        docs: "yes",
        docsgen: "yes",
        touches: "no",
      };
    case "activity":
      return {
        step,
        format: "changed",
        lint: "changed",
        type: "affected",
        build: "skip",
        test: "targeted",
        contract: "skip",
        structure: "yes",
        docs: "yes",
        docsgen: "yes",
        touches: "yes",
      };
    case "fast":
      return {
        step,
        format: "changed",
        lint: "changed",
        type: "skip",
        build: "skip",
        test: "skip",
        contract: "skip",
        structure: "yes",
        docs: "skip",
        docsgen: "no",
        touches: "no",
      };
    case "iteration":
    default:
      return {
        step: "iteration",
        format: "changed",
        lint: "changed",
        type: "affected",
        build: "skip",
        test: "targeted",
        contract: "skip",
        structure: "yes",
        docs: "yes",
        docsgen: "no",
        touches: "no",
      };
  }
}

export function describeMode(mode) {
  return [
    `format=${mode.format}`,
    `lint=${mode.lint}`,
    `type=${mode.type}`,
    `test=${mode.test}`,
    `build=${mode.build}`,
    `contract=${mode.contract}`,
    `structure=${mode.structure}`,
    `docs=${mode.docs}`,
    `docsgen=${mode.docsgen}`,
    `touches=${mode.touches}`,
  ].join(", ");
}

/** Code changes need targeted tests; docs/config changes do not. */
export function classifyChangedFiles(files, codeRoots = ["src/", "scripts/"]) {
  const code = (files ?? []).some((file) => codeRoots.some((root) => file.startsWith(root)));
  return code ? "code" : "docs";
}
