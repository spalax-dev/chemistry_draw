// E1 Ketcher 3.21 contract: the exact pins, the committed multi-language
// `ketcher-react` tarball, the narrowed `parametrizeUrl` patch and the manifest
// that installs them. Indigo/Imago pins belong to activity 3 (`e1-indigo`).
//
// These are configuration contracts. The tests read the real files — manifests,
// the committed tarball, the pnpm workspace, the patch, the build script and
// the installed bundle — and never build a package, run Ketcher or touch the
// network. A reinstall that silently restores the English-only npm build or the
// 3.18 patch entry must fail here.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const KETCHER_VERSION = "3.21.0";
const KETCHER_REACT_TARBALL = "vendor/ketcher-react/ketcher-react-3.21.0-multi.tgz";
const KETCHER_REACT_SPEC = `file:${KETCHER_REACT_TARBALL}`;
const REQUIRED_NODE_VERSION = "24.20.0";
const PATCH_KEY = `ketcher-core@${KETCHER_VERSION}`;
const PATCH_PATH = `patches/${PATCH_KEY}.patch`;
const REMOTE_STRUCT_FILES = ["remoteStructService.js", "remoteStructService.modern.js"];

// ── package.json and .nvmrc: the exact pins ──

test("package.json pins Ketcher 3.21.0, the tarball and React 18.3.1", () => {
  const pkg = readJson("package.json");

  assert.equal(
    pkg.dependencies?.["ketcher-core"],
    KETCHER_VERSION,
    "ketcher-core must be pinned exactly to 3.21.0 (no caret)",
  );
  assert.equal(
    pkg.dependencies?.["ketcher-react"],
    KETCHER_REACT_SPEC,
    `ketcher-react must resolve to the multi-language tarball ${KETCHER_REACT_SPEC}`,
  );
  assert.equal(pkg.dependencies?.react, "18.3.1", "react must stay exactly 18.3.1");
  assert.equal(pkg.dependencies?.["react-dom"], "18.3.1", "react-dom must stay exactly 18.3.1");
});

test("the Node floor is 24.20.0 in package.json and .nvmrc", () => {
  const pkg = readJson("package.json");

  assert.equal(
    pkg.engines?.node,
    `>=${REQUIRED_NODE_VERSION} <25`,
    `engines.node must be >=${REQUIRED_NODE_VERSION} <25 (Ketcher 3.21 floor)`,
  );
  assert.ok(existsSync(path.join(ROOT, ".nvmrc")), "missing .nvmrc");
  assert.equal(
    read(".nvmrc").trim(),
    REQUIRED_NODE_VERSION,
    `.nvmrc must pin ${REQUIRED_NODE_VERSION}`,
  );
});

// ── the committed tarball ──

/** A gzip-compressed tar starts with 1f 8b and carries the `ustar` header. */
function isTarGz(filePath) {
  const compressed = readFileSync(filePath);
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) return false;

  const tar = gunzipSync(compressed);
  return tar.length > 512 && tar.subarray(257, 262).toString("ascii") === "ustar";
}

test("the committed ketcher-react tarball is a real build", () => {
  const tarballPath = path.join(ROOT, KETCHER_REACT_TARBALL);

  // The artifact is committed so CI, Windows and fresh worktrees install it
  // without a Node 24.20 build host.
  assert.ok(
    existsSync(tarballPath),
    `${KETCHER_REACT_TARBALL} must be committed: CI and fresh worktrees install it without a Node ${REQUIRED_NODE_VERSION} build`,
  );
  const { size } = statSync(tarballPath);
  assert.ok(size > 1_000_000, `the committed tarball must be a real build, found ${size} bytes`);
  assert.ok(isTarGz(tarballPath), "the committed artifact must be a gzip-compressed tar");
});

// ── pnpm-workspace.yaml ──

test("pnpm-workspace.yaml patches exactly ketcher-core@3.21.0", () => {
  const workspace = parse(read("pnpm-workspace.yaml"));
  const patched = workspace.patchedDependencies ?? {};

  assert.deepEqual(
    Object.keys(patched),
    [PATCH_KEY],
    "patchedDependencies must name exactly ketcher-core@3.21.0",
  );
  assert.equal(patched[PATCH_KEY], PATCH_PATH, `the 3.21.0 entry must point at ${PATCH_PATH}`);
  assert.ok(
    !Object.keys(patched).some((key) => key.includes("3.18")),
    "the obsolete 3.18.0 patch entry must be gone",
  );
  assert.equal(workspace.allowBuilds?.esbuild, false, "the allowBuilds map must be preserved");
});

test("pnpm-workspace.yaml keeps the security pins and the Ketcher overrides", () => {
  const overrides = parse(read("pnpm-workspace.yaml")).overrides ?? {};

  assert.deepEqual(
    {
      "fast-uri": overrides["fast-uri"],
      postcss: overrides.postcss,
      nanoid: overrides.nanoid,
      "source-map-js": overrides["source-map-js"],
      browserslist: overrides.browserslist,
      qs: overrides.qs,
      pbkdf2: overrides.pbkdf2,
    },
    {
      "fast-uri": "^3.1.9",
      postcss: "^8.5.23",
      nanoid: "^3.3.18",
      "source-map-js": "^1.2.2",
      browserslist: "^4.28.7",
      qs: "^6.16.1",
      pbkdf2: "^3.1.7",
    },
    "the US-10 security overrides must survive the Ketcher upgrade",
  );
  assert.equal(
    overrides["ketcher-core"],
    KETCHER_VERSION,
    "overrides must pin ketcher-core 3.21.0",
  );
  assert.equal(
    overrides["ketcher-react"],
    KETCHER_REACT_SPEC,
    "overrides must route ketcher-react to the committed tarball",
  );
});

// ── patches/ketcher-core@3.21.0.patch ──

test("the 3.21.0 patch contains only the two parametrizeUrl hunks", () => {
  assert.ok(existsSync(path.join(ROOT, PATCH_PATH)), `${PATCH_PATH} must exist`);

  const patch = read(PATCH_PATH);
  const sections = patch.split(/^diff --git /m).filter(Boolean);

  assert.equal(
    sections.length,
    REMOTE_STRUCT_FILES.length,
    "the patch must contain one section per remoteStructService dist build",
  );
  assert.doesNotMatch(patch, /rebond/i, "the ReBond half-bond guard is upstream in 3.21.0");
  assert.doesNotMatch(patch, /halfBonds/, "the ReBond half-bond guard is upstream in 3.21.0");

  for (const file of REMOTE_STRUCT_FILES) {
    const section = sections.find((part) => part.includes(`/${file} b/`));

    assert.ok(section, `missing patch section for ${file}`);
    assert.match(section, /function parametrizeUrl/, `${file} must patch parametrizeUrl`);
    assert.ok(section.includes(":([A-Za-z_]\\w*)"), `${file} must narrow the placeholder regex`);
    assert.match(
      section,
      /hasOwnProperty\.call\(params, key\)/,
      `${file} must keep the own-property guard`,
    );
    assert.equal(section.match(/^@@/gm)?.length, 1, `${file} must contain exactly one hunk`);
  }
});

// ── scripts/build-ketcher-react.sh ──

test("build-ketcher-react.sh regenerates the pinned multi-language tarball with pnpm", () => {
  const scriptPath = "scripts/build-ketcher-react.sh";
  assert.ok(
    existsSync(path.join(ROOT, scriptPath)),
    `${scriptPath} must exist: the published npm ketcher-react is English-only`,
  );

  const script = read(scriptPath);

  // The build must come from the pinned tag, not from a floating checkout.
  assert.match(
    script,
    /(?:git\s+checkout|--branch)[^\n]*\bv3\.21\.0\b/,
    "the script must check out tag v3.21.0",
  );

  // The tag's engines field requires Node >= 24.20.0; an older Node fails the
  // upstream build with a confusing error, so the script must guard it.
  assert.ok(
    script.includes(REQUIRED_NODE_VERSION),
    `the script must require Node >= ${REQUIRED_NODE_VERSION}`,
  );
  assert.match(script, /\bnode\b/i, "the Node requirement must be enforced");

  // The flag is a build-time `@rollup/plugin-replace` input: it must be
  // exported to the build process, not merely mentioned.
  assert.match(
    script,
    /export\s+KETCHER_MULTI_LANGUAGE_BUILD=true/,
    "the script must export KETCHER_MULTI_LANGUAGE_BUILD=true",
  );

  // The tarball location and name are the package.json contract.
  assert.ok(
    script.includes("vendor/ketcher-react"),
    "the tarball must be written under vendor/ketcher-react/",
  );
  assert.ok(
    script.includes(`ketcher-react-${KETCHER_VERSION}-multi.tgz`),
    `the tarball must be named ketcher-react-${KETCHER_VERSION}-multi.tgz`,
  );

  // Fail loudly: one guard for the tag and one for the flag (or the build
  // output). A silent fallback to the English-only bundle is the bug.
  const exits = script.match(/exit\s+1\b/g) ?? [];
  assert.ok(exits.length >= 2, "the script must fail loudly on a wrong tag or a wrong build");
  assert.match(script, /\btag\b/i, "the script must guard the checked-out tag");

  // Regeneration is pnpm-only: the tag's own scripts are npm-based, so the
  // script must bypass them with pnpm equivalents.
  assert.match(
    script,
    /pnpm\s+--filter\s+ketcher-react\s+run\s+i18n:generate/,
    "the script must generate locales with `pnpm --filter ketcher-react run i18n:generate`",
  );
  assert.match(
    script,
    /pnpm\s+--filter\s+ketcher-react\s+exec\b[^\n]*\brollup\b/,
    "the script must run rollup through `pnpm --filter ketcher-react exec`",
  );
  assert.match(
    script,
    /pnpm\s+--filter\s+ketcher-react\s+pack\b/,
    "the script must pack with `pnpm --filter ketcher-react pack`",
  );

  // No npm/npx invocation on a command line. Comments and echo/printf
  // prohibitions are messages, not commands.
  const commands = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => !/^(?:echo|printf)\b/.test(line));
  assert.deepEqual(
    commands.filter((line) => /\b(?:npm|npx)\b/.test(line)),
    [],
    "the build script must not invoke npm/npx anywhere on a command line",
  );
});

// ── installed ketcher-react: the multi-language build, not the npm default ──

const require = createRequire(import.meta.url);

function installedPackageDir(name) {
  // `ketcher-react` restricts its `exports` map, so `package.json` is not a
  // resolvable subpath. Read the real installed directory through node's
  // resolution of the package entry point and walk up to its manifest.
  const entry = require.resolve(name);
  let directory = path.dirname(entry);
  while (!existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `could not locate the installed ${name} package`);
    directory = parent;
  }
  return directory;
}

function textFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...textFiles(absolute));
      continue;
    }
    if (
      /\.(?:js|mjs|cjs|json|ts)$/.test(entry.name) &&
      statSync(absolute).size <= 16 * 1024 * 1024
    ) {
      files.push(readFileSync(absolute, "utf8"));
    }
  }
  return files;
}

test("the installed ketcher-react is the multi-language tarball build", () => {
  const packageDir = installedPackageDir("ketcher-react");
  const installed = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  // The install source is the committed vendor tarball, not the npm default or
  // a leftover build/ path. pnpm materialises `file:` deps in the virtual store
  // with a `file+vendor+ketcher-react...` directory name.
  assert.ok(
    packageDir.includes("file+vendor+ketcher-react"),
    `the installed ketcher-react must come from ${KETCHER_REACT_TARBALL}, found ${packageDir}`,
  );
  assert.equal(
    installed.version,
    KETCHER_VERSION,
    "the installed ketcher-react must be the 3.21.0 build",
  );

  // The published npm package is the English-only default: it tree-shakes the
  // non-English locales away. Scanning the whole built package (dist plus any
  // locale chunks) is bundle-layout agnostic.
  const distDir = path.join(packageDir, "dist");
  const bundle = textFiles(existsSync(distDir) ? distDir : packageDir).join("\n");

  assert.match(bundle, /code:\s*['"]en['"]/, "the installed build must ship the English locale");
  assert.ok(
    bundle.includes("zh-CN"),
    "the installed ketcher-react must ship the zh-CN locale (English-only npm build must fail)",
  );
  assert.match(
    bundle,
    /SUPPORTED_LANGUAGES/,
    "the installed build must expose the supported-language list",
  );
  assert.ok(
    bundle.includes("ketcher-language") && bundle.includes("LANGUAGE_STORAGE_KEY"),
    "the installed build must expose the ketcher-language storage key",
  );
});
