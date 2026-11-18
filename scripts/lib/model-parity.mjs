// Pure metric layer for the Phase D model-parity pilot.
//
// The runner (`scripts/model-parity.mjs`) needs the external datasets, the
// toolchain checkout and the installed models, so all the rules that can be
// decided without I/O live here and are unit-tested by
// `scripts/lib/model-parity.test.mjs`.
//
// Contract: docs/benchmarks/model-parity.md §2.2-§3.6 and docs/testing.md §6.4.

import path from "node:path";

/** Binary label for a classifier category; `null` means "excluded". */
const BINARY_LABELS = new Map([
  ["one_molecule", "structure"],
  ["several_molecules", "structure"],
  ["other", "no-structure"],
  ["reactions", null],
]);

/** Splits defined by the frozen manifests; anything else is a protocol error. */
const PROTOCOL_SPLITS = new Set(["pilot", "eval", "frozen", "remainder"]);

/** Image extensions the sidecar decodes without conversion (§3.6). */
const APP_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export const STRUCTURE = "structure";
export const NO_STRUCTURE = "no-structure";

/**
 * Map a classifier category to its binary label.
 *
 * `reactions` returns `null` (excluded from the binary metric) instead of being
 * silently mapped to `no-structure`. An unknown category throws: a typo in the
 * labels file must stop the run, not skew the denominator.
 */
export function binaryLabel(category) {
  if (!BINARY_LABELS.has(category)) {
    throw new Error(
      `unknown classifier category ${JSON.stringify(category)}; ` +
        `expected one of ${[...BINARY_LABELS.keys()].join(", ")}`,
    );
  }
  return BINARY_LABELS.get(category);
}

/**
 * Parse a labels.jsonl file into an id-keyed map.
 *
 * Blank lines are ignored. A duplicate id keeps the last record (the toolchain
 * importers append corrections); malformed JSON throws so a truncated file
 * cannot be benchmarked silently.
 */
export function parseLabelsJsonl(text) {
  const labels = new Map();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const record = JSON.parse(line);
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`labels.jsonl record is not an object: ${line.slice(0, 120)}`);
    }
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error(`labels.jsonl record has no string id: ${line.slice(0, 120)}`);
    }
    if (typeof record.image !== "string" || record.image === "") {
      throw new Error(`labels.jsonl record ${record.id} has no string image`);
    }
    labels.set(record.id, { ...record });
  }

  return labels;
}

/**
 * Return the frozen ID order for a split.
 *
 * Only the splits defined by the frozen protocol are accepted, even when the
 * manifest happens to contain another list; the order is preserved verbatim so
 * every variant sees the same IDs in the same sequence.
 */
export function selectSplit(frozen, split) {
  if (!PROTOCOL_SPLITS.has(split)) {
    throw new Error(
      `unknown frozen split ${JSON.stringify(split)}; expected one of ` +
        `${[...PROTOCOL_SPLITS].join(", ")}`,
    );
  }

  const ids = frozen?.splits?.[split];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`frozen manifest has no non-empty "${split}" split`);
  }
  return [...ids];
}

/** Resolve a label's relative image path against its dataset root. */
export function resolveImage(root, label) {
  if (typeof label?.image !== "string" || label.image === "") {
    throw new Error(`cannot resolve image for label ${label?.id ?? "<unknown>"}`);
  }
  return path.join(root, label.image);
}

/**
 * Whether an image must be converted before the sidecar can decode it (§3.6).
 *
 * The app supports PNG, JPEG and WebP only. Anything else (TIFF in the pilot,
 * GIF, BMP, a missing extension) needs the benchmark-scaffolding conversion.
 */
export function needsConversion(file) {
  return !APP_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Default sidecar binary for the parity runner.
 *
 * The pilot must time the build the app ships (`target/release`); an
 * unoptimized debug binary spends the round trip in image decode/resize and is
 * not comparable to the toolchain (§3.4). `--sidecar` still overrides it.
 */
export function defaultSidecarPath(cwd) {
  return path.join(cwd, "target", "release", "indigo-server");
}

/**
 * Binary classifier metrics.
 *
 * Rows are `{ expected, predicted, includedInBinary }`. Reaction rows carry
 * `includedInBinary: false` and never enter the denominator. Accuracy is
 * `(TP + TN) / total` over included rows, or 0 for an empty run.
 */
export function classifierMetrics(rows) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  let excluded = 0;

  for (const row of rows) {
    if (typeof row.includedInBinary !== "boolean") {
      throw new Error("classifier row must declare includedInBinary as a boolean");
    }
    if (!row.includedInBinary) {
      excluded += 1;
      continue;
    }

    const { expected, predicted } = row;
    if (expected === STRUCTURE && predicted === STRUCTURE) tp += 1;
    else if (expected === STRUCTURE && predicted === NO_STRUCTURE) fn += 1;
    else if (expected === NO_STRUCTURE && predicted === STRUCTURE) fp += 1;
    else if (expected === NO_STRUCTURE && predicted === NO_STRUCTURE) tn += 1;
    else {
      throw new Error(
        `invalid classifier row expected=${JSON.stringify(expected)} ` +
          `predicted=${JSON.stringify(predicted)}`,
      );
    }
  }

  const total = tp + fn + fp + tn;
  return {
    tp,
    fn,
    fp,
    tn,
    total,
    excluded,
    accuracy: total === 0 ? 0 : (tp + tn) / total,
  };
}

/**
 * Nearest-rank percentile over a copy of the values (§3.4).
 *
 * Index `ceil(p / 100 * n) - 1`; an empty list returns 0. Interpolation is
 * deliberately not used so the n=300 p50/p95 ranks stay pinned.
 */
export function percentile(values, p) {
  if (!Array.isArray(values)) {
    throw new Error("percentile expects an array of numbers");
  }
  if (values.length === 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new Error(`percentile expects p in (0, 100], got ${p}`);
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[index];
}

/** Difference between two rates in percentage points (actual − reference). */
export function rateDelta(actual, reference) {
  return (actual - reference) * 100;
}

/** Nearest-rank latency summary used by both suites. */
export function summarizeLatency(latencies) {
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    n: latencies.length,
  };
}

/** Whether a list contains every id of another list, without duplicates. */
function assertUniqueIds(label, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`${label} must be a non-empty array of ids`);
  }
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || id === "") {
      throw new Error(`${label} contains a non-string id`);
    }
    if (seen.has(id)) {
      throw new Error(`${label} contains duplicate id ${id}`);
    }
    seen.add(id);
  }
}

/**
 * OCSR metrics (§3.3).
 *
 * Rows are `{ exact, canonical, valid, incomparable }`:
 * - `exact` is raw string equality over all rows (including 422 failures);
 * - `canonical` is RDKit equality and only defined for comparable pairs
 *   (both sides parse), so the rate divides by `comparable`, not by `total`;
 * - `valid` is the toolchain's heuristic (a non-empty answer, i.e. not a
 *   422/incomplete row); `incomplete` is `total - valid`;
 * - `incomparable` marks a row without a canonical comparison (no returned
 *   SMILES, or either side does not parse).
 *
 * A row cannot be incomparable and carry a boolean canonical result, and a
 * 422/incomplete row cannot be valid or carry a canonical result; all are
 * rejected so a miscounted denominator cannot pass silently.
 */
export function ocsrMetrics(rows) {
  let exact = 0;
  let canonical = 0;
  let comparable = 0;
  let valid = 0;

  for (const row of rows) {
    for (const field of ["exact", "valid", "incomparable"]) {
      if (typeof row[field] !== "boolean") {
        throw new Error(`OCSR row must declare ${field} as a boolean`);
      }
    }
    if (row.canonical !== null && typeof row.canonical !== "boolean") {
      throw new Error("OCSR row canonical must be a boolean or null");
    }
    if (row.incomparable && typeof row.canonical === "boolean") {
      throw new Error("an incomparable OCSR row cannot have a canonical result");
    }
    if (!row.incomparable && typeof row.canonical !== "boolean") {
      throw new Error("a comparable OCSR row must carry a canonical result");
    }
    if (!row.valid && typeof row.canonical === "boolean") {
      throw new Error("an invalid OCSR row (422/incomplete) cannot have a canonical result");
    }

    if (row.exact) exact += 1;
    if (row.valid) valid += 1;
    if (typeof row.canonical === "boolean") {
      comparable += 1;
      if (row.canonical) canonical += 1;
    }
  }

  const total = rows.length;
  const incomplete = total - valid;
  return {
    total,
    exact,
    exactRate: total === 0 ? 0 : exact / total,
    canonical,
    comparable,
    canonicalRate: comparable === 0 ? 0 : canonical / comparable,
    valid,
    incomplete,
    validRate: total === 0 ? 0 : valid / total,
    incompleteRate: total === 0 ? 0 : incomplete / total,
  };
}

/** Convert a score into the sidecar's binary category (§3.2). */
export function predictedFromScore(score, threshold) {
  if (!Number.isFinite(score) || !Number.isFinite(threshold)) {
    throw new Error(`predictedFromScore expects finite numbers, got ${score}/${threshold}`);
  }
  return score <= threshold ? STRUCTURE : NO_STRUCTURE;
}

/**
 * Derive the same-pilot classifier reference from the toolchain eval details.
 *
 * `evalDetails` is the `details` array of `classifier.e4-fp16.eval1000.json`
 * (or the FP32 file for the secondary check). Only the frozen pilot IDs are
 * kept, in pilot order. Duplicate or missing IDs are protocol errors: the
 * reference must cover the exact 300 IDs the sidecar will run.
 *
 * Returns the same binary aggregate as `classifierMetrics`, the reaction
 * breakdown, and per-ID predictions for agreement checks. Reaction details in
 * the toolchain file carry `excluded_from_binary: true` instead of
 * `included_in_binary: false`; both shapes are accepted.
 */
export function referenceFromEval(evalDetails, pilotIds) {
  if (!Array.isArray(evalDetails)) {
    throw new Error("referenceFromEval expects the eval `details` array");
  }
  assertUniqueIds("pilotIds", pilotIds);

  const byId = new Map();
  for (const detail of evalDetails) {
    if (detail === null || typeof detail !== "object" || typeof detail.id !== "string") {
      throw new Error("eval detail has no string id");
    }
    if (byId.has(detail.id)) {
      throw new Error(`eval details contain duplicate id ${detail.id}`);
    }
    byId.set(detail.id, detail);
  }

  const missing = pilotIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `eval details are missing ${missing.length} pilot id(s): ${missing.slice(0, 5).join(", ")}`,
    );
  }

  const predictions = new Map();
  const rows = [];
  let reactionTotal = 0;
  let reactionStructure = 0;
  let reactionNoStructure = 0;

  for (const id of pilotIds) {
    const detail = byId.get(id);
    const included = detail.included_in_binary === true;
    const excluded = detail.excluded_from_binary === true;
    if (included === excluded) {
      throw new Error(
        `eval detail ${id} must set exactly one of included_in_binary/excluded_from_binary`,
      );
    }
    if (detail.predicted !== STRUCTURE && detail.predicted !== NO_STRUCTURE) {
      throw new Error(
        `eval detail ${id} has invalid prediction ${JSON.stringify(detail.predicted)}`,
      );
    }

    if (!included) {
      reactionTotal += 1;
      if (detail.predicted === STRUCTURE) reactionStructure += 1;
      else reactionNoStructure += 1;
    }

    const row = {
      expected: included ? detail.expected_binary : null,
      predicted: detail.predicted,
      includedInBinary: included,
    };
    rows.push(row);
    predictions.set(id, {
      id,
      expected: row.expected,
      predicted: row.predicted,
      includedInBinary: included,
    });
  }

  const metrics = classifierMetrics(rows);
  if (metrics.excluded !== reactionTotal) {
    throw new Error("reaction accounting mismatch in the eval reference");
  }

  return {
    metrics,
    reactions: {
      total: reactionTotal,
      predictedStructure: reactionStructure,
      predictedNoStructure: reactionNoStructure,
    },
    predictions,
  };
}
