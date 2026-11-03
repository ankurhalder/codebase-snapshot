// PoC: claim H - matchRule "src/app/**" matches "src/apple", excludePatterns is substring-based
// Run: node audit/poc/correctness-rules.mjs
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rules-"));
const repo = path.join(root, "repo");
const mk = (rel, body = "export const x = 1;\n") => {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
};

mk("src/app/route.ts");
mk("src/apple/pie.ts");        // NOT under src/app/
mk("src/application/server.ts"); // NOT under src/app/
mk("src/app2/x.ts");           // NOT under src/app/
mk("test/a.ts");
mk("contest/entry.ts");        // contains "test" as a substring
mk("src/latest.test.ts");      // legitimately a test file
mk("attest/words.ts");

const base = { cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" };

// ---- H1: layer rule "src/app/**" ----
const m1 = await generateSnapshot(
  resolveConfig({ ...base, layers: [{ name: "app", match: "src/app/**" }] }, { cwd: repo })
);
console.log("=== H1: matchRule('src/app/**') uses slice(0,-3)='src/app' + startsWith ===");
for (const f of m1.files) console.log(`  ${f.relativePath.padEnd(28)} layer=${f.layer}`);
console.log(`  layers histogram: ${JSON.stringify(m1.layers)}`);

// ---- H2: excludePatterns substring matching ----
const m2 = await generateSnapshot(
  resolveConfig({ ...base, excludePatterns: ["test"] }, { cwd: repo })
);
console.log("\n=== H2: excludePatterns:['test'] uses file.includes('test') ===");
for (const f of m1.files) {
  const kept = m2.files.some((g) => g.relativePath === f.relativePath);
  console.log(`  ${f.relativePath.padEnd(28)} kept=${kept}`);
}

// ---- H3: a bare (no "/**") string rule is also a substring match ----
const m3 = await generateSnapshot(
  resolveConfig({ ...base, layers: [{ name: "apple-ish", match: "src/app" }] }, { cwd: repo })
);
console.log("\n=== H3: string rule 'src/app' (includes) ===");
for (const f of m3.files) console.log(`  ${f.relativePath.padEnd(28)} layer=${f.layer}`);

fs.rmSync(root, { recursive: true, force: true });
