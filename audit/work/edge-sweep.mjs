import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("dist/bin.js");
const results = [];

function dir(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "edge-"));
  fs.mkdirSync(path.join(base, "src"), { recursive: true });
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ name: "edge", version: "1.0.0" }));
  for (const [rel, content] of Object.entries(files ?? { "src/a.ts": "export const a = 1;\n" })) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), content);
  }
  return base;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function check(name, fn) {
  try { fn(); results.push([true, name, ""]); }
  catch (error) { results.push([false, name, error.message]); }
}

function assert(condition, message) { if (!condition) throw new Error(message); }
const manifest = (d) => JSON.parse(fs.readFileSync(path.join(d, "snapshot", "manifest.json"), "utf8"));
const promptOf = (d) => fs.readFileSync(path.join(d, "snapshot", "PROMPT.md"), "utf8");

// B: one part, one slot
check("one part, one slot: grammar and advice", () => {
  const d = dir();
  const r = run(["generate", "--attachment-slots", "1"], d);
  assert(r.code === 0, r.out);
  const p = promptOf(d);
  assert(!/The 1 parts/.test(p), "plural slip: " + (p.match(/The 1 parts[^\n]*/) ?? ["none"])[0]);
  assert(/The only part fills a 1-file destination/.test(p), "one part is described as one part");
  assert(!/--max-parts 1/.test(p), "and does not advise merging a single part");
});

// C: two slots
check("two slots: parts plus manifest", () => {
  const d = dir();
  assert(run(["generate", "--attachment-slots", "2"], d).code === 0);
  assert(/2 of 2/.test(promptOf(d)), "the plan counts the slots");
});

// E: generous slots
check("a generous destination carries the whole set", () => {
  const d = dir();
  assert(run(["generate", "--attachment-slots", "100"], d).code === 0);
  assert(/carries the whole set/.test(promptOf(d)), "whole set branch");
});

// F: invalid slots
for (const bad of ["abc", "-1", "2.5", ""]) {
  check("slots rejected: " + JSON.stringify(bad), () => {
    const d = dir();
    const r = run(["generate", "--attachment-slots", bad], d);
    assert(r.code === 2, "expected usage error, got " + r.code + ": " + r.out.slice(0, 120));
  });
}

// G: invalid config value
check("config attachmentSlots: -1 is refused", () => {
  const d = dir();
  fs.writeFileSync(path.join(d, "snapshot.config.mjs"), "export default { attachmentSlots: -1 };\n");
  const r = run(["generate"], d);
  assert(r.code !== 0, "must fail");
  assert(/attachmentSlots/.test(r.out), "names the setting");
});

// H: maxParts 1
check("maxParts 1 produces exactly one part", () => {
  const files = {};
  for (let i = 0; i < 40; i += 1) files["src/f" + i + ".ts"] = "export const v" + i + " = \"x\";\n";
  const d = dir(files);
  const r = run(["generate", "--max-part-bytes", "4096", "--max-parts", "1"], d);
  assert(r.code === 0, r.out);
  assert(manifest(d).parts.length === 1, "one part, got " + manifest(d).parts.length);
});

// I: maxParts larger than needed is a no-op
check("maxParts above the natural count changes nothing", () => {
  const d = dir();
  const before = run(["generate"], d), base = manifest(d).parts.length;
  assert(before.code === 0);
  const r = run(["generate", "--max-parts", "50"], d);
  assert(r.code === 0, r.out);
  assert(manifest(d).parts.length === base, "count unchanged");
  assert(!/maxParts 50: the part budget grew/.test(r.out), "no growth warning");
});

// J: byLayer budgets scale
check("maxParts honours per-layer budgets while merging", () => {
  const files = {};
  for (let i = 0; i < 30; i += 1) files["src/s" + i + ".ts"] = "export const s" + i + " = 1;\n";
  for (let i = 0; i < 30; i += 1) files["docs/d" + i + ".md"] = "# doc " + i + "\n\n" + "text ".repeat(60) + "\n";
  const d = dir(files);
  fs.writeFileSync(path.join(d, "snapshot.config.mjs"), "export default { budgets: { default: \"200k\", byLayer: { docs: \"8k\" } }, maxParts: 3 };\n");
  const r = run(["generate"], d);
  assert(r.code === 0, r.out);
  assert(manifest(d).parts.length <= 3, "at most three parts, got " + manifest(d).parts.length);
});

// K: dry run
check("maxParts with --dry-run writes nothing", () => {
  const d = dir();
  const r = run(["generate", "--dry-run", "--max-parts", "1"], d);
  assert(r.code === 0, r.out);
  assert(!fs.existsSync(path.join(d, "snapshot")), "no output directory");
});

// L: monolith together
check("maxParts plus the monolith still validates", () => {
  const d = dir();
  const r = run(["generate", "--max-parts", "1", "--include-monolith"], d);
  assert(r.code === 0, r.out);
  assert(fs.existsSync(path.join(d, "snapshot", "full-codebase.md")), "monolith written");
  const v = run(["validate", "--max-parts", "1", "--include-monolith"], d);
  assert(v.code === 0, "validate: " + v.out.slice(0, 200));
});

// M: invalid maxParts
for (const bad of ["0", "-2", "abc"]) {
  check("maxParts rejected: " + JSON.stringify(bad), () => {
    const d = dir();
    const r = run(["generate", "--max-parts", bad], d);
    assert(r.code === 2, "expected usage error, got " + r.code + ": " + r.out.slice(0, 120));
  });
}

// O: only the brief
check("--only-artifacts prompt yields a honest empty brief", () => {
  const d = dir();
  const r = run(["generate", "--only-artifacts", "prompt"], d);
  assert(r.code === 0, r.out);
  const p = promptOf(d);
  assert(/Nothing but this brief/.test(p), "says what is missing");
  assert(/do not answer from memory/.test(p), "and what to do");
  assert(!fs.existsSync(path.join(d, "snapshot", "parts")), "no parts");
});

// P: a secret-shaped commit subject is masked
check("a secret-shaped commit subject is masked in the brief", () => {
  const d = dir();
  const git = (args) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) return;
  git(["add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "fix: leaked AWS_KEY=AKIAIOSFODNN7EXAMPLE"]);
  const r = run(["generate"], d);
  assert(r.code === 0, r.out);
  const p = promptOf(d);
  assert(!p.includes("AKIAIOSFODNN7EXAMPLE"), "the raw value must not reach the artifact");
  assert(/## What came before/.test(p), "the history section is still there");
});

// Q: bidi characters in a path are escaped
check("a bidi character in a path is escaped in the brief", () => {
  const d = dir();
  fs.writeFileSync(path.join(d, "src", "bi\u202Edi.ts"), "export const b = 1;\n");
  const r = run(["generate"], d);
  assert(r.code === 0, r.out);
  assert(!promptOf(d).includes("\u202E"), "no raw bidi override");
});

// S: validate without a manifest is a clean failure
check("validate without a manifest exits 1, not a stack trace", () => {
  const d = dir();
  run(["generate", "--only-artifacts", "prompt"], d);
  const v = run(["validate"], d);
  assert(v.code === 1, "exit 1, got " + v.code);
  assert(!/\bat .*\.js:\d+/.test(v.out), "no stack trace");
});


// T: no parts at all
check("a snapshot with no parts omits the delivery plan", () => {
  const d = dir();
  const r = run(["generate", "--skip-artifacts", "parts"], d);
  assert(r.code === 0, r.out);
  const p = promptOf(d);
  assert(!/## Attaching this/.test(p), "no delivery plan");
  assert(!/parts\/part-NNN\.md/.test(p), "and nothing tells the reader to open parts");
});

// U: one slot, two parts
check("one slot and two parts states the overflow", () => {
  const files = {};
  for (let i = 0; i < 30; i += 1) files["src/f" + i + ".ts"] = "export const v" + i + " = \"x\";\n";
  const d = dir(files);
  const r = run(["generate", "--max-part-bytes", "4096", "--attachment-slots", "1"], d);
  assert(r.code === 0, r.out);
  const p = promptOf(d);
  assert(/do not fit a 1-file destination: at most 1 can be attached/.test(p), "states the ceiling");
});

// V: history cap
check("the history section is capped at ten subjects", () => {
  const d = dir();
  const git = (args) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) return;
  git(["add", "-A"]);
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(d, "src", "n" + i + ".ts"), "export const n" + i + " = " + i + ";");
    git(["add", "-A"]);
    git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "chore: round " + i]);
  }
  const r = run(["generate"], d);
  assert(r.code === 0, r.out);
  const subjects = promptOf(d).match(/^- chore: round /gm) ?? [];
  assert(subjects.length === 10, "ten subjects, got " + subjects.length);
});

// W: unlimited slots with parts
check("attachmentSlots 0 says every file can travel", () => {
  const d = dir();
  assert(run(["generate", "--attachment-slots", "0"], d).code === 0);
  assert(/No attachment limit is configured/.test(promptOf(d)), "unlimited branch");
});

// X: no prompt when the artifact is off, and the manifest agrees
check("prompt off leaves no dangling digest", () => {
  const d = dir();
  assert(run(["generate", "--skip-artifacts", "prompt"], d).code === 0);
  assert(manifest(d).artifacts.prompt === undefined, "no digest");
  assert(!fs.existsSync(path.join(d, "snapshot", "PROMPT.md")), "no file");
});

const failed = results.filter(([ok]) => !ok);
for (const [ok, name, message] of results) if (!ok) console.log("FAIL  " + name + "\n      " + message);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " edge cases pass");
