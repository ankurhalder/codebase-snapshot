/** Brief-parser fuzz: no input may crash the CLI, and no output may carry a NUL or a stack trace. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("dist/bin.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-brief-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "package.json"), '{"name":"f","version":"1.0.0"}');
fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");

const headings = ["Stakes", "The system", "What came before", "The bar", "Calibration", "Coverage", "This snapshot", "Attaching this", "The job", "What you have", "Your task", "What a useful answer contains", "Deployment", "Notes", "stakes", "Stakes:", " Coverage ", "系统"];
const pieces = ["", "text", "# Title", "### Sub", "```", "```markdown", "~~~", "## Coverage", "| a | b |", "<!-- comment -->", "\u0000", "\uFEFF", "\u202E", "- item", "> quote"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
function makeBrief() {
  const lines = [];
  const n = 1 + Math.floor(Math.random() * 6);
  for (let i = 0; i < n; i += 1) {
    if (Math.random() < 0.6) lines.push("## " + pick(headings));
    const m = Math.floor(Math.random() * 4);
    for (let j = 0; j < m; j += 1) lines.push(pick(pieces));
  }
  const text = lines.join(Math.random() < 0.3 ? "\r\n" : "\n");
  return Math.random() < 0.2 ? "\uFEFF" + text : text;
}

let crashes = 0;
let failures = 0;
const seen = new Map();
for (let i = 0; i < 250; i += 1) {
  const brief = makeBrief();
  fs.writeFileSync(path.join(repo, "brief.md"), brief);
  fs.rmSync(path.join(repo, "snapshot"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [BIN, "generate", "--cwd", repo, "--brief", "brief.md"], { encoding: "utf8" });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !/brief|promptTask|error|Error|❌/.test(out)) {
    crashes += 1;
    seen.set("silent-failure", brief);
  }
  if (/at Object\.|at Module\.|TypeError|ReferenceError/.test(out)) {
    crashes += 1;
    seen.set("stack-trace", brief);
  }
  if (result.status === 0) {
    const prompt = fs.readFileSync(path.join(repo, "snapshot", "PROMPT.md"), "utf8");
    if (prompt.includes("\u0000")) {
      failures += 1;
      seen.set("nul", brief);
    }
    if (/^## Coverage$/m.test(prompt.split("## Coverage")[1] ? "" : "")) { /* reserved check below */ }
    const ownerCoverage = /## Coverage\n\n> Written by the project owner/.test(prompt);
    if (ownerCoverage) {
      failures += 1;
      seen.set("owner-coverage", brief);
    }
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ iterations: 250, crashes, failures, samples: [...seen.entries()].slice(0, 3) }, null, 2));