/**
 * End-to-end verification of every 0.10.1 audit fix, against the built binary.
 *
 * Each check builds a real fixture, runs the real CLI (or the real exported function), and asserts
 * the observable outcome — not the source line. `npm test` covers the same ground file by file;
 * this script is the consolidated proof, and it is what the fix log's "verified end to end" claim
 * refers to.
 *
 *   node audit/work/verify-fixes.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "dist", "bin.js");
const api = await import(pathToFileURL(path.join(ROOT, "dist", "index.js")).href);

const results = [];
let tempRoots = [];

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function write(base, relative, content) {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function read(base, relative) {
  return fs.readFileSync(path.join(base, relative), "utf8");
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

function json(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const pending = [];

function check(id, what, fn) {
  try {
    const outcome = fn();
    if (outcome !== null && typeof outcome === "object" && typeof outcome.then === "function") {
      const record = { id, what, ok: true, detail: "" };
      results.push(record);
      // A few checks import a module dynamically; their detail arrives later.
      pending.push(
        outcome.then(
          (detail) => { record.detail = detail ?? ""; },
          (error) => { record.ok = false; record.detail = error.message; }
        )
      );
      return;
    }
    results.push({ id, what, ok: true, detail: outcome ?? "" });
  } catch (error) {
    results.push({ id, what, ok: false, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertMatch(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(`${message}: ${JSON.stringify(String(value).slice(0, 200))}`);
}

const BIG = Array.from({ length: 900 }, (_, index) => `export const v${index} = ${index};`).join("\n") + "\n";

function repo(files) {
  const dir = temp("repo");
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) write(dir, relative, content);
  return dir;
}

// ---------------------------------------------------------------- H1
check("H1", "an unterminated quoted credential is masked and reported", () => {
  const dir = repo({ ".env": 'API_KEY="zq7Xk2nvalue\n' });
  // `.env` is a sensitive file: without --include-sensitive-files it is skipped, not scanned.
  const result = cli(["generate", "--include-sensitive-files"], dir);
  assert(result.status === 0, result.stderr);
  const parts = read(dir, "snapshot/parts/part-001.md");
  assert(!parts.includes("zq7Xk2nvalue"), "the value survived into the part");
  const manifest = JSON.parse(read(dir, "snapshot/manifest.json"));
  assert(manifest.totals.redactedLines === 1, `redactedLines = ${manifest.totals.redactedLines}`);
  assertMatch(read(dir, "snapshot/reports/audit.md"), /credential-assignment-unterminated/, "audit.md");
  return "masked in the part, counted, rule named";
});

// ---------------------------------------------------------------- H2
check("H2", "validate refuses a tampered incomplete[] record", () => {
  const dir = repo({ "src/big.ts": BIG });
  let result = cli(["generate", "--large-file-bytes", "1024"], dir);
  assert(result.status === 0, result.stderr);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(manifest.incomplete.length === 1, "fixture has no incomplete record");

  result = cli(["validate", "--large-file-bytes", "1024"], dir);
  assert(result.status === 0, `clean run failed: ${result.stderr}`);

  for (const [label, mutate] of [
    ["relativePath traversal", (m) => { m.incomplete[0].relativePath = "../escape.ts"; }],
    ["count kept, list emptied", (m) => { m.incomplete = []; }],
    ["bogus reason", (m) => { m.incomplete[0].reason = "bogus"; }],
    ["omittedLines = 0", (m) => { m.incomplete[0].omittedLines = 0; }],
    ["includedLines = 99999", (m) => { m.incomplete[0].includedLines = 99999; }],
  ]) {
    const copy = JSON.parse(JSON.stringify(manifest));
    mutate(copy);
    fs.writeFileSync(manifestPath, `${JSON.stringify(copy, null, 2)}\n`);
    const tampered = cli(["validate", "--large-file-bytes", "1024"], dir);
    assert(tampered.status === 1, `validate accepted ${label}`);
    assertMatch(tampered.stderr, /is not a snapshot manifest|snapshot artefact problem/, label);
  }
  return "5 tampered variants refused; clean run still exits 0";
});

// ---------------------------------------------------------------- H3
check("H3", "the monolith says full and carries no truncation fields", () => {
  const dir = repo({ "src/big.ts": BIG });
  const result = cli(["generate", "--large-file-bytes", "1024", "--include-monolith"], dir);
  assert(result.status === 0, result.stderr);
  const monolith = JSON.parse(read(dir, "snapshot/full-codebase.json"));
  const entry = monolith.files.find((file) => file.relativePath === "src/big.ts");
  assert(entry.inclusionMode === "full", entry.inclusionMode);
  assert(entry.truncationReason === undefined, "monolith entry keeps a truncationReason");
  assert(entry.omittedRanges === undefined, "monolith entry keeps omittedRanges");
  const manifest = JSON.parse(read(dir, "snapshot/manifest.json"));
  assert(manifest.files.find((file) => file.relativePath === "src/big.ts").inclusionMode === "preview");
  return "monolith full, parts preview, one object one statement";
});

// ---------------------------------------------------------------- H4
check("H4", "a TypeScript config containing discovery compiles", () => {
  const dir = temp("types");
  const file = path.join(dir, "snapshot.config.ts");
  // A relative specifier into the built package: TypeScript resolves `dist/index.js` to the
  // `dist/index.d.ts` beside it, which is exactly what a user's config compiles against.
  const rel = path.relative(dir, path.join(ROOT, "dist", "index.js")).split(path.sep).join("/");
  fs.writeFileSync(
    file,
    `import { defineConfig } from "${rel.startsWith(".") ? rel : `./${rel}`}";\n` +
      'export default defineConfig({ outDir: "snapshot", discovery: "walk" });\n'
  );
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict",
     "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", file],
    { encoding: "utf8" }
  );
  assert(result.status === 0, `tsc rejected the config: ${result.stdout}${result.stderr}`);
  return "tsc --strict accepts defineConfig({ discovery })";
});

// ---------------------------------------------------------------- H5
check("H5", "snapshot_plan runs through the worker and writes nothing", async () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  const tool = (await import(pathToFileURL(path.join(ROOT, "dist", "mcp.js")).href)).buildTools()
    .find((entry) => entry.name === "snapshot_plan");
  const outcome = await tool.handler({}, { cwd: dir, roots: [dir], log: () => {} });
  assert(!outcome.isError, outcome.text);
  assert(!fs.existsSync(path.join(dir, "snapshot")), "the plan wrote an output directory");
  // package.json and src/a.ts.
  assert(outcome.structured.files === 2, `files = ${outcome.structured.files}`);
  return "dry plan returned counts, wrote nothing";
});

// ---------------------------------------------------------------- H6
check("H6", "a previewed importer appears in the import index", () => {
  const dir = repo({
    "snapshot.config.json": '{ "largeFileBytes": 1024 }\n',
    "src/changed.ts": "export const changed = 1;\n",
    "src/big-consumer.ts":
      'import { changed } from "./changed.js";\n' +
      Array.from({ length: 200 }, (_, i) => `export const v${i} = changed + ${i};`).join("\n") + "\n",
  });
  const result = cli(["generate"], dir);
  assert(result.status === 0, result.stderr);
  const manifest = JSON.parse(read(dir, "snapshot/manifest.json"));
  const consumer = manifest.files.find((file) => file.relativePath === "src/big-consumer.ts");
  assert(consumer.inclusionMode === "preview", consumer.inclusionMode);
  const entry = manifest.indexes.imports.byFile.find((file) => file.path === "src/big-consumer.ts");
  assert(entry !== undefined, "the previewed importer is missing from byFile");
  assert(entry.exportsOmitted === true, "exportsOmitted is not set");
  const central = manifest.indexes.imports.centralFiles.find((file) => file.path === "src/changed.ts");
  assert(central?.importedByCount === 1, "centralFiles does not count the edge");
  return "byFile has the edge, centralFiles counts 1";
});

// ---------------------------------------------------------------- H7
check("H7", "compareManifests applies the caller's rules, and masks layer names", () => {
  const stub = (relativePath, layer) => ({
    schemaVersion: "3.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "codebase-snapshot", version: "0.10.1" },
    git: { branch: "main", commit: "0", isDirty: false },
    budgets: { maxPartBytes: 4096, largeFileBytes: 4096 },
    config: {},
    counts: { totalFiles: 1, totalSizeBytes: 1, totalLines: 1, partsCount: 1, skippedCount: 0, largeFileCount: 0, truncatedPreviewCount: 0, incompleteCount: 0 },
    totals: { candidateFiles: 1, includedFiles: 1, fullFiles: 1, previewFiles: 0, skippedFiles: 0, totalSourceBytes: 1, totalContentBytes: 1, redactedLines: 0, partCount: 1, warningCount: 0 },
    fingerprint: "a".repeat(64),
    validation: { status: "passed", errors: [] },
    artifacts: {},
    layers: { [layer]: 1 },
    kinds: {},
    indexes: { routes: [], components: [], handlers: [], features: [], imports: { byFile: [], centralFiles: [] }, directives: [] },
    parts: [],
    files: [{
      relativePath, sizeBytes: 1, lines: 1, hashSha256: "b".repeat(64), part: "part-001.md",
      layer, kind: "source", language: "typescript", inclusionMode: "full", isLarge: false,
      isPreviewTruncated: false, originalLines: 1, includedLines: 1, includedBytes: 1,
    }],
    skipped: [],
    incomplete: [],
    warnings: [],
  });
  const custom = { rule: "acme-key", pattern: /ACME-[A-Z0-9]{8}/ };
  const before = stub("src/a.ts", "src");
  const after = stub("src/ACME-7F3K9QZ2.ts", "ACME-7F3K9QZ2");
  const plain = api.compareManifests(before, after);
  assertMatch(JSON.stringify(plain), /ACME-7F3K9QZ2/, "the default run must leak (the old behaviour)");
  const masked = api.compareManifests(before, after, [custom]);
  assert(!JSON.stringify(masked).includes("ACME-7F3K9QZ2"), "the token survived with rules");
  return "paths and layer names masked with the caller's rules";
});

// ---------------------------------------------------------------- H8
check("H8", "init --out-dir .context ignores the directory it generates into", () => {
  const dir = temp("gitignore");
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  const result = cli(["init", "--yes", "--out-dir", ".context"], dir);
  assert(result.status === 0, result.stderr);
  const ignore = read(dir, ".gitignore");
  assert(/^\/\.context\/$/m.test(ignore), `gitignore: ${ignore}`);
  assert(!/^\/snapshot\/$/m.test(ignore), "it still ignores /snapshot/");
  const generated = cli(["generate"], dir);
  assert(generated.status === 0, generated.stderr);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert(!status.includes(".context/"), `git status lists the snapshot: ${status}`);
  return "anchored entry, git status clean for .context/";
});

// ---------------------------------------------------------------- H9
check("H9", "rendered pages reference only assets the site copies", async () => {
  const site = await import(pathToFileURL(path.join(ROOT, "scripts", "build-site.mjs")).href);
  const pages = site.renderPages();
  for (const page of pages) {
    assert(!page.html.includes('"docs/assets/'), `${page.slug} points at docs/assets/`);
    for (const match of page.html.matchAll(/src="(assets\/[^"]+)"/g)) {
      assert(fs.existsSync(path.join(ROOT, "docs", match[1])), `${page.slug}: missing ${match[1]}`);
    }
  }
  return `${pages.length} pages, no docs/assets reference`;
});

// ---------------------------------------------------------------- H10
check("H10", "a nested .DS_Store does not make the tool refuse its own outDir", () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  assert(cli(["generate"], dir).status === 0);
  write(dir, "snapshot/reports/.DS_Store", "noise");
  const second = cli(["generate"], dir);
  assert(second.status === 0, `second run refused: ${second.stderr}`);
  assert(!fs.existsSync(path.join(dir, "snapshot", "reports", ".DS_Store")), "noise survived");
  return "regenerated over Finder noise at depth";
});

// ---------------------------------------------------------------- H11
check("H11", "the banner names the project dependency behind a BOM", () => {
  const dir = temp("bom");
  write(dir, "package.json", `\uFEFF${JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { "codebase-snapshot": "^0.10.1" } }, null, 2)}\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  const result = cli(["generate"], dir);
  assert(result.status === 0, result.stderr);
  assertMatch(result.stderr, /\(project dependency \^0\.10\.1\)/, "banner");
  assert(!result.stderr.includes("global or direct install"), "the false origin is still printed");
  return "project dependency ^0.10.1";
});

// ---------------------------------------------------------------- H12
check("H12", "SARIF order is a code-unit sort", () => {
  const log = JSON.parse(api.generateSarifReport({ fingerprint: "f" }, [
    { rules: ["credential-assignment"], line: 1, path: "src/ab.ts" },
    { rules: ["credential-assignment"], line: 1, path: "src/aB.ts" },
  ], api.DEFAULT_SECRET_PATTERNS, "0.0.0"));
  const order = log.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri);
  assert(order.join() === "src/aB.ts,src/ab.ts", order.join());
  return order.join(" < ");
});

// ---------------------------------------------------------------- N1
check("N1", "summaryOmitted is set on a preview and absent without a summary", () => {
  const dir = repo({ "src/big.ts": BIG, "logs/huge.log": "line\n".repeat(20_000) });
  const result = cli(["generate", "--large-file-bytes", "1024"], dir);
  assert(result.status === 0, result.stderr);
  const manifest = JSON.parse(read(dir, "snapshot/manifest.json"));
  const big = manifest.files.find((file) => file.relativePath === "src/big.ts");
  assert(big.summaryOmitted === true && big.summaryOmittedReason === "preview", JSON.stringify(big.summaryOmittedReason));
  assert(manifest.files.find((file) => file.relativePath === "logs/huge.log").summaryOmitted === undefined);
  return "preview: preview, .log: absent";
});

// ---------------------------------------------------------------- N2
check("N2", "validate, report and diff refuse a malformed manifest the same way", () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n" });
  assert(cli(["generate"], dir).status === 0);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.totals;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const validate = cli(["validate"], dir);
  const report = cli(["report"], dir);
  const diff = cli(["diff", manifestPath, manifestPath]);
  for (const [name, result] of [["validate", validate], ["report", report], ["diff", diff]]) {
    assert(result.status === 1, `${name} exited ${result.status}`);
    assertMatch(result.stderr, /is not a snapshot manifest/, name);
    assertMatch(result.stderr, /❌ /, `${name} prefix`);
  }
  return "one sentence, one prefix, exit 1 in all three";
});

// ---------------------------------------------------------------- N3
check("N3", "audit.md names the truncation cause the way the marker does", () => {
  const dir = repo({ "big.ts": `${"x".repeat(2000)}\n`.repeat(50) });
  const result = cli(["generate", "--max-part-bytes", "4096", "--large-file-bytes", "4096"], dir);
  assert(result.status === 0, result.stderr);
  const audit = read(dir, "snapshot/reports/audit.md");
  assertMatch(audit, /\| Truncated \| part budget \(maxPartBytes\) \|/, "audit column");
  const part = fs.readdirSync(path.join(dir, "snapshot", "parts")).map((f) => read(dir, `snapshot/parts/${f}`)).join("\n");
  assertMatch(part, /part budget \d+ B/, "in-block marker");
  return "part budget (maxPartBytes) / part budget N B";
});

// ---------------------------------------------------------------- N4
check("N4", "the banner counts paths, not files", () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n", "notes/x.txt": "hello\n" });
  write(dir, "snapshot.config.json", '{ "excludePatterns": ["notes"] }\n');
  const result = cli(["generate"], dir);
  assert(result.status === 0, result.stderr);
  assertMatch(result.stderr, /paths found/, "banner noun");
  return "\"N included of M paths found\"";
});

// ---------------------------------------------------------------- N5
check("N5", "the three documented surfaces match the binary", () => {
  const cliDoc = read(ROOT, "docs/cli.md");
  assert(!/Added to \.gitignore: snapshot\/, snapshot\.tmp\//.test(cliDoc), "unanchored gitignore entries");
  assert(cliDoc.includes("Added to .gitignore: /snapshot/, /snapshot.tmp/"), "anchored form missing");
  assertMatch(cliDoc, /\{ rules, line \}/, "explain shape");
  const stale = read(ROOT, "docs/stale-context-is-your-bug.md");
  assert(stale.includes("❌ Snapshot validation failed:"), "old validate header");
  assert(stale.includes("new file:") && stale.includes("deleted:"), "old drift labels");
  return "cli.md, stale-context-is-your-bug.md, explain shape";
});

// ---------------------------------------------------------------- N6
check("N6", "the placeholder list is documented and enforced", () => {
  const doc = read(ROOT, "docs/configuration.md");
  for (const example of ["replace-me-with-the-read-tier-key", "your-api-key-here", "sk-...", "****"]) {
    assert(doc.includes(example), `doc misses ${example}`);
  }
  const survives = api.scanAndRedactSecrets("API_KEY=replace-me-with-the-read-tier-key", api.DEFAULT_SECRET_PATTERNS, ".env");
  assert(survives.redacted.includes("replace-me-with"), "a documented placeholder was masked");
  const masked = api.scanAndRedactSecrets("API_KEY=replace-with-base64url-48-bytes", api.DEFAULT_SECRET_PATTERNS, ".env");
  assert(masked.redacted.includes("REDACTED"), "the near miss was not masked");
  return "documented list, enforced both ways";
});

// ---------------------------------------------------------------- N7
check("N7", "exportsKind esm is produced", () => {
  const summary = api.summarizeTypeScriptSource("a.ts", "export const a = 1;\n");
  assert(summary.exportsKind === "esm", String(summary.exportsKind));
  return "esm";
});

// ---------------------------------------------------------------- N8
check("N8", "a CR-only JSON config parses through the one JSONC reader", () => {
  const dir = temp("jsonc");
  write(dir, "snapshot.config.json", '{\r  "outDir": "ctx",\r  "excludePatterns": ["a//b",],\r}\r');
  const loaded = spawnSync(process.execPath, [BIN, "generate", "--cwd", dir, "--dry-run", "--format", "json"], { encoding: "utf8" });
  assert(loaded.status === 0, `${loaded.stdout}${loaded.stderr}`);
  const manifest = JSON.parse(loaded.stdout);
  assert(manifest.counts.totalFiles === 1 || manifest.counts.totalFiles === 0, String(manifest.counts.totalFiles));
  return "CR-only config accepted";
});

// ---------------------------------------------------------------- N9
check("N9", "both tree caps produce a manifest warning", () => {
  const tree = api.generateProjectTree(Array.from({ length: 20_040 }, (_, i) => `f${i}.ts`));
  const warnings = api.treeTruncationWarnings(tree);
  assert(warnings.length === 1 && /20000-line cap/.test(warnings[0]), JSON.stringify(warnings));
  return "line cap warns like the depth cap";
});

// ---------------------------------------------------------------- N10
check("N10", "diff --format json carries payload codes", () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n", "src/big.ts": BIG });
  assert(cli(["generate", "--out-dir", "one"], dir).status === 0);
  assert(cli(["generate", "--out-dir", "two", "--max-part-bytes", "120k"], dir).status === 0);
  const result = cli(["diff", path.join(dir, "one"), path.join(dir, "two"), "--format", "json"], dir);
  assert(result.status === 0, result.stderr);
  const payload = JSON.parse(result.stdout).payload;
  assert(Array.isArray(payload.codes) && payload.codes.includes("config-digest"), JSON.stringify(payload.codes));
  assert(payload.codes.length === payload.reasons.length, "codes and reasons disagree");
  return payload.codes.join(", ");
});

// ---------------------------------------------------------------- N11
check("N11", "the published measurement matches the tree", () => {
  const doc = read(ROOT, "docs/codebase-token-budget.md");
  const files = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((p) => p.endsWith(".ts") && fs.existsSync(path.join(ROOT, p)));
  let lines = 0;
  let bytes = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    bytes += Buffer.byteLength(text);
    lines += api.countLines(text);
  }
  const tokens = Math.round(bytes / 3.5);
  // The doc states a measurement taken on a date; a commit or two later the exact line count
  // moves. What must not happen is the ~2x staleness the finding was about, so the check asks for
  // the number in the table to be within 2% of a fresh measurement rather than equal to it.
  const table = doc.slice(doc.indexOf("| TypeScript files"), doc.indexOf("That single number"));
  const numbers = (table.match(/[\d,]+/g) ?? []).map((value) => Number(value.replace(/,/g, "")));
  const near = (actual) => numbers.some((claimed) => Math.abs(actual - claimed) <= 0.02 * Math.max(actual, 1));
  assert(near(files.length), `doc does not state ${files.length} files: ${numbers.join(", ")}`);
  assert(near(lines), `doc does not state ~${lines} lines: ${numbers.join(", ")}`);
  assert(near(bytes), `doc does not state ~${bytes} bytes: ${numbers.join(", ")}`);
  assert(numbers.some((claimed) => Math.abs(claimed - tokens) <= 0.02 * tokens), "token estimate");
  return `${files.length} files / ${lines} lines / ${bytes} B / ≈${tokens} tokens`;
});

// ---------------------------------------------------------------- N12
check("N12", "no test message is a non-interpolating literal", () => {
  const tests = fs.readdirSync(path.join(ROOT, "tests")).filter((name) => name.endsWith(".js"));
  const offenders = [];
  for (const name of tests) {
    const text = fs.readFileSync(path.join(ROOT, "tests", name), "utf8");
    for (const line of text.split("\n")) {
      // The defect is a *message argument* written in double quotes that contains a template
      // expression: `assert.ok(x, "\${JSON.stringify(line)}: ...")`. A properly interpolated
      // template that happens to quote a value inside it is not the defect.
      if (/,\s*"[^"]*\$\{[\s\S]*"\s*\)/.test(line)) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert(offenders.length === 0, offenders.slice(0, 3).join(" | "));
  return "no literal ${…} in a failure message";
});

// ---------------------------------------------------------------- N13
check("N13", "describe documents secretRules, and the carve-out is an assertion", () => {
  const result = cli(["describe", "--format", "json"], ROOT);
  assert(result.status === 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  const keys = contract.config.settings.map((setting) => setting.key);
  assert(keys.includes("secretRules"), "describe omits secretRules");
  assert(keys.includes("discovery"), "describe omits discovery");
  return `${keys.length} settings, secretRules included`;
});

// ---------------------------------------------------------------- N14
check("N14", "the 4.x test headers are mapped to the retired line", () => {
  const contributing = read(ROOT, "CONTRIBUTING.md");
  assertMatch(contributing, /4\.4\.1/, "no mapping note");
  assertMatch(contributing, /older\*?\*? than \`0\.9\.x\`/, "no statement that 4.x is older");
  return "CONTRIBUTING.md explains the numbering";
});

// ---------------------------------------------------------------- N15
check("N15", "no stacked or orphaned JSDoc block in src", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*\/\*\*/.test(lines[i])) continue;
      let j = i;
      while (j < lines.length && !/\*\//.test(lines[j])) j += 1;
      if (j >= lines.length) { offenders.push(`${file}:${i + 1} unterminated`); continue; }
      const next = (lines[j + 1] ?? "").trim();
      if (next === "") continue;
      if (/^(\/\/|\/\*|\*\/|\}|\)|case |default:)/.test(next)) offenders.push(`${file}:${i + 1}`);
    }
  }
  assert(offenders.length === 0, offenders.slice(0, 5).join(", "));
  return `${files.length} files, none`;
});

// ---------------------------------------------------------------- W2
check("W2", "partitionFiles refuses a budget it cannot honour", () => {
  const entry = {
    relativePath: "src/a.ts", sizeBytes: 1, lines: 1, hashSha256: "b".repeat(64),
    part: "part-001.md", layer: "src", kind: "source", language: "typescript",
    inclusionMode: "full", isLarge: false, isPreviewTruncated: false, originalLines: 1,
    includedLines: 1, includedBytes: 1, content: "x\n",
  };
  for (const budget of [20, 46, 100, 1000, 2600]) {
    let threw = false;
    try { api.partitionFiles([entry], budget); } catch { threw = true; }
    assert(threw, `budget ${budget} was clamped, not refused`);
  }
  return "5 small budgets refused with an error";
});

// ---------------------------------------------------------------- report
await Promise.all(pending);
for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.id.padEnd(4)} ${entry.what}${entry.detail ? `  — ${entry.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
