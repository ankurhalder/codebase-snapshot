// api-surface.mjs - public-API behaviour probes for @ankurhalder/codebase-snapshot
// Run: node audit/poc/api-surface.mjs   (from repo root, after `npm run build`)
import * as fs from "node:fs";
import * as path from "node:path";

const dist = path.resolve("dist/index.js");
const api = await import(`file://${dist.replace(/\\/g, "/")}`);
const { generateSnapshot, validateSnapshot, resolveConfig, defineConfig } = api;

const root = process.cwd();
const work = path.join(root, "audit", "poc", "api-surface-work");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "surface-fixture" }));
fs.writeFileSync(path.join(work, "src", "a.ts"), "export const a = 1;\n");
fs.writeFileSync(
  path.join(work, "src", "leak.ts"),
  'const awsKey = "AKIAIOSFODNN7EXAMPLE";\nexport const b = 2;\n'
);

const line = (s) => console.log(s);

// ---------------------------------------------------------------- A: async but blocking
line("=== A. generateSnapshot is declared async but does all work synchronously ===");
{
  const cfg = { cwd: work, outDir: "outA", maxPartBytes: 400_000 };
  const t0 = performance.now();
  const promise = generateSnapshot(cfg);           // no await yet
  const syncMs = performance.now() - t0;
  const alreadyOnDisk = fs.existsSync(path.join(work, "outA", "manifest.json"));
  line(`  returned ${promise.constructor.name} after ${syncMs.toFixed(1)}ms; manifest.json already on disk before await? ${alreadyOnDisk}`);
  const m = await promise;
  line(`  manifest.schemaVersion=${m.schemaVersion}; files=${m.files.length}`);
}

// ---------------------------------------------------------------- B: heuristic misfires
line("");
line("=== B. `\"secretRules\" in configInput` heuristic ===");
{
  // B1: object that has secretRules but is NOT a full ResolvedSnapshotConfig
  try {
    await generateSnapshot({ cwd: work, outDir: "outB1", secretRules: [] });
    line("  B1 (partial object that happens to carry secretRules): no error");
  } catch (e) {
    line(`  B1 THREW ${e.constructor.name}: ${String(e.message).split("\n")[0]}`);
  }

  // B2: a genuinely resolved config whose secretRules key was dropped (spread/RPC/JSON clone)
  const resolved = resolveConfig({ cwd: work, outDir: "outB2", secrets: { disableDefaultPatterns: true } });
  line(`  resolved.secretRules.length=${resolved.secretRules.length} (default patterns disabled)`);
  const { secretRules, ...resolvedWithoutKey } = resolved;
  const m1 = await generateSnapshot(resolved);            // heuristic: resolved
  const m2 = await generateSnapshot(resolvedWithoutKey);  // heuristic: NOT resolved -> re-resolved
  line(`  warnings with key   : ${m1.warnings.length}`);
  line(`  warnings without key: ${m2.warnings.length}  <-- default secret rules silently re-enabled`);
  line(`  => same logical config object, different redaction behaviour, no error either way`);
}

// ---------------------------------------------------------------- C: no runtime validation
line("");
line("=== C. public API has zero argument validation ===");
{
  try {
    validateSnapshot({ cwd: work });
    line("  validateSnapshot({cwd}) accepted");
  } catch (e) {
    line(`  validateSnapshot({cwd}) THREW ${e.constructor.name}: ${e.code || ""} ${String(e.message).split("\n")[0]}`);
  }
  try {
    const m = await generateSnapshot({ cwd: work, outDir: "outC", maxPartBytes: NaN });
    line(`  generateSnapshot(NaN budget) accepted: parts=${m.parts.length} budgets.maxPartBytes=${String(m.budgets.maxPartBytes)}`);
  } catch (e) {
    line(`  generateSnapshot(NaN) THREW ${String(e.message).split("\n")[0]}`);
  }
  // defineConfig does no validation at all
  const bad = defineConfig({ maxPartBytes: -5 });
  line(`  defineConfig({maxPartBytes:-5}) returned ${JSON.stringify(bad)} (no validation)`);
}

// ---------------------------------------------------------------- D: default argument
line("");
line("=== D. generateSnapshot() with no argument targets process.cwd() ===");
{
  const prev = process.cwd();
  process.chdir(work);
  const m = await generateSnapshot();
  process.chdir(prev);
  line(`  generated into ${path.join(work, "snapshot", "manifest.json")} exists=${fs.existsSync(path.join(work, "snapshot", "manifest.json"))} files=${m.files.length}`);
}
