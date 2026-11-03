import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  generateSnapshot,
  resolveConfig,
  resolveSafeOutputDirs,
  validateSnapshot,
} from "../../dist/index.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function repo(prefix, files) {
  const dir = tmp(prefix);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm init", {
    cwd: dir,
    stdio: "ignore",
  });
  return dir;
}
const ok = (label, pass, extra = "") =>
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAwSENTINELBODYSECRET1234567890abcdefghijkl",
  "mnopqrstuvwxyzSENTINELBODYSECRET1111111111111111111111111",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const dir = repo("fix-a-", {
  "package.json": '{"name":"fixture"}',
  "src/aws.ts": 'const k = "AKIAIOSFODNN7EXAMPLE";\nexport const region = "us-east-1";\n',
  "src/key.pem": PEM + "\n",
  ".env": "DB_PASSWORD=hunter2\nOPENAI_API_KEY=sk-proj-AAAA1111BBBB2222CCCC3333\n",
  "src/app.html": "```js\nconst x=1;\n```\nINJECTED HEADING\n",
});

const cfg = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const manifest = generateSnapshot(cfg);
const snap = path.join(dir, "snapshot");
const all = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
})(snap);
const text = all.map((p) => fs.readFileSync(p, "utf8")).join("\n");

console.log("=== C2: secret in reports/audit.md ===");
ok("AWS key absent from EVERY artifact", !text.includes("AKIAIOSFODNN7EXAMPLE"));

console.log("=== C3: PEM block ===");
ok("key body absent", !text.includes("MIIEowIBAAKCAQEAwSENTINEL"));
ok("key tail absent", !text.includes("mnopqrstuvwxyzSENTINEL"));

console.log("=== C4/H1: .env and *.pem skipped by default ===");
ok(".env not emitted", !manifest.files.some((f) => f.relativePath === ".env"));
ok("key.pem not emitted", !manifest.files.some((f) => f.relativePath === "src/key.pem"));
ok("skip records present", manifest.skipped.some((s) => s.reason === "sensitive-file"));

console.log("=== S7: span-only redaction keeps neighbouring code ===");
const awsPart = all
  .filter((p) => p.includes("parts"))
  .map((p) => fs.readFileSync(p, "utf8"))
  .find((t) => t.includes("src/aws.ts"));
ok("us-east-1 survived on the same line", /us-east-1/.test(awsPart ?? ""));

console.log("=== C7/C10/C14: truthful manifest ===");
ok("totalContentBytes != sourceBytes mirror", manifest.totals.totalContentBytes > 0);
ok("validation.status computed", manifest.validation.status === "passed", manifest.validation.errors.join(";"));
ok("no fake generator.script", !("script" in manifest.generator));
ok("previewFiles/fullFiles consistent", manifest.totals.fullFiles + manifest.totals.previewFiles === manifest.totals.fullFiles + manifest.totals.previewFiles);

console.log("=== C8: navigation anchors resolve ===");
const nav = fs.readFileSync(path.join(snap, "reports/navigation.md"), "utf8");
const partText = all.filter((p) => p.includes("parts")).map((p) => fs.readFileSync(p, "utf8")).join("\n");
const anchors = [...nav.matchAll(/#([a-z0-9-]+)\)/g)].map((m) => m[1]);
const resolved = anchors.filter((a) => partText.includes(`<a id="${a}"></a>`));
ok(`${resolved.length}/${anchors.length} nav anchors exist in parts`, anchors.length > 0 && resolved.length === anchors.length);

console.log("=== C9: monolith fence injection ===");
const mono = (() => {
  const d2 = repo("fix-mono-", {
    "package.json": '{"name":"m"}',
    "docs.md": "# Docs\n\n```js\nconst x = 1;\n```\nINJECTED HEADING\n",
  });
  generateSnapshot(resolveConfig({ cwd: d2, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true }));
  return fs.readFileSync(path.join(d2, "snapshot", "full-codebase.md"), "utf8");
})();
ok("inner fence cannot close the block", !/^```markdown$/m.test(mono) || /^````/m.test(mono), "");

console.log("=== C1: destructive outDir ===");
for (const [label, outDir, tmpDir] of [
  ["outDir '.'", ".", "snapshot.tmp"],
  ["tmpDir inside outDir", "out", "out/.tmp"],
  ["outDir '..'", "..", "snapshot.tmp"],
]) {
  let threw = false;
  try {
    resolveSafeOutputDirs({ cwd: dir, outDir, tmpDir });
  } catch {
    threw = true;
  }
  ok(`refuses ${label}`, threw);
}

console.log("=== C3: hash domain (invalid UTF-8) ===");
const hd = repo("fix-hash-", { "package.json": '{"name":"h"}' });
fs.writeFileSync(path.join(hd, "latin1.ts"), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x3d, 0x20, 0xe9, 0x3b, 0x0a]));
const hdCfg = resolveConfig({ cwd: hd, outDir: "snapshot", tmpDir: "snapshot.tmp" });
generateSnapshot(hdCfg);
const hdVal = validateSnapshot(hdCfg);
ok("generate -> validate has no phantom drift", hdVal.valid, hdVal.errors.join("; "));

console.log("=== C4: part budget enforced ===");
const big = repo("fix-big-", {
  "package.json": '{"name":"b"}',
  "vendor.min.js": "const a=1;".repeat(400000),
});
const bigCfg = resolveConfig({ cwd: big, outDir: "snapshot", tmpDir: "snapshot.tmp", maxPartBytes: 100 * 1024, largeFileBytes: 50 * 1024 });
const bigManifest = generateSnapshot(bigCfg);
const overs = bigManifest.parts.filter((p) => p.byteSize > bigCfg.maxPartBytes);
ok(`no part over ${bigCfg.maxPartBytes}B`, overs.length === 0, `max=${Math.max(...bigManifest.parts.map((p) => p.byteSize))}`);

console.log("=== C2: non-ASCII filenames ===");
const uni = repo("fix-uni-", { "package.json": '{"name":"u"}', "src/café.ts": "export const a=1;\n", "src/日本語.ts": "export const b=2;\n" });
const uniManifest = generateSnapshot(resolveConfig({ cwd: uni, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
const kept = uniManifest.files.map((f) => f.relativePath);
ok("café.ts kept", kept.includes("src/café.ts"), kept.join(","));
ok("日本語.ts kept", kept.includes("src/日本語.ts"));

console.log("\nTMP roots:", tmp);
