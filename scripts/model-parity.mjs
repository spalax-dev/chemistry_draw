#!/usr/bin/env node
/**
 * Phase D model-parity runner.
 *
 * Runs the frozen `pilot300` split through the Chemistry Draw sidecar and
 * compares it with the decimer-onnx-toolchain's frozen predictions on the same
 * IDs. See `docs/benchmarks/model-parity.md` for the protocol and
 * `docs/verification.md` §2 "Model parity pilot (Phase D)" for the checklist.
 *
 * Usage:
 *   node scripts/model-parity.mjs [options]
 *
 * Options:
 *   --toolchain <dir>        Toolchain checkout (default $DECIMER_TOOLCHAIN_DIR
 *                            or ../decimer-onnx-toolchain)
 *   --suite <name>           classifier | handdrawn | both (default both)
 *   --split <name>           Frozen split (default and only supported: pilot)
 *   --classifier-root <dir>  Dataset root (default: dirname of its labels.jsonl)
 *   --handdrawn-root <dir>   Dataset root (default: dirname of its labels.jsonl)
 *   --sidecar <file>         indigo-server binary (default target/release/indigo-server)
 *   --models <dir>           Model root (default $PWD/models)
 *   --ort <file>             ONNX Runtime library (default
 *                            $PWD/.ort/linux-x86_64/libonnxruntime.so)
 *   --out <dir>              Run directory (default
 *                            target/benchmarks/model-parity/<timestamp>; must
 *                            stay under target/benchmarks/)
 *   --timeout <ms>           Per-request timeout (default 120000)
 *   --help                   Show this help
 *
 * The runner is pilot-only: the pinned aggregate and the 300-row gates apply
 * to the frozen `pilot` split, so any other `--split` is rejected.
 *
 * Raw outputs stay under `target/benchmarks/` (gitignored); the committed
 * report is `docs/benchmarks/model-parity.md` §4. The default sidecar is
 * `target/release/indigo-server` (the shipped build); a debug binary can be
 * passed with `--sidecar` for a functional-only run, but its latency is not
 * comparable to the toolchain.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  binaryLabel,
  classifierMetrics,
  defaultSidecarPath,
  needsConversion,
  ocsrMetrics,
  parseLabelsJsonl,
  predictedFromScore,
  rateDelta,
  referenceFromEval,
  resolveImage,
  selectSplit,
  summarizeLatency,
} from "./lib/model-parity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PINNED_TOOLCHAIN_COMMIT = "c2265a6d83f3eb5a7ef0fd5df4741335627c5f20";
const PINNED_CLASSIFIER_THRESHOLD = 0.000089;

const PINNED_HASHES = {
  classifierFrozen: "27304f11f2613f17780f044e52441a408254898a11ccaed89b9adaf885f43621",
  handdrawnFrozen: "92a1931a3a7f2abe535ef6f0b24e37962899a1ab2da36e9c150cfd126b729f24",
  classifierLabels: "c18023b791b39d74bd0621ea033e3b19d158267c24737624a20dbb409ac8bac1",
  handdrawnLabels: "352e626d6be3fcdfdbf37826ada6f2d6e6eae3debe78a20e6c2f0839bb2e33a1",
  classifierEvalFp16: "c19cd03dc8b8809b250aecaf9ce512a2d17f48e1100bad01f17e3b10b5fcdc53",
  handdrawnPilotFp32: "d8df90cd3ddc439435db1b5dea00541d8c9a87ef48910ff13db6dc647490ba0c",
};

const PINNED_MODELS = [
  {
    model: "image-classifier",
    field: null,
    file: "image-classifier-fp16/classifier.fp16.onnx",
    sha256: "d5f5506beba189cf2489761d96db4ce978023d769688a08065458a3c0af505a9",
  },
  {
    model: "ocsr-handdrawn",
    field: "encoder",
    file: "ocsr-handdrawn-fp32/encoder.onnx",
    sha256: "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
  },
  {
    model: "ocsr-handdrawn",
    field: "decoder",
    file: "ocsr-handdrawn-fp32/decoder_step.onnx",
    sha256: "cfff97883de80de4e55463d44d8778c351188f47f1f1c955ed7c3c6bb6d68197",
  },
  {
    model: "ocsr-handdrawn",
    field: "vocab",
    file: "ocsr-handdrawn-fp32/vocab.json",
    sha256: "62c84d901199667c171413acfbd9071c0297a9273081063df318877a1fa3c7dd",
  },
];

const CLASSIFIER_REFERENCE = {
  tp: 87,
  fn: 62,
  fp: 0,
  tn: 79,
  total: 228,
  excluded: 72,
  reactionsStructure: 48,
  reactionsNoStructure: 24,
  accuracy: 166 / 228,
};

const HANDDRAWN_REFERENCE = {
  exact: 121,
  canonical: 210,
  comparable: 292,
  valid: 299,
  incomplete: 1,
};

const GATES = {
  classifierAccuracy: 0.7231,
  ocsrCanonical: 0.7092,
};

const CLASSIFIER_MODEL_ID = "image-classifier@Iagea/d21f4cb";
const HANDDRAWN_MODEL_ID = "ocsr-handdrawn@zenodo:10781330";

const CONVERT_SCRIPT = `
import json
import sys

from PIL import Image

pairs = json.load(open(sys.argv[1], encoding="utf-8"))
for pair in pairs:
    with Image.open(pair["input"]) as image:
        image.convert("RGB").save(pair["output"], format="PNG")
print(json.dumps({"converted": len(pairs)}))
`;

const MTIME = (file) => statSync(file).mtime.toISOString();

// --- CLI -------------------------------------------------------------------

const OPTION_KEYS = new Set([
  "toolchain",
  "suite",
  "split",
  "classifier-root",
  "handdrawn-root",
  "sidecar",
  "models",
  "ort",
  "out",
  "timeout",
]);

function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }

    const equals = arg.indexOf("=");
    let key;
    let value;
    if (equals === -1) {
      key = arg.slice(2);
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${key} needs a value`);
      }
      index += 1;
    } else {
      key = arg.slice(2, equals);
      value = arg.slice(equals + 1);
    }
    if (!OPTION_KEYS.has(key)) {
      throw new Error(`unknown option --${key}`);
    }
    options[key] = value;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/model-parity.mjs [options]

  --toolchain <dir>        Toolchain checkout (default $DECIMER_TOOLCHAIN_DIR
                           or ../decimer-onnx-toolchain)
  --suite <name>           classifier | handdrawn | both (default both)
  --split <name>           Frozen split (default and only supported: pilot)
  --classifier-root <dir>  Dataset root (default: dirname of labels.jsonl)
  --handdrawn-root <dir>   Dataset root (default: dirname of labels.jsonl)
  --sidecar <file>         indigo-server binary (default target/release/indigo-server)
  --models <dir>           Model root (default $PWD/models)
  --ort <file>             ONNX Runtime library (default .ort/linux-x86_64/libonnxruntime.so)
  --out <dir>              Run directory (default target/benchmarks/model-parity/<timestamp>;
                           must stay under target/benchmarks/)
  --timeout <ms>           Per-request timeout (default 120000)
  --help                   Show this help`);
}

function resolveConfig(options) {
  const cwd = process.cwd();
  const suite = options.suite ?? "both";
  if (!["classifier", "handdrawn", "both"].includes(suite)) {
    throw new Error(
      `unknown suite ${JSON.stringify(suite)}; expected classifier, handdrawn or both`,
    );
  }

  const split = options.split ?? "pilot";
  if (split !== "pilot") {
    throw new Error(
      `--split ${JSON.stringify(split)} is not supported: the pinned aggregate and ` +
        "the 300-row gates are pilot-only; use --split pilot",
    );
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const benchmarkRoot = path.resolve(cwd, "target", "benchmarks");
  const out = path.resolve(
    cwd,
    options.out ?? path.join("target", "benchmarks", "model-parity", timestamp),
  );
  if (!out.startsWith(`${benchmarkRoot}${path.sep}`)) {
    throw new Error(
      `--out must be a run directory inside target/benchmarks/ (gitignored), got ${out}`,
    );
  }

  const toolchain = path.resolve(
    cwd,
    options.toolchain ?? process.env.DECIMER_TOOLCHAIN_DIR ?? "../decimer-onnx-toolchain",
  );
  const models = path.resolve(cwd, options.models ?? process.env.CHEMISTRY_MODELS_DIR ?? "models");
  const ort = path.resolve(
    cwd,
    options.ort ??
      process.env.ORT_DYLIB_PATH ??
      path.join(".ort", "linux-x86_64", "libonnxruntime.so"),
  );
  const sidecar = path.resolve(cwd, options.sidecar ?? defaultSidecarPath(cwd));

  const timeout = options.timeout === undefined ? 120_000 : Number(options.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`--timeout must be a positive integer, got ${options.timeout}`);
  }

  return {
    cwd,
    suite,
    split,
    out,
    runId: path.basename(out),
    toolchain,
    models,
    ort,
    sidecar,
    timeout,
    classifierRoot: options["classifier-root"]
      ? path.resolve(cwd, options["classifier-root"])
      : null,
    handdrawnRoot: options["handdrawn-root"] ? path.resolve(cwd, options["handdrawn-root"]) : null,
    python: path.join(toolchain, ".venv", "bin", "python"),
    argv: process.argv.slice(2),
  };
}

// --- Small utilities -------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(stableValue(value)));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function ensureFile(file, label) {
  if (!existsSync(file)) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function assertHash(file, expected, label) {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`${label} hash mismatch: expected ${expected}, got ${actual} (${file})`);
  }
  return actual;
}

function mediaType(file) {
  switch (path.extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`file needs conversion before it can be posted: ${file}`);
  }
}

function cpuDescription() {
  try {
    const text = execFileSync("lscpu", { encoding: "utf8" });
    const model = /^Model name:\s+(.+)$/m.exec(text)?.[1]?.trim();
    const sockets = /^Socket\(s\):\s+(.+)$/m.exec(text)?.[1]?.trim();
    const cores = /^Core\(s\) per socket:\s+(.+)$/m.exec(text)?.[1]?.trim();
    return {
      model: model ?? os.cpus()[0]?.model ?? "unknown",
      sockets: sockets ?? null,
      coresPerSocket: cores ?? null,
      logicalCpus: os.cpus().length,
    };
  } catch {
    return { model: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length };
  }
}

function commandString(command, args) {
  return [command, ...args]
    .map((part) => (/[^\w./:@=+-]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function repoIdentity() {
  try {
    const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    return { commit, dirty: dirty !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

// --- Toolchain and model verification --------------------------------------

function verifyToolchain(config) {
  ensureFile(config.python, "toolchain Python");

  let commit;
  try {
    commit = execFileSync("git", ["-C", config.toolchain, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    throw new Error(`cannot read the toolchain commit in ${config.toolchain}: ${error.message}`, {
      cause: error,
    });
  }
  if (commit !== PINNED_TOOLCHAIN_COMMIT) {
    throw new Error(
      `toolchain commit mismatch: expected ${PINNED_TOOLCHAIN_COMMIT}, got ${commit} ` +
        `(${config.toolchain})`,
    );
  }

  let versions;
  try {
    versions = JSON.parse(
      execFileSync(
        config.python,
        [
          "-c",
          "import json, PIL; from rdkit import rdBase; " +
            "print(json.dumps({'pillow': PIL.__version__, 'rdkit': rdBase.rdkitVersion}))",
        ],
        { encoding: "utf8" },
      ).trim(),
    );
  } catch (error) {
    throw new Error(
      `toolchain Python cannot import Pillow/RDKit (${config.python}): ${error.message}`,
      { cause: error },
    );
  }

  return { commit, versions };
}

function manifestSha(manifest, spec) {
  const entry = spec.field
    ? manifest.models?.[spec.model]?.[spec.field]
    : manifest.models?.[spec.model];
  return entry?.artifact_sha256 ?? null;
}

function verifyModels(config) {
  const manifestPath = path.join(config.models, "manifest.json");
  ensureFile(manifestPath, "model manifest");
  const manifest = readJson(manifestPath);

  const wanted = new Set(
    config.suite === "classifier"
      ? ["image-classifier"]
      : config.suite === "handdrawn"
        ? ["ocsr-handdrawn"]
        : ["image-classifier", "ocsr-handdrawn"],
  );

  const files = [];
  for (const spec of PINNED_MODELS) {
    if (!wanted.has(spec.model)) continue;
    const file = path.join(config.models, spec.file);
    ensureFile(file, `${spec.model} artifact`);
    const actual = assertHash(file, spec.sha256, `${spec.model} ${spec.field ?? "artifact"}`);
    const declared = manifestSha(manifest, spec);
    if (declared !== actual) {
      throw new Error(
        `manifest declares ${declared} for ${spec.file} but the file hashes to ${actual}`,
      );
    }
    files.push({
      model: spec.model,
      file: spec.file,
      sha256: actual,
      bytes: statSync(file).size,
    });
  }

  if (wanted.has("image-classifier")) {
    const threshold = manifest.models?.["image-classifier"]?.threshold;
    if (threshold !== PINNED_CLASSIFIER_THRESHOLD) {
      throw new Error(
        `manifest classifier threshold is ${threshold}; the pilot pins ${PINNED_CLASSIFIER_THRESHOLD}`,
      );
    }
  }

  return { manifestPath, manifestSha256: sha256File(manifestPath), files };
}

function suiteInputs(config, suite) {
  const data = path.join(config.toolchain, "data");
  if (suite === "classifier") {
    return {
      frozenManifest: path.join(data, "manifests", "frozen", "classifier.frozen.json"),
      frozenManifestHash: PINNED_HASHES.classifierFrozen,
      labels: path.join(data, "benchmark", "classifier-curated", "labels.jsonl"),
      labelsHash: PINNED_HASHES.classifierLabels,
      evalFp16: path.join(data, "benchmark", "eval-1000", "classifier.e4-fp16.eval1000.json"),
      evalFp16Hash: PINNED_HASHES.classifierEvalFp16,
      evalFp32: path.join(data, "benchmark", "eval-1000", "classifier.fp32.eval1000.json"),
      defaultRoot: path.join(data, "benchmark", "classifier-curated"),
    };
  }
  return {
    frozenManifest: path.join(data, "manifests", "frozen", "handdrawn.frozen.json"),
    frozenManifestHash: PINNED_HASHES.handdrawnFrozen,
    labels: path.join(data, "benchmark", "handdrawn-hdm", "labels.jsonl"),
    labelsHash: PINNED_HASHES.handdrawnLabels,
    pilotReference: path.join(data, "benchmark", "pilot", "handdrawn.fp32.pilot300.json"),
    pilotReferenceHash: PINNED_HASHES.handdrawnPilotFp32,
    defaultRoot: path.join(data, "benchmark", "handdrawn-hdm"),
  };
}

function verifyInputHashes(inputs) {
  const hashes = {};
  for (const [key, file] of Object.entries(inputs)) {
    if (!key.endsWith("Hash")) continue;
    const targetKey = key.slice(0, -4);
    const target = inputs[targetKey];
    if (!target) continue;
    ensureFile(target, targetKey);
    hashes[targetKey] = assertHash(target, file, targetKey);
  }
  if (inputs.evalFp32) {
    ensureFile(inputs.evalFp32, "evalFp32");
    hashes.evalFp32 = sha256File(inputs.evalFp32);
  }
  return hashes;
}

// --- Sidecar ---------------------------------------------------------------

function buildSidecarEnv(config, port) {
  const env = {
    ...process.env,
    INDIGO_PORT: String(port),
    CHEMISTRY_MODELS_DIR: config.models,
    ORT_DYLIB_PATH: config.ort,
  };
  const libDir = path.join(REPO_ROOT, "src-tauri", "lib", "linux-x86_64");
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
  return env;
}

/**
 * Reserve a free loopback port for the sidecar.
 *
 * `INDIGO_PORT=0` is not usable here: the sidecar binds port 0 but reports the
 * literal `INDIGO_PORT=0` on stdout, so the actual port is unknowable. The
 * runner therefore allocates an ephemeral port and passes it explicitly; it
 * never probes or binds 9321.
 */
async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

/**
 * Stop a spawned sidecar and wait for its stdio to close (SIGTERM, then
 * SIGKILL after a grace period). Safe to call when the child never spawned.
 */
async function terminateChild(child) {
  if (child.pid === undefined) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "close").catch(() => {}),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function startSidecar(config, runDir) {
  ensureFile(config.sidecar, "sidecar binary");
  ensureFile(config.ort, "ONNX Runtime library");

  const requestedPort = await freeLoopbackPort();
  const logPath = path.join(runDir, "sidecar.log");
  const log = createWriteStream(logPath, { flags: "a" });
  log.on("error", () => {
    // The log is diagnostic only: a late write after close must not mask the
    // startup error being reported.
  });
  const child = spawn(config.sidecar, [], {
    cwd: config.cwd,
    env: buildSidecarEnv(config, requestedPort),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settled = false;
  let stdout = "";
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`sidecar did not report INDIGO_PORT within 30 s (log: ${logPath})`));
      }, 30_000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        log.write(chunk);
        const match = /^INDIGO_PORT=(\d+)$/m.exec(stdout);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          const reported = Number(match[1]);
          if (reported === 0) {
            reject(new Error("sidecar reported port 0 and cannot be reached"));
            return;
          }
          resolve(reported);
        }
      });
      child.stderr.on("data", (chunk) => log.write(chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`sidecar failed to start: ${error.message} (log: ${logPath})`));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `sidecar exited before reporting a port (code ${code}, signal ${signal}; log: ${logPath})`,
          ),
        );
      });
    });
  } catch (error) {
    // The runner is the sidecar's only supervisor: never leave the spawned
    // child behind when startup fails (timeout, spawn error or early exit).
    await terminateChild(child);
    await new Promise((resolve) => log.end(resolve));
    throw error;
  }

  return { child, log, logPath, port };
}

async function stopSidecar(handle) {
  if (!handle) return;
  const { child, log } = handle;
  await terminateChild(child);
  await new Promise((resolve) => log.end(resolve));
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v2/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }

  throw new Error(`sidecar health never became ready: ${lastError?.message ?? "timeout"}`);
}

function assertHealth(health, suite) {
  const models = Array.isArray(health.models) ? health.models : [];
  const required =
    suite === "classifier"
      ? [CLASSIFIER_MODEL_ID]
      : suite === "handdrawn"
        ? [HANDDRAWN_MODEL_ID]
        : [CLASSIFIER_MODEL_ID, HANDDRAWN_MODEL_ID];
  const missing = required.filter((id) => !models.includes(id));
  if (missing.length > 0) {
    throw new Error(`/v2/health does not list ${missing.join(", ")}; found ${models.join(", ")}`);
  }
}

async function postImage(baseUrl, route, file, config) {
  const body = readFileSync(file);
  const started = performance.now();
  let response;

  try {
    response = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": mediaType(file) },
      body,
      signal: AbortSignal.timeout(config.timeout),
    });
  } catch (error) {
    throw new Error(`POST ${route} failed for ${file}: ${error.message}`, { cause: error });
  }

  const latencyMs = performance.now() - started;
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // The body of a non-JSON error is recorded by the caller.
  }

  return { status: response.status, json, text: text.slice(0, 2_000), latencyMs };
}

// --- Conversion ------------------------------------------------------------

function safeConvertedName(index, file) {
  const base = path
    .basename(file, path.extname(file))
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 120);
  return `${String(index).padStart(3, "0")}-${base}.png`;
}

function convertImages(config, runDir, entries, folder) {
  const pending = entries.filter((entry) => entry.converted);
  if (pending.length === 0) return { count: 0, command: null, mapPath: null };

  const convertDir = path.join(runDir, "converted", folder);
  mkdirSync(convertDir, { recursive: true });

  const pairs = pending.map((entry) => ({
    id: entry.id,
    input: entry.original,
    output: entry.output,
  }));
  const mapPath = path.join(runDir, `converted-${folder}.json`);
  writeFileSync(mapPath, `${JSON.stringify(pairs, null, 2)}\n`);

  const args = ["-c", CONVERT_SCRIPT, mapPath];
  try {
    execFileSync(config.python, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`Pillow conversion failed for ${pending.length} image(s): ${error.message}`, {
      cause: error,
    });
  }

  for (const entry of pending) {
    ensureFile(entry.output, `converted image ${entry.id}`);
  }

  return {
    count: pending.length,
    command: commandString(config.python, args),
    mapPath,
  };
}

function buildEntries(config, pilotIds, labels, root, runDir, folder) {
  const entries = pilotIds.map((id, index) => {
    const label = labels.get(id);
    if (!label) throw new Error(`missing label for pilot id ${id}`);

    const original = resolveImage(root, label);
    ensureFile(original, `image for ${id}`);

    const converted = needsConversion(original);
    return {
      index,
      id,
      label,
      original,
      converted,
      output: converted
        ? path.join(runDir, "converted", folder, safeConvertedName(index, original))
        : original,
    };
  });

  const conversion = convertImages(config, runDir, entries, folder);
  return { entries, conversion };
}

// --- Classifier ------------------------------------------------------------

function expectedFromCategory(category) {
  return binaryLabel(category);
}

function deriveClassifierReference(evalFile, pilotIds, label) {
  const reference = referenceFromEval(evalFile.details, pilotIds);
  const { metrics } = reference;

  const actual = {
    tp: metrics.tp,
    fn: metrics.fn,
    fp: metrics.fp,
    tn: metrics.tn,
    total: metrics.total,
    excluded: metrics.excluded,
    accuracy: metrics.accuracy,
    reactionsStructure: reference.reactions.predictedStructure,
    reactionsNoStructure: reference.reactions.predictedNoStructure,
  };
  if (
    actual.tp !== CLASSIFIER_REFERENCE.tp ||
    actual.fn !== CLASSIFIER_REFERENCE.fn ||
    actual.fp !== CLASSIFIER_REFERENCE.fp ||
    actual.tn !== CLASSIFIER_REFERENCE.tn ||
    actual.total !== CLASSIFIER_REFERENCE.total ||
    actual.excluded !== CLASSIFIER_REFERENCE.excluded ||
    actual.reactionsStructure !== CLASSIFIER_REFERENCE.reactionsStructure ||
    actual.reactionsNoStructure !== CLASSIFIER_REFERENCE.reactionsNoStructure
  ) {
    throw new Error(
      `${label} reference does not match the pinned same-pilot aggregate: ` +
        `TP/FN/FP/TN ${actual.tp}/${actual.fn}/${actual.fp}/${actual.tn}, ` +
        `n=${actual.total}, excluded=${actual.excluded}, ` +
        `reactions=${actual.reactionsStructure}/${actual.reactionsNoStructure}`,
    );
  }

  const perIdSha256 = sha256Json(pilotIds.map((id) => reference.predictions.get(id)));

  return { ...reference, metrics: actual, perIdSha256 };
}

function compareClassifierPredictions(rows, reference, pilotIds) {
  let agreements = 0;
  const disagreements = [];

  for (const row of rows) {
    const referenceRow = reference.predictions.get(row.id);
    if (!referenceRow) throw new Error(`reference is missing ${row.id}`);
    if (referenceRow.predicted === row.predicted) {
      agreements += 1;
    } else {
      disagreements.push({
        id: row.id,
        expected: row.expected,
        reference: referenceRow.predicted,
        sidecar: row.predicted,
        score: row.score,
      });
    }
  }

  return { total: pilotIds.length, agreements, disagreements };
}

async function runClassifier(config, runDir, baseUrl) {
  const inputs = suiteInputs(config, "classifier");
  const inputHashes = verifyInputHashes(inputs);
  const root = config.classifierRoot ?? inputs.defaultRoot;

  const frozen = readJson(inputs.frozenManifest);
  const pilotIds = selectSplit(frozen, config.split);
  const labels = parseLabelsJsonl(readFileSync(inputs.labels, "utf8"));

  const reference = deriveClassifierReference(readJson(inputs.evalFp16), pilotIds, "FP16");
  const fp32Reference = deriveClassifierReference(readJson(inputs.evalFp32), pilotIds, "FP32");

  const { entries, conversion } = buildEntries(
    config,
    pilotIds,
    labels,
    root,
    runDir,
    "classifier",
  );

  const first = entries[0];
  const warmup = await postImage(baseUrl, "/v2/filter/classify", first.output, config);
  if (warmup.status !== 200) {
    throw new Error(
      `classifier warm-up failed with HTTP ${warmup.status} for ${first.id}: ${warmup.text}`,
    );
  }

  const rows = [];
  const latencies = [];

  for (const entry of entries) {
    const response = await postImage(baseUrl, "/v2/filter/classify", entry.output, config);
    if (response.status !== 200 || !response.json) {
      throw new Error(
        `classifier request failed with HTTP ${response.status} for ${entry.id}: ${response.text}`,
      );
    }

    const payload = response.json;
    if (typeof payload.category !== "string" || typeof payload.score !== "number") {
      throw new Error(`classifier response for ${entry.id} is malformed: ${response.text}`);
    }
    if (payload.threshold !== PINNED_CLASSIFIER_THRESHOLD) {
      throw new Error(
        `classifier echoed threshold ${payload.threshold} for ${entry.id}; ` +
          `the pilot pins ${PINNED_CLASSIFIER_THRESHOLD}`,
      );
    }
    const fromScore = predictedFromScore(payload.score, payload.threshold);
    if (fromScore !== payload.category) {
      throw new Error(
        `threshold direction mismatch for ${entry.id}: score ${payload.score} ` +
          `implies ${fromScore}, sidecar says ${payload.category}`,
      );
    }

    const expected = expectedFromCategory(entry.label.category);
    const includedInBinary = expected !== null;
    const referenceRow = reference.predictions.get(entry.id);
    if (referenceRow.includedInBinary !== includedInBinary) {
      throw new Error(
        `label/reference inclusion mismatch for ${entry.id}: ` +
          `label ${entry.label.category}, reference included=${referenceRow.includedInBinary}`,
      );
    }
    if (includedInBinary && referenceRow.expected !== expected) {
      throw new Error(
        `label/reference expected mismatch for ${entry.id}: ${expected} vs ${referenceRow.expected}`,
      );
    }

    latencies.push(response.latencyMs);
    rows.push({
      id: entry.id,
      category: entry.label.category,
      expected,
      predicted: payload.category,
      includedInBinary,
      score: payload.score,
      threshold: payload.threshold,
      logit: payload.logit ?? null,
      image: entry.original,
      converted: entry.converted ? entry.output : null,
      latencyMs: Number(response.latencyMs.toFixed(3)),
      referencePredicted: referenceRow.predicted,
      fp32Predicted: fp32Reference.predictions.get(entry.id).predicted,
    });
  }

  if (rows.length !== pilotIds.length) {
    throw new Error(`classifier ran ${rows.length} rows, expected ${pilotIds.length}`);
  }

  const metrics = classifierMetrics(rows);
  const reactions = {
    total: metrics.excluded,
    predictedStructure: rows.filter((row) => !row.includedInBinary && row.predicted === "structure")
      .length,
    predictedNoStructure: rows.filter(
      (row) => !row.includedInBinary && row.predicted === "no-structure",
    ).length,
  };

  const referenceAgreement = compareClassifierPredictions(rows, reference, pilotIds);
  const fp32Agreement = compareClassifierPredictions(rows, fp32Reference, pilotIds);

  const gateFailures = [];
  if (!(metrics.accuracy >= GATES.classifierAccuracy)) {
    gateFailures.push(
      `binary accuracy ${metrics.accuracy.toFixed(4)} < ${GATES.classifierAccuracy}`,
    );
  }
  if (metrics.total !== CLASSIFIER_REFERENCE.total) {
    gateFailures.push(`binary n ${metrics.total} != ${CLASSIFIER_REFERENCE.total}`);
  }
  if (metrics.excluded !== CLASSIFIER_REFERENCE.excluded) {
    gateFailures.push(`reaction rows ${metrics.excluded} != ${CLASSIFIER_REFERENCE.excluded}`);
  }
  if (rows.length !== 300) {
    gateFailures.push(`decoded rows ${rows.length} != 300`);
  }

  const summary = {
    split: config.split,
    pilotIds: pilotIds.length,
    datasetRoot: root,
    inputs: {
      frozenManifest: inputs.frozenManifest,
      frozenSha256: inputHashes.frozenManifest,
      labels: inputs.labels,
      labelsSha256: inputHashes.labels,
      evalFp16: inputs.evalFp16,
      evalFp16Sha256: inputHashes.evalFp16,
      evalFp32: inputs.evalFp32,
      evalFp32Sha256: inputHashes.evalFp32,
    },
    reference: {
      metrics: reference.metrics,
      reactions: reference.reactions,
      perIdSha256: reference.perIdSha256,
      fp32Metrics: fp32Reference.metrics,
      fp32PerIdSha256: fp32Reference.perIdSha256,
      accuracyDelta: rateDelta(metrics.accuracy, reference.metrics.accuracy),
    },
    metrics,
    reactions,
    latency: {
      warmupMs: Number(warmup.latencyMs.toFixed(3)),
      ...summarizeLatency(latencies),
    },
    conversion: {
      count: conversion.count,
      command: conversion.command,
      map: conversion.mapPath,
    },
    agreement: {
      fp16: referenceAgreement,
      fp32: fp32Agreement,
    },
    gate: {
      threshold: GATES.classifierAccuracy,
      pass: gateFailures.length === 0,
      failures: gateFailures,
    },
  };

  return { summary, details: rows.map((row) => ({ suite: "classifier", ...row })) };
}

// --- Hand-drawn OCSR -------------------------------------------------------

function stripNamespace(id) {
  const separator = id.indexOf("::");
  return separator === -1 ? id : id.slice(separator + 2);
}

function deriveHanddrawnReference(referenceFile, pilotIds) {
  if (!Array.isArray(referenceFile.details)) {
    throw new Error("hand-drawn reference has no details array");
  }

  const byId = new Map();
  for (const detail of referenceFile.details) {
    if (byId.has(detail.id)) {
      throw new Error(`hand-drawn reference has duplicate id ${detail.id}`);
    }
    byId.set(detail.id, detail);
  }

  const missing = pilotIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`hand-drawn reference is missing ${missing.length} pilot id(s)`);
  }

  let exact = 0;
  let canonical = 0;
  let comparable = 0;
  let valid = 0;
  let incomplete = 0;
  for (const id of pilotIds) {
    const detail = byId.get(id);
    if (detail.exact_match === true) exact += 1;
    if (detail.canonical_match === true) canonical += 1;
    if (typeof detail.canonical_match === "boolean") comparable += 1;
    if (detail.valid === true) valid += 1;
    if (detail.incomplete === true) incomplete += 1;
  }

  const actual = { exact, canonical, comparable, valid, incomplete };
  for (const [key, expected] of Object.entries(HANDDRAWN_REFERENCE)) {
    if (actual[key] !== expected) {
      throw new Error(
        `hand-drawn reference ${key} is ${actual[key]}, expected ${expected} ` +
          `(reference file does not match the pinned pilot)`,
      );
    }
  }

  const perIdSha256 = sha256Json(
    pilotIds.map((id) => {
      const detail = byId.get(id);
      return { id, got: detail.got ?? null, canonicalGot: detail.canonical_got ?? null };
    }),
  );

  return { actual, byId, perIdSha256 };
}

function readJsonl(file) {
  const rows = [];
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function runHanddrawn(config, runDir, baseUrl) {
  const inputs = suiteInputs(config, "handdrawn");
  const inputHashes = verifyInputHashes(inputs);
  const root = config.handdrawnRoot ?? inputs.defaultRoot;

  const frozen = readJson(inputs.frozenManifest);
  const pilotIds = selectSplit(frozen, config.split);
  const labels = parseLabelsJsonl(readFileSync(inputs.labels, "utf8"));
  const reference = deriveHanddrawnReference(readJson(inputs.pilotReference), pilotIds);

  // Hand-drawn labels carry the bare HDM id; the frozen pilot prefixes `hdm::`.
  const labelById = new Map();
  for (const [id, label] of labels) {
    labelById.set(id, label);
  }

  const entries = pilotIds.map((id) => {
    const label = labelById.get(stripNamespace(id));
    if (!label) throw new Error(`missing hand-drawn label for ${id}`);
    if (typeof label.smiles !== "string" || label.smiles === "") {
      throw new Error(`hand-drawn label ${id} has no smiles`);
    }
    return { id, label };
  });

  const { entries: imageEntries, conversion } = buildEntries(
    config,
    entries.map((entry) => entry.id),
    new Map(
      entries.map((entry) => [
        entry.id,
        { id: entry.id, image: entry.label.image, smiles: entry.label.smiles },
      ]),
    ),
    root,
    runDir,
    "handdrawn",
  );
  const entryById = new Map(imageEntries.map((entry) => [entry.id, entry]));

  const first = imageEntries[0];
  const warmup = await postImage(baseUrl, "/v2/ocsr/recognize", first.output, config);
  if (warmup.status !== 200) {
    throw new Error(
      `OCSR warm-up failed with HTTP ${warmup.status} for ${first.id}: ${warmup.text}`,
    );
  }

  const rows = [];
  const latencies = [];
  const pairs = [];

  for (const entry of entries) {
    const image = entryById.get(entry.id);
    const response = await postImage(baseUrl, "/v2/ocsr/recognize", image.output, config);
    if (response.status !== 200 && response.status !== 422) {
      throw new Error(
        `OCSR request failed with HTTP ${response.status} for ${entry.id}: ${response.text}`,
      );
    }

    let smiles = null;
    let confidence = null;
    let valid = false;
    // Only an explicit 422 is an incomplete decode. A 200 body must be JSON
    // with a SMILES; a malformed success fails the run instead of silently
    // counting as incomplete.
    if (response.status === 200) {
      if (!response.json) {
        throw new Error(
          `OCSR response for ${entry.id} is not JSON: ${response.text || "<empty body>"}`,
        );
      }
      if (typeof response.json.smiles !== "string" || response.json.smiles === "") {
        throw new Error(`OCSR response for ${entry.id} has no smiles`);
      }
      if (response.json.incomplete !== true) {
        smiles = response.json.smiles;
        valid = true;
        confidence = typeof response.json.confidence === "number" ? response.json.confidence : null;
      }
    }

    latencies.push(response.latencyMs);
    pairs.push({ id: entry.id, expected: entry.label.smiles, got: smiles });
    rows.push({
      id: entry.id,
      expected: entry.label.smiles,
      got: smiles,
      status: response.status,
      valid,
      confidence,
      image: image.original,
      converted: image.converted ? image.output : null,
      latencyMs: Number(response.latencyMs.toFixed(3)),
    });
  }

  if (rows.length !== pilotIds.length) {
    throw new Error(`OCSR ran ${rows.length} rows, expected ${pilotIds.length}`);
  }

  const pairsPath = path.join(runDir, "handdrawn-pairs.jsonl");
  const matchedPath = path.join(runDir, "handdrawn-rdkit.jsonl");
  writeFileSync(pairsPath, pairs.map((pair) => JSON.stringify(pair)).join("\n") + "\n");

  const helper = path.join(REPO_ROOT, "scripts", "lib", "ocsr-match.py");
  try {
    execFileSync(config.python, [helper, pairsPath, matchedPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`RDKit comparison failed: ${error.message}`, { cause: error });
  }

  const matched = readJsonl(matchedPath);
  if (matched.length !== rows.length) {
    throw new Error(`RDKit comparison returned ${matched.length} rows, expected ${rows.length}`);
  }
  const matchedById = new Map(matched.map((row) => [row.id, row]));

  const metricRows = rows.map((row) => {
    const result = matchedById.get(row.id);
    if (!result) throw new Error(`RDKit comparison is missing ${row.id}`);
    return {
      id: row.id,
      expected: row.expected,
      got: row.got,
      exact: result.exact === true,
      canonical: result.canonical,
      valid: result.valid === true,
      incomparable: result.incomparable === true,
      canonicalGot: result.canonical_got ?? null,
      canonicalExpected: result.canonical_expected ?? null,
    };
  });

  const metrics = ocsrMetrics(metricRows);

  let exactAgreements = 0;
  let canonicalAgreements = 0;
  let canonicalComparableAgreements = 0;
  const disagreements = [];
  for (const row of metricRows) {
    const referenceRow = reference.byId.get(row.id);
    if (row.got === referenceRow.got) {
      exactAgreements += 1;
    } else {
      disagreements.push({
        id: row.id,
        expected: referenceRow.expected,
        referenceGot: referenceRow.got,
        sidecarGot: row.got,
        canonicalMatch: row.canonical,
      });
    }
    if (row.canonicalGot !== null && referenceRow.canonical_got !== null) {
      canonicalComparableAgreements += 1;
      if (row.canonicalGot === referenceRow.canonical_got) canonicalAgreements += 1;
    }
  }

  const gateFailures = [];
  if (!(metrics.canonicalRate >= GATES.ocsrCanonical)) {
    gateFailures.push(
      `canonical ${metrics.canonical}/${metrics.comparable} ` +
        `(${metrics.canonicalRate.toFixed(4)}) < ${GATES.ocsrCanonical}`,
    );
  }
  if (rows.length !== 300) gateFailures.push(`rows ${rows.length} != 300`);
  const badStatuses = rows.filter((row) => row.status !== 200 && row.status !== 422);
  if (badStatuses.length > 0) {
    gateFailures.push(`${badStatuses.length} row(s) with a status other than 200/422`);
  }

  const confidences = rows
    .map((row) => row.confidence)
    .filter((value) => typeof value === "number");

  const summary = {
    split: config.split,
    pilotIds: pilotIds.length,
    datasetRoot: root,
    inputs: {
      frozenManifest: inputs.frozenManifest,
      frozenSha256: inputHashes.frozenManifest,
      labels: inputs.labels,
      labelsSha256: inputHashes.labels,
      pilotReference: inputs.pilotReference,
      pilotReferenceSha256: inputHashes.pilotReference,
    },
    reference: {
      ...reference.actual,
      perIdSha256: reference.perIdSha256,
      exactDelta: rateDelta(metrics.exactRate, HANDDRAWN_REFERENCE.exact / 300),
      canonicalDelta: rateDelta(
        metrics.canonicalRate,
        HANDDRAWN_REFERENCE.canonical / HANDDRAWN_REFERENCE.comparable,
      ),
      validDelta: rateDelta(metrics.validRate, HANDDRAWN_REFERENCE.valid / 300),
    },
    metrics,
    latency: {
      warmupMs: Number(warmup.latencyMs.toFixed(3)),
      ...summarizeLatency(latencies),
    },
    conversion: {
      count: conversion.count,
      command: conversion.command,
      map: conversion.mapPath,
    },
    agreement: {
      exact: { total: pilotIds.length, agreements: exactAgreements, disagreements },
      canonical: {
        comparable: canonicalComparableAgreements,
        agreements: canonicalAgreements,
        rate:
          canonicalComparableAgreements === 0
            ? 0
            : canonicalAgreements / canonicalComparableAgreements,
      },
    },
    confidence: {
      responses: confidences.length,
      min: confidences.length === 0 ? null : Math.min(...confidences),
      max: confidences.length === 0 ? null : Math.max(...confidences),
      mean:
        confidences.length === 0
          ? null
          : confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
    },
    gate: {
      threshold: GATES.ocsrCanonical,
      pass: gateFailures.length === 0,
      failures: gateFailures,
    },
  };

  const details = rows.map((row, index) => {
    const metric = metricRows[index];
    const referenceRow = reference.byId.get(row.id);
    return {
      suite: "handdrawn",
      ...row,
      exact: metric.exact,
      canonical: metric.canonical,
      incomparable: metric.incomparable,
      canonicalExpected: metric.canonicalExpected,
      canonicalGot: metric.canonicalGot,
      referenceGot: referenceRow.got ?? null,
      referenceCanonicalGot: referenceRow.canonical_got ?? null,
    };
  });

  return { summary, details };
}

// --- Main ------------------------------------------------------------------

function sidecarCommand(config, port) {
  const env = [
    `INDIGO_PORT=${port}`,
    `CHEMISTRY_MODELS_DIR=${config.models}`,
    `ORT_DYLIB_PATH=${config.ort}`,
    `LD_LIBRARY_PATH=${path.join(REPO_ROOT, "src-tauri", "lib", "linux-x86_64")}:$LD_LIBRARY_PATH`,
  ];
  return `${env.join(" ")} ${commandString(config.sidecar, [])}`;
}

function runnerCommand() {
  const args = process.argv.slice(1);
  return commandString(process.execPath, args);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = resolveConfig(options);
  if (existsSync(path.join(config.out, "summary.json"))) {
    throw new Error(`run directory already contains a summary: ${config.out}`);
  }
  mkdirSync(config.out, { recursive: true });

  const startedAt = new Date();
  const toolchain = verifyToolchain(config);
  const models = verifyModels(config);
  const cpu = cpuDescription();

  let sidecar = null;
  let failed = false;

  try {
    sidecar = await startSidecar(config, config.out);
    const baseUrl = `http://127.0.0.1:${sidecar.port}`;
    const health = await waitForHealth(baseUrl);
    assertHealth(health, config.suite);

    console.log(`sidecar ready on ${baseUrl} (pid ${sidecar.child.pid})`);

    const summary = {
      schema: 1,
      kind: "model-parity",
      runId: config.runId,
      date: startedAt.toISOString(),
      suite: config.suite,
      split: config.split,
      machine: {
        platform: `${os.platform()} ${os.release()}`,
        cpu,
        node: process.version,
      },
      repo: repoIdentity(),
      toolchain: {
        dir: config.toolchain,
        commit: toolchain.commit,
        python: config.python,
        pillow: toolchain.versions.pillow,
        rdkit: toolchain.versions.rdkit,
      },
      sidecar: {
        binary: config.sidecar,
        sha256: sha256File(config.sidecar),
        mtime: MTIME(config.sidecar),
        port: sidecar.port,
        log: sidecar.logPath,
        health,
      },
      models: {
        root: config.models,
        manifest: models.manifestPath,
        manifestSha256: models.manifestSha256,
        files: models.files,
      },
      args: config.argv,
      commands: {
        sidecar: sidecarCommand(config, sidecar.port),
        runner: runnerCommand(),
      },
      gate: { pass: true, failures: [] },
      details: {
        file: path.join(config.out, "details.jsonl"),
        rows: 0,
      },
    };

    const details = [];

    if (config.suite === "classifier" || config.suite === "both") {
      console.log("running classifier pilot...");
      const result = await runClassifier(config, config.out, baseUrl);
      summary.classifier = result.summary;
      details.push(...result.details);
      console.log(
        `classifier: ${result.summary.metrics.tp}/${result.summary.metrics.fn}/` +
          `${result.summary.metrics.fp}/${result.summary.metrics.tn}, ` +
          `accuracy ${result.summary.metrics.accuracy.toFixed(4)}, ` +
          `gate ${result.summary.gate.pass ? "PASS" : "FAIL"}`,
      );
    }

    if (config.suite === "handdrawn" || config.suite === "both") {
      console.log("running hand-drawn OCSR pilot...");
      const result = await runHanddrawn(config, config.out, baseUrl);
      summary.handdrawn = result.summary;
      details.push(...result.details);
      console.log(
        `handdrawn: canonical ${result.summary.metrics.canonical}/` +
          `${result.summary.metrics.comparable}, exact ` +
          `${result.summary.metrics.exact}/${result.summary.metrics.total}, ` +
          `gate ${result.summary.gate.pass ? "PASS" : "FAIL"}`,
      );
    }

    summary.details.rows = details.length;

    for (const key of ["classifier", "handdrawn"]) {
      const suite = summary[key];
      if (!suite) continue;
      if (!suite.gate.pass) {
        summary.gate.pass = false;
        summary.gate.failures.push(...suite.gate.failures.map((failure) => `${key}: ${failure}`));
      }
    }

    writeFileSync(
      path.join(config.out, "details.jsonl"),
      details.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(path.join(config.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`\nrun directory: ${config.out}`);
    console.log(`summary: ${path.join(config.out, "summary.json")}`);
    console.log(`details: ${path.join(config.out, "details.jsonl")}`);
    if (!summary.gate.pass) {
      failed = true;
      console.error(`GATE FAIL: ${summary.gate.failures.join("; ")}`);
    } else {
      console.log("GATES PASS");
    }
  } finally {
    await stopSidecar(sidecar);
  }

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`model-parity: ${error.message}`);
  process.exitCode = 1;
});
