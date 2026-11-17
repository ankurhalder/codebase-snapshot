/** Config fuzz: a hostile snapshot.config.mjs must produce a diagnostic, never a stack trace. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("dist/bin.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-config-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"name":"f","version":"1.0.0"}\n');
fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");

const values = ['"x"', "1", "-1", "0", "1.5", "null", "true", "false", "[]", "{}", '["a"]', '{ a: 1 }', "undefined", "NaN", "1e400", "Symbol(\"x\")", "() => 1", "\"\"", '[{ a: 1 }]'];
const keys = ["brief", "promptTask", "attachmentSlots", "maxParts", "maxPartBytes", "excludePatterns", "artifacts", "secretRules", "preset", "layers", "kinds", "budgets", "outDir", "largeFileBytes", "attachment-slots", "prompt-task"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

let crashes = 0;
const samples = [];
for (let i = 0; i < 400; i += 1) {
  const entries = [];
  const n = 1 + Math.floor(Math.random() * 3);
  for (let j = 0; j < n; j += 1) entries.push(`${pick(keys)}: ${pick(values)}`);
  const source = Math.random() < 0.5 ? `export default { ${entries.join(", ")} };` : `const c = { ${entries.join(", ")} }; export default c;`;
  fs.writeFileSync(path.join(root, "snapshot.config.mjs"), source);
  fs.rmSync(path.join(root, "snapshot"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [BIN, "generate", "--cwd", root], { encoding: "utf8" });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (![0, 1, 2].includes(result.status ?? -1)) {
    crashes += 1;
    samples.push({ source, status: result.status, tail: out.split("\n").slice(-3).join(" | ") });
  }
  if (/at Object\.|at Module\.|TypeError|ReferenceError|Cannot read propert|is not a function/.test(out)) {
    crashes += 1;
    samples.push({ source, status: result.status, tail: out.split("\n").slice(-3).join(" | ") });
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ iterations: 400, crashes, samples: samples.slice(0, 4) }, null, 2));