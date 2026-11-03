import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  generateSnapshot,
  isResolvedConfig,
  isSensitivePath,
  resolveConfig,
  validateSnapshot,
} from "../../dist/index.js";

const ok = (label, pass, extra = "") =>
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);

const mk = (prefix, files = {}, git = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    try {
      execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], { cwd: dir, stdio: "ignore" });
    } catch {}
  }
  return dir;
};
const cfg = (cwd, o = {}) => resolveConfig({ cwd, outDir: "snapshot", tmpDir: "snapshot.tmp", ...o });
const allText = (root) => {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf8"));
    }
  })(root);
  return out.join("\n");
};

console.log("=== R2: spread config must keep custom secret rules ===");
const r2 = mk("r2-", { "package.json": '{"name":"x"}', "a.txt": "TOKEN_ID=ACME_abcdefgh1234\n" });
const base = cfg(r2, { secrets: { customPatterns: [{ rule: "acme", pattern: /ACME_[a-z0-9]{10}/ }] } });
const direct = generateSnapshot(base);
const spreadConfig = { ...base, maxPartBytes: 64 * 1024 };
ok("spread copy still recognised as resolved", isResolvedConfig(spreadConfig));
const spread = generateSnapshot(spreadConfig);
ok(
  "custom rule survives a spread copy",
  spread.warnings.some((w) => w.includes("acme")),
  `direct=${direct.warnings.filter((w) => w.includes("acme")).length} spread=${spread.warnings.filter((w) => w.includes("acme")).length}`
);
ok("secret not emitted after spread", !allText(path.join(r2, "snapshot")).includes("ACME_abcdefgh1234"));

console.log("=== R3: oversized summary must not zero the body ===");
const headings = Array.from({ length: 8000 }, (_, i) => `## Section heading number ${i} with padding text`).join("\n");
const r3 = mk("r3-", { "package.json": '{"name":"x"}', "docs/huge.md": `${headings}\n\nbody tail line\n` });
const r3m = generateSnapshot(cfg(r3, { maxPartBytes: 300 * 1024, largeFileBytes: 10_000_000 }));
const r3part = r3m.parts[0];
const r3text = fs.readFileSync(path.join(r3, "snapshot", "parts", r3part.filename), "utf8");
const entry = r3m.files.find((f) => f.relativePath === "docs/huge.md");
ok("part within budget", r3part.byteSize <= 300 * 1024, `${r3part.byteSize}`);
ok(
  "body is not zeroed",
  entry.includedBytes > 100_000,
  `includedBytes=${entry.includedBytes} summaryOmitted=${entry.summaryOmitted}`
);
ok("body content present in part", /Section heading number 0/.test(r3text));

console.log("=== H4 residual: huge layer name must not blow the budget ===");
const hugeLayer = "L".repeat(6000);
const h4 = mk("h4-", { "package.json": '{"name":"x"}', "a.ts": "export const a = 1;\n" });
const h4m = generateSnapshot(
  cfg(h4, { maxPartBytes: 4096, layers: [{ name: hugeLayer, match: "**" }] })
);
const worst = Math.max(...h4m.parts.map((p) => p.byteSize));
ok("no part over 4096B", worst <= 4096, `max=${worst}`);
ok("validation passed (bound actually holds)", h4m.validation.status === "passed", h4m.validation.errors.join("; "));
ok("layer name capped in the part", !fs.readFileSync(path.join(h4, "snapshot", "parts", h4m.parts[0].filename), "utf8").includes(hugeLayer));

console.log("=== 02§6: tampered bookkeeping and commit drift ===");
const t6 = mk("t6-", { "package.json": '{"name":"x"}', "a.ts": "export const a = 1;\n" });
const t6cfg = cfg(t6);
generateSnapshot(t6cfg);
const manPath = path.join(t6, "snapshot", "manifest.json");
const pristine = JSON.parse(fs.readFileSync(manPath, "utf8"));

for (const [label, mutate] of [
  ["counts.totalFiles", (m) => { m.counts.totalFiles = 999; }],
  ["totals.includedFiles", (m) => { m.totals.includedFiles = 999; }],
  ["totals.totalSourceBytes", (m) => { m.totals.totalSourceBytes = 1; }],
  ["totals.totalContentBytes", (m) => { m.totals.totalContentBytes = 1; }],
  ["totals.warningCount", (m) => { m.totals.warningCount = 42; }],
  ["budgets.maxPartBytes", (m) => { m.budgets.maxPartBytes = 1; }],
  ["totals.previewFiles", (m) => { m.totals.previewFiles = 7; }],
]) {
  const m = JSON.parse(JSON.stringify(pristine));
  mutate(m);
  fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
  const result = validateSnapshot(t6cfg);
  ok(`tampered ${label} detected`, result.valid === false && result.drift.totalsMismatches.length > 0);
}
fs.writeFileSync(manPath, JSON.stringify(pristine, null, 2));

fs.writeFileSync(path.join(t6, "b.ts"), "export const b = 2;\n");
execFileSync("git", ["add", "-A"], { cwd: t6, stdio: "ignore" });
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "second"], { cwd: t6, stdio: "ignore" });
const commitDrift = validateSnapshot(t6cfg);
ok(
  "new commit produces a warning",
  commitDrift.warnings.some((w) => /HEAD is/.test(w)),
  JSON.stringify(commitDrift.warnings)
);

console.log("=== S5 residuals from the verifier ===");
for (const name of [".env_backup", ".env-bak", ".envrc", "credentials.json", "service-account.json", "secrets.json", "terraform.tfvars"]) {
  ok(`${name} denied`, isSensitivePath(name));
}
for (const name of [".env.example", ".env.production.example", "src/app.ts"]) {
  ok(`${name} allowed`, !isSensitivePath(name));
}

for (const d of [r2, r3, h4, t6]) fs.rmSync(d, { recursive: true, force: true });
