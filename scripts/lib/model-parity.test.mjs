// Unit tests for the Phase D model-parity pure metric layer.
//
// The benchmark runner needs the external datasets, the toolchain checkout and
// the installed models, so only the pure logic is tested here: label mapping,
// split/image selection, the binary classifier metric, the nearest-rank
// percentiles and the reference delta. Every fixture is synthetic: no dataset,
// no model, no sidecar and no network.
//
// Contract: docs/benchmarks/model-parity.md §2.2-§3.6 and docs/testing.md §6.4.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  binaryLabel,
  classifierMetrics,
  defaultSidecarPath,
  needsConversion,
  ocsrMetrics,
  parseLabelsJsonl,
  percentile,
  predictedFromScore,
  rateDelta,
  referenceFromEval,
  resolveImage,
  selectSplit,
  summarizeLatency,
} from "./model-parity.mjs";

const STRUCTURE = "structure";
const NO_STRUCTURE = "no-structure";

// --- Label mapping ---------------------------------------------------------

test("binaryLabel maps one_molecule to structure", () => {
  assert.equal(binaryLabel("one_molecule"), STRUCTURE);
});

test("binaryLabel maps several_molecules to structure", () => {
  assert.equal(binaryLabel("several_molecules"), STRUCTURE);
});

test("binaryLabel maps other to no-structure", () => {
  assert.equal(binaryLabel("other"), NO_STRUCTURE);
});

test("binaryLabel excludes reactions from the binary metric", () => {
  assert.equal(binaryLabel("reactions"), null);
});

test("binaryLabel rejects an unknown category instead of mapping it", () => {
  assert.throws(
    () => binaryLabel("molecule-ish"),
    /molecule-ish/,
    "an unknown category must be rejected and named",
  );
});

// --- Label file parsing ----------------------------------------------------

test("parseLabelsJsonl keys records by id and ignores blank lines", () => {
  const text = [
    "",
    JSON.stringify({
      id: "cls-1",
      category: "one_molecule",
      image: "classified/one_molecule/1.png",
    }),
    "   ",
    JSON.stringify({ id: "cls-2", category: "other", image: "classified/rest/2.png" }),
    "\t",
    "",
  ].join("\n");

  const labels = parseLabelsJsonl(text);

  assert.equal(labels.size, 2);
  assert.deepEqual(labels.get("cls-1"), {
    id: "cls-1",
    category: "one_molecule",
    image: "classified/one_molecule/1.png",
  });
  assert.deepEqual(labels.get("cls-2"), {
    id: "cls-2",
    category: "other",
    image: "classified/rest/2.png",
  });
});

test("parseLabelsJsonl returns an empty map for blank text", () => {
  assert.equal(parseLabelsJsonl("\n  \n\t\n").size, 0);
});

test("parseLabelsJsonl keeps the last record for a duplicate id", () => {
  const text = [
    JSON.stringify({ id: "cls-1", category: "other", image: "a.png" }),
    JSON.stringify({ id: "cls-1", category: "one_molecule", image: "b.png" }),
  ].join("\n");

  const labels = parseLabelsJsonl(text);

  assert.equal(labels.size, 1);
  assert.deepEqual(labels.get("cls-1"), {
    id: "cls-1",
    category: "one_molecule",
    image: "b.png",
  });
});

test("parseLabelsJsonl rejects malformed JSON", () => {
  assert.throws(() => parseLabelsJsonl('{"id":"cls-1","category":}'), SyntaxError);
});

// --- Frozen split selection ------------------------------------------------

const FROZEN = {
  seed: 20260308,
  splits: {
    frozen: ["frozen-3", "frozen-1", "frozen-2"],
    eval: ["eval-1", "eval-2"],
    pilot: ["pilot-1", "pilot-2"],
  },
};

const SPLIT_IDS = new Map([
  ["pilot", ["pilot-1", "pilot-2"]],
  ["eval", ["eval-1", "eval-2"]],
  ["frozen", ["frozen-3", "frozen-1", "frozen-2"]],
]);

for (const [split, expected] of SPLIT_IDS) {
  test(`selectSplit returns the frozen order for the ${split} split`, () => {
    assert.deepEqual(selectSplit(FROZEN, split), expected);
  });
}

test("selectSplit rejects an unknown split", () => {
  assert.throws(() => selectSplit(FROZEN, "train"), /train/);
});

test("selectSplit rejects a split outside the frozen protocol even when it exists", () => {
  assert.throws(() => selectSplit({ splits: { train: ["row-1"] } }, "train"), /train/);
});

// --- Image resolution and conversion ---------------------------------------

test("resolveImage joins the dataset root and the label image", () => {
  const root = path.join("data", "benchmark", "classifier-curated");
  const label = {
    id: "cls-1",
    image: path.join("classified", "one_molecule", "cls-1.png"),
  };

  const resolved = resolveImage(root, label);

  assert.equal(resolved, path.join(root, label.image));
  assert.equal(path.basename(resolved), "cls-1.png");
  assert.ok(resolved.endsWith(path.join("classified", "one_molecule", "cls-1.png")));
});

test("needsConversion leaves app-decodable images untouched", () => {
  const files = ["cls-1.png", "CLS-1.PNG", "cls-1.jpg", "CLS-1.JPEG", "cls-1.webp", "CLS-1.WEBP"];

  for (const file of files) {
    assert.equal(needsConversion(file), false, `${file} must not need conversion`);
  }
});

test("needsConversion flags TIFF and any other unsupported extension", () => {
  const files = ["cls-1.tif", "cls-1.tiff", "CLS-1.TIFF", "cls-1.gif", "cls-1", "cls-1.png.bak"];

  for (const file of files) {
    assert.equal(needsConversion(file), true, `${file} must need conversion`);
  }
});

// --- Sidecar default -------------------------------------------------------

test("defaultSidecarPath selects the shipped release binary", () => {
  const cwd = path.join("repo");

  assert.equal(
    defaultSidecarPath(cwd),
    path.join(cwd, "target", "release", "indigo-server"),
    "latency must be measured on the build the app ships, not the debug build",
  );
});

test("defaultSidecarPath never selects the debug binary", () => {
  assert.notEqual(
    path.basename(path.dirname(defaultSidecarPath(path.join("repo")))),
    "debug",
    "the runner default must not fall back to target/debug",
  );
});

// --- Classifier binary metric ----------------------------------------------

function binaryRow(expected, predicted) {
  return { expected, predicted, includedInBinary: true };
}

function excludedRow(expected, predicted) {
  return { expected, predicted, includedInBinary: false };
}

test("classifierMetrics counts the documented confusion matrix", () => {
  const rows = [
    binaryRow(STRUCTURE, STRUCTURE),
    binaryRow(STRUCTURE, STRUCTURE),
    binaryRow(STRUCTURE, NO_STRUCTURE),
    binaryRow(NO_STRUCTURE, STRUCTURE),
    binaryRow(NO_STRUCTURE, NO_STRUCTURE),
    binaryRow(NO_STRUCTURE, NO_STRUCTURE),
    excludedRow(NO_STRUCTURE, NO_STRUCTURE),
  ];

  assert.deepEqual(classifierMetrics(rows), {
    tp: 2,
    fn: 1,
    fp: 1,
    tn: 2,
    total: 6,
    excluded: 1,
    accuracy: 4 / 6,
  });
});

test("classifierMetrics reproduces the reference 166/228 aggregate", () => {
  const rows = [
    ...Array.from({ length: 87 }, () => binaryRow(STRUCTURE, STRUCTURE)),
    ...Array.from({ length: 62 }, () => binaryRow(STRUCTURE, NO_STRUCTURE)),
    ...Array.from({ length: 79 }, () => binaryRow(NO_STRUCTURE, NO_STRUCTURE)),
    ...Array.from({ length: 72 }, () => excludedRow(STRUCTURE, STRUCTURE)),
  ];

  assert.deepEqual(classifierMetrics(rows), {
    tp: 87,
    fn: 62,
    fp: 0,
    tn: 79,
    total: 228,
    excluded: 72,
    accuracy: 166 / 228,
  });
});

test("classifierMetrics keeps excluded rows out of the binary total", () => {
  const rows = [excludedRow(STRUCTURE, STRUCTURE), excludedRow(NO_STRUCTURE, NO_STRUCTURE)];

  assert.deepEqual(classifierMetrics(rows), {
    tp: 0,
    fn: 0,
    fp: 0,
    tn: 0,
    total: 0,
    excluded: 2,
    accuracy: 0,
  });
});

test("classifierMetrics returns zeroes for an empty run", () => {
  assert.deepEqual(classifierMetrics([]), {
    tp: 0,
    fn: 0,
    fp: 0,
    tn: 0,
    total: 0,
    excluded: 0,
    accuracy: 0,
  });
});

// --- Percentiles and deltas ------------------------------------------------

test("percentile uses nearest rank, not interpolation", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
});

test("percentile rounds up to the next rank", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test("percentile handles a single value at both boundaries", () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 100), 42);
});

test("percentile returns the documented n=300 ranks", () => {
  const latencies = Array.from({ length: 300 }, (_, index) => index + 1);

  assert.equal(percentile(latencies, 50), 150);
  assert.equal(percentile(latencies, 95), 285);
});

test("percentile sorts a copy without mutating the input", () => {
  const latencies = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

  assert.equal(percentile(latencies, 50), 5);
  assert.deepEqual(latencies, [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
});

test("percentile returns 0 for an empty list", () => {
  assert.equal(percentile([], 95), 0);
});

test("rateDelta reports a gain in percentage points", () => {
  assert.equal(rateDelta(0.5, 0.25), 25);
});

test("rateDelta reports a loss in percentage points", () => {
  assert.ok(Math.abs(rateDelta(0.72, 0.75) + 3) < 1e-9, "0.72 against 0.75 is -3 pp");
});

test("rateDelta reports no change", () => {
  assert.equal(rateDelta(0.25, 0.25), 0);
});

test("rateDelta keeps full precision instead of a rounded display value", () => {
  assert.ok(
    Math.abs(rateDelta(2 / 3, 0.5) - 100 / 6) < 1e-9,
    "a repeating delta must not be rounded",
  );
});

test("summarizeLatency reports nearest-rank p50, p95 and n", () => {
  const latencies = Array.from({ length: 300 }, (_, index) => index + 1);

  assert.deepEqual(summarizeLatency(latencies), { p50: 150, p95: 285, n: 300 });
});

// --- Threshold direction ---------------------------------------------------

const THRESHOLD = 0.000089;
const STEP = Number.EPSILON * Math.max(1, Math.abs(THRESHOLD));

test("predictedFromScore maps the threshold boundary to structure", () => {
  assert.equal(predictedFromScore(THRESHOLD, THRESHOLD), STRUCTURE);
});

test("predictedFromScore maps a score below the threshold to structure", () => {
  assert.equal(predictedFromScore(THRESHOLD - STEP, THRESHOLD), STRUCTURE);
});

test("predictedFromScore maps a score above the threshold to no-structure", () => {
  assert.equal(predictedFromScore(THRESHOLD + STEP, THRESHOLD), NO_STRUCTURE);
});

test("predictedFromScore keeps the rule at zero and near zero", () => {
  assert.equal(predictedFromScore(0, 0), STRUCTURE);
  assert.equal(predictedFromScore(Number.EPSILON, 0), NO_STRUCTURE);
});

// --- OCSR metric -----------------------------------------------------------

function ocsrRow({ exact = false, canonical = null, valid = true, incomparable = false }) {
  return { exact, canonical, valid, incomparable };
}

test("ocsrMetrics counts exact over all rows and canonical over comparable pairs", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ocsrRow({ exact: true, canonical: true })),
    ...Array.from({ length: 4 }, () => ocsrRow({ canonical: true })),
    ocsrRow({ canonical: false }),
    ocsrRow({ valid: false, incomparable: true }),
  ];

  assert.deepEqual(ocsrMetrics(rows), {
    total: 9,
    exact: 3,
    exactRate: 3 / 9,
    canonical: 7,
    comparable: 8,
    canonicalRate: 7 / 8,
    valid: 8,
    incomplete: 1,
    validRate: 8 / 9,
    incompleteRate: 1 / 9,
  });
});

test("ocsrMetrics keeps a 422 out of the exact and comparable denominators", () => {
  const rows = [
    ocsrRow({ exact: true, canonical: true }),
    ocsrRow({ valid: false, incomparable: true }),
  ];

  const metrics = ocsrMetrics(rows);
  assert.equal(metrics.exact, 1);
  assert.equal(metrics.exactRate, 1 / 2);
  assert.equal(metrics.canonical, 1);
  assert.equal(metrics.comparable, 1);
  assert.equal(metrics.canonicalRate, 1);
  assert.equal(metrics.valid, 1);
  assert.equal(metrics.incomplete, 1);
});

test("ocsrMetrics reproduces the reference 210/292, 121/300, 299/300 shape", () => {
  const rows = [
    ...Array.from({ length: 210 }, () => ocsrRow({ exact: true, canonical: true })),
    ...Array.from({ length: 82 }, () => ocsrRow({ canonical: false })),
    ...Array.from({ length: 7 }, () => ocsrRow({ incomparable: true })),
    ocsrRow({ valid: false, incomparable: true }),
  ];

  const metrics = ocsrMetrics(rows);
  assert.equal(metrics.total, 300);
  assert.equal(metrics.exact, 210);
  assert.equal(metrics.canonical, 210);
  assert.equal(metrics.comparable, 292);
  assert.equal(metrics.canonicalRate, 210 / 292);
  assert.equal(metrics.valid, 299);
  assert.equal(metrics.incomplete, 1);
});

test("ocsrMetrics returns zeroes for an empty run", () => {
  assert.deepEqual(ocsrMetrics([]), {
    total: 0,
    exact: 0,
    exactRate: 0,
    canonical: 0,
    comparable: 0,
    canonicalRate: 0,
    valid: 0,
    incomplete: 0,
    validRate: 0,
    incompleteRate: 0,
  });
});

test("ocsrMetrics rejects an incomparable row with a canonical result", () => {
  assert.throws(
    () => ocsrMetrics([ocsrRow({ canonical: false, incomparable: true })]),
    /incomparable/,
  );
});

test("ocsrMetrics rejects a comparable row without a canonical result", () => {
  assert.throws(() => ocsrMetrics([ocsrRow({ canonical: null })]), /comparable/);
});

test("ocsrMetrics rejects an invalid row with a canonical result", () => {
  assert.throws(
    () => ocsrMetrics([ocsrRow({ valid: false, canonical: true })]),
    /invalid/,
    "a 422/incomplete row must not enter the comparable denominator",
  );
});

// --- Reference derivation --------------------------------------------------

function evalDetail(id, { category, predicted, included, expectedBinary }) {
  return included
    ? {
        id,
        category,
        predicted,
        expected_binary: expectedBinary,
        included_in_binary: true,
      }
    : { id, category, predicted, excluded_from_binary: true, report_as: "ambiguous_excluded" };
}

const EVAL_DETAILS = [
  evalDetail("pilot-1", {
    category: "one_molecule",
    predicted: STRUCTURE,
    included: true,
    expectedBinary: STRUCTURE,
  }),
  evalDetail("pilot-2", {
    category: "other",
    predicted: NO_STRUCTURE,
    included: true,
    expectedBinary: NO_STRUCTURE,
  }),
  evalDetail("pilot-3", {
    category: "reactions",
    predicted: STRUCTURE,
    included: false,
  }),
];

test("referenceFromEval filters by pilot id and returns the same aggregate", () => {
  const reference = referenceFromEval(EVAL_DETAILS, ["pilot-1", "pilot-2", "pilot-3"]);

  assert.deepEqual(
    reference.metrics,
    classifierMetrics([
      binaryRow(STRUCTURE, STRUCTURE),
      binaryRow(NO_STRUCTURE, NO_STRUCTURE),
      excludedRow(null, STRUCTURE),
    ]),
  );
  assert.deepEqual(reference.reactions, {
    total: 1,
    predictedStructure: 1,
    predictedNoStructure: 0,
  });
  assert.deepEqual(reference.predictions.get("pilot-3"), {
    id: "pilot-3",
    expected: null,
    predicted: STRUCTURE,
    includedInBinary: false,
  });
});

test("referenceFromEval keeps only the requested pilot ids", () => {
  const reference = referenceFromEval(EVAL_DETAILS, ["pilot-2"]);
  assert.equal(reference.metrics.total, 1);
  assert.equal(reference.metrics.tn, 1);
  assert.equal(reference.reactions.total, 0);
  assert.equal(reference.predictions.size, 1);
});

test("referenceFromEval rejects a duplicate pilot id", () => {
  assert.throws(
    () => referenceFromEval(EVAL_DETAILS, ["pilot-1", "pilot-1"]),
    /duplicate id pilot-1/,
  );
});

test("referenceFromEval rejects a missing pilot id", () => {
  assert.throws(
    () => referenceFromEval(EVAL_DETAILS, ["pilot-1", "pilot-404"]),
    /missing 1 pilot id\(s\): pilot-404/,
  );
});

test("referenceFromEval rejects duplicate eval details", () => {
  assert.throws(
    () => referenceFromEval([...EVAL_DETAILS, EVAL_DETAILS[0]], ["pilot-1"]),
    /duplicate id pilot-1/,
  );
});

test("referenceFromEval excludes reactions from the binary aggregate", () => {
  const reference = referenceFromEval(EVAL_DETAILS, ["pilot-1", "pilot-2", "pilot-3"]);
  assert.equal(reference.metrics.total, 2);
  assert.equal(reference.metrics.excluded, 1);
  assert.equal(reference.metrics.accuracy, 1);
});
