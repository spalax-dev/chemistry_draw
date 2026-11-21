#!/usr/bin/env node
/**
 * Docblock debt gate.
 *
 * Documentation is the source of truth for this codebase, so every exported
 * TypeScript symbol and every public Rust item must carry a docblock. The
 * legacy code predates that rule, so the current violations are recorded in
 * `docs/harness/docblock-baseline.txt` and explained in
 * `docs/harness/docstring-debt.md`.
 *
 * The gate fails only when an undocumented symbol (or source file without a
 * module docblock) is **not** in the baseline: that is new or changed debt.
 * Documenting a baselined symbol always passes; the gate reports how many
 * baseline entries were burned down so the file can shrink.
 *
 * Usage:
 *   node scripts/check-docblocks.mjs                  # gate (exit 1 on new debt)
 *   node scripts/check-docblocks.mjs --write-baseline # rewrite the baseline
 *
 * The scan is deterministic and dependency-free apart from the TypeScript
 * parser that already ships with the project; it never reports success on an
 * empty scan.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "docs/harness/docblock-baseline.txt");

const TS_ROOTS = ["src"];
const RS_ROOTS = ["src-tauri/src", "src-tauri/sidecar/src"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "lib", "generated", "tests"]);
const TS_FILE_SKIP = [/\.(test|spec)\.tsx?$/, /\.d\.ts$/];

const BASELINE_HEADER = `# Docblock baseline — legacy debt, do not grow.
# Owner: Chemistry Draw maintainers (see docs/harness/docstring-debt.md).
# Regenerate after documenting symbols: node scripts/check-docblocks.mjs --write-baseline
# Format: one undocumented exported symbol or undocumented file per line.
`;

/** Recursively list files under `dir`, honouring the shared skip list. */
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else files.push(abs);
  }
  return files;
}

/** True when a JS/TS node carries a `/** ... *\/` docblock. */
function hasJsDocBlock(node, sourceFile) {
  const holder = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  if (holder.jsDoc?.length > 0) return true;

  const ranges = ts.getLeadingCommentRanges(sourceFile.text, holder.getFullStart());
  if (!ranges?.length) return false;
  const last = ranges[ranges.length - 1];
  const text = sourceFile.text.slice(last.pos, last.end);
  const gap = sourceFile.text.slice(last.end, holder.getStart());
  return text.startsWith("/**") && /^\s*$/.test(gap);
}

/** Name of a top-level declaration, used to resolve `export default <name>`. */
function declarationName(statement) {
  return statement.name && ts.isIdentifier(statement.name) ? statement.name.text : undefined;
}

/** Collect the exported declarations of one TypeScript module. */
function scanTsModule(file) {
  const text = readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const entries = [];

  if (
    !text
      .replace(/^\uFEFF/, "")
      .trimStart()
      .startsWith("/**")
  ) {
    entries.push({
      key: `ts-file:${rel}`,
      label: `${rel} (module docblock)`,
    });
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) continue;

    if (ts.isExportAssignment(statement)) {
      const target = ts.isIdentifier(statement.expression)
        ? sourceFile.statements.find(
            (candidate) => declarationName(candidate) === statement.expression.text,
          )
        : undefined;
      const name = ts.isIdentifier(statement.expression) ? statement.expression.text : "default";
      entries.push({
        key: `ts:${rel}:default ${name}`,
        label: `${rel}: default export ${name}`,
        undocumented: !hasJsDocBlock(target ?? statement, sourceFile),
      });
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    const push = (kindName, name) => {
      entries.push({
        key: `ts:${rel}:${kindName} ${name}`,
        label: `${rel}: ${kindName} ${name}`,
        undocumented: !hasJsDocBlock(statement, sourceFile),
      });
    };

    if (ts.isFunctionDeclaration(statement)) push("function", statement.name?.text ?? "default");
    else if (ts.isClassDeclaration(statement)) push("class", statement.name?.text ?? "default");
    else if (ts.isInterfaceDeclaration(statement)) push("interface", statement.name.text);
    else if (ts.isTypeAliasDeclaration(statement)) push("type", statement.name.text);
    else if (ts.isEnumDeclaration(statement)) push("enum", statement.name.text);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) push("const", declaration.name.text);
      }
    }
  }

  return entries.filter((entry) => entry.undocumented !== false);
}

const RUST_ITEM_PATTERNS = [
  {
    kind: "fn",
    re: /^\s*pub\s+(?:(?:const|async|unsafe)\s+)*(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
  },
  { kind: "struct", re: /^\s*pub\s+struct\s+([A-Za-z_]\w*)/ },
  { kind: "enum", re: /^\s*pub\s+enum\s+([A-Za-z_]\w*)/ },
  { kind: "trait", re: /^\s*pub\s+trait\s+([A-Za-z_]\w*)/ },
  { kind: "union", re: /^\s*pub\s+union\s+([A-Za-z_]\w*)/ },
  { kind: "type", re: /^\s*pub\s+type\s+([A-Za-z_]\w*)/ },
  { kind: "const", re: /^\s*pub\s+const\s+([A-Za-z_]\w*)\s*:/ },
  { kind: "static", re: /^\s*pub\s+static\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:/ },
];

/** True when a Rust item is preceded by a `///` docblock (attributes allowed). */
function hasRustDocBlock(lines, index) {
  for (let cursor = index - 1; cursor >= 0 && index - cursor <= 12; cursor -= 1) {
    const line = lines[cursor].trim();
    if (line.startsWith("///")) return true;
    if (line.startsWith("#[")) continue;
    if (line === "" || line.startsWith("//")) continue;
    return false;
  }
  return false;
}

/** Collect undocumented public items and files of one Rust crate tree. */
function scanRustModule(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const entries = [];

  const firstContent = lines.find((line) => line.trim() !== "");
  if (!firstContent?.trimStart().startsWith("//!")) {
    entries.push({ key: `rust-file:${rel}`, label: `${rel} (module docblock)` });
  }

  lines.forEach((line, index) => {
    const match = RUST_ITEM_PATTERNS.map((pattern) => ({
      ...pattern,
      match: pattern.re.exec(line),
    })).find((pattern) => pattern.match);
    // `pub const fn` is matched by the fn pattern first, so it cannot be read
    // as a `pub const` item named `fn`.
    if (!match || hasRustDocBlock(lines, index)) return;
    const name = match.match[1];
    entries.push({
      key: `rust:${rel}:${match.kind} ${name}`,
      label: `${rel}: pub ${match.kind} ${name}`,
    });
  });

  return entries;
}

/** Build the complete audit: undocumented entries plus a scanned-symbol count. */
function scan() {
  const undocumented = [];
  let scanned = 0;

  for (const root of TS_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (TS_FILE_SKIP.some((pattern) => pattern.test(file))) continue;
      if (!/\.tsx?$/.test(file)) continue;
      const entries = scanTsModule(file);
      undocumented.push(...entries);
      scanned += 1;
    }
  }

  for (const root of RS_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (!file.endsWith(".rs")) continue;
      if (file.split(path.sep).includes("tests")) continue;
      const entries = scanRustModule(file);
      undocumented.push(...entries);
      scanned += 1;
    }
  }

  return { undocumented, scanned };
}

/** Read the baseline, ignoring comments and blank lines. */
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return readFileSync(BASELINE_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function writeBaseline(keys) {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${BASELINE_HEADER}${[...keys].sort().join("\n")}\n`, "utf8");
}

function main() {
  const wantsBaseline = process.argv.includes("--write-baseline");
  const { undocumented, scanned } = scan();
  const current = new Map(undocumented.map((entry) => [entry.key, entry.label]));

  if (wantsBaseline) {
    writeBaseline(current.keys());
    console.log(
      `check-docblocks: wrote ${current.size} undocumented entries (${scanned} files scanned) ` +
        `to ${path.relative(ROOT, BASELINE_PATH)}`,
    );
    return 0;
  }

  if (scanned === 0) {
    console.error("check-docblocks: scanned 0 files — refusing to report a green gate.");
    return 2;
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error(
      `check-docblocks: missing ${path.relative(ROOT, BASELINE_PATH)}; ` +
        "create it with --write-baseline after review.",
    );
    return 2;
  }

  const baselineSet = new Set(baseline);
  const added = [...current.keys()].filter((key) => !baselineSet.has(key)).sort();
  const burned = [...baselineSet].filter((key) => !current.has(key)).sort();

  console.log(
    `check-docblocks: ${scanned} files scanned, ${current.size} undocumented, ` +
      `${baselineSet.size} in baseline.`,
  );

  if (burned.length > 0) {
    console.log(
      `check-docblocks: ${burned.length} baseline entr${burned.length === 1 ? "y is" : "ies are"} ` +
        "now documented; run --write-baseline to shrink the baseline.",
    );
  }

  if (added.length === 0) {
    console.log("check-docblocks: OK — no new undocumented exports or files.");
    return 0;
  }

  console.error(`check-docblocks: ${added.length} new undocumented symbol(s) or file(s):`);
  for (const key of added) console.error(`  + ${current.get(key)}`);
  console.error(
    "Document them (docs are the source of truth; see docs/harness/docstring-debt.md). " +
      "Only genuine legacy debt may extend the baseline, and that needs a review.",
  );
  return 1;
}

process.exit(main());
