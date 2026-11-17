import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const BIN = path.resolve("dist/bin.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "find-integrity-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "package.json"), '{"name":"p","version":"1.0.0"}\n');
const rand = (n) => Math.floor(Math.random() * n);
for (let attempt = 0; attempt < 120; attempt += 1) {
  fs.rmSync(path.join(repo, "src"), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const files = 1 + rand(30);
  for (let index = 0; index < files; index += 1) {
    const lines = 1 + rand(3000);
    fs.writeFileSync(path.join(repo, "src", `f${index}.ts`), Array.from({ length: lines }, (_, line) => `export const v${line} = ${line};`).join("\n") + "\n");
  }
  const flags = ["--max-part-bytes", String(4 + rand(60)) + "k"];
  if (Math.random() < 0.5) flags.push("--max-parts", String(1 + rand(6)));
  if (Math.random() < 0.3) flags.push("--max-part-tokens", String(2 + rand(40)) + "k");
  fs.rmSync(path.join(repo, "snapshot"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [BIN, "generate", "--cwd", repo, ...flags], { encoding: "utf8" });
  if (result.status === 0) continue;
  const manifestPath = path.join(repo, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(JSON.stringify({
    attempt, flags: flags.join(" "), files,
    status: manifest.validation.status,
    errors: manifest.validation.errors.slice(0, 6),
    budgets: manifest.budgets, config: { maxPartBytes: manifest.config.maxPartBytes, maxPartTokens: manifest.config.maxPartTokens, budgets: manifest.config.budgets, maxParts: manifest.config.maxParts },
    parts: manifest.parts.map((p) => ({ f: p.filename, size: p.byteSize, budget: p.budgetBytes })),
  }, null, 2));
  process.exit(0);
}
console.log("no failure in 120 attempts");
fs.rmSync(root, { recursive: true, force: true });