/** Part-budget fuzz, second pass: same flags for validate, and keep failing output. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("dist/bin.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-parts2-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "package.json"), '{"name":"p","version":"1.0.0"}\n');

const rand = (n) => Math.floor(Math.random() * n);
const generateFailures = [];
const violations = [];

for (let iteration = 0; iteration < 60; iteration += 1) {
  fs.rmSync(path.join(repo, "src"), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const files = 1 + rand(30);
  for (let index = 0; index < files; index += 1) {
    const lines = 1 + rand(3000);
    const body = Array.from({ length: lines }, (_, line) => "export const v" + line + " = " + line + ";").join("\n");
    fs.writeFileSync(path.join(repo, "src", `f${index}.ts`), body + "\n");
  }
  const budget = String(4 + rand(60)) + "k";
  const flags = ["--max-part-bytes", budget];
  if (Math.random() < 0.5) flags.push("--max-parts", String(1 + rand(6)));
  if (Math.random() < 0.3) flags.push("--max-part-tokens", String(2 + rand(40)) + "k");
  fs.rmSync(path.join(repo, "snapshot"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [BIN, "generate", "--cwd", repo, ...flags], { encoding: "utf8" });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    generateFailures.push({ flags: flags.join(" "), status: result.status, out: out.slice(-1200) });
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "snapshot", "manifest.json"), "utf8"));
  const ceiling = manifest.budgets.maxPartBytes;
  for (const part of manifest.parts) {
    if (part.byteSize > ceiling) violations.push({ flags: flags.join(" "), ceiling, part: part.filename, byteSize: part.byteSize });
  }
  const declared = manifest.parts.reduce((total, part) => total + part.fileCount, 0);
  if (declared !== manifest.files.length) violations.push({ flags: flags.join(" "), kind: "file-count", declared, files: manifest.files.length });
  const validated = spawnSync(process.execPath, [BIN, "validate", "--cwd", repo, ...flags], { encoding: "utf8" });
  if (validated.status !== 0) {
    violations.push({ flags: flags.join(" "), kind: "validate", out: `${validated.stdout ?? ""}${validated.stderr ?? ""}`.slice(-800) });
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ iterations: 60, generateFailures: generateFailures.length, violations: violations.length, failureSamples: generateFailures.slice(0, 3), violationSamples: violations.slice(0, 3) }, null, 2));