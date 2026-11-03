// A1 (03 §1/§2 ranked #1, HIGH) — `--cwd=path` and `--format=json` (equals form)
// were silently dropped, so `validate` reported false drift in CI.
// A4 (03 §2 ranked #4, MEDIUM) — unknown commands/flags exited 0 and a typo ran
// `generate`; parseInt accepted NaN/0/negatives.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BIN, assert, assertEqual, check, finish, selfTest, tmp, write } from "./v-lib.mjs";

selfTest();

function makeRepo(name) {
  const dir = tmp(name);
  write(dir, ".gitignore", "snapshot/\nsnapshot.tmp/\ncustom/\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/b.ts", "export const b = 2;\n");
  write(dir, "docs/readme.md", "# hello\n\n" + "body line\n".repeat(50));
  return dir;
}

const run = (args, options = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000, ...options });

check("A1.cwd-equals", "--cwd=<dir> is honoured by generate and validate", () => {
  const dir = makeRepo("a1");
  const gen = run(["generate", `--cwd=${dir}`]);
  assertEqual(gen.status, 0, `generate exit ${gen.status}: ${gen.stderr.slice(0, 200)}`);
  assert(fs.existsSync(path.join(dir, "snapshot/manifest.json")), "snapshot written to the wrong directory");
  const val = run(["validate", `--cwd=${dir}`, "--format=json"]);
  const parsed = JSON.parse(val.stdout);
  assertEqual(val.status, 0, `validate exit ${val.status}: ${val.stderr.slice(0, 200)}`);
  assertEqual(parsed.valid, true, `valid flag: ${JSON.stringify(parsed.drift)}`);
  return "generate+validate honoured --cwd= (old: ignored -> false drift)";
});

check("A1.out-dir-equals", "--out-dir=<path> is honoured", () => {
  const dir = makeRepo("a1b");
  const gen = run(["generate", `--cwd=${dir}`, "--out-dir=custom"]);
  assertEqual(gen.status, 0, `exit ${gen.status}: ${gen.stderr.slice(0, 200)}`);
  assert(fs.existsSync(path.join(dir, "custom/manifest.json")), "custom outDir not used");
  assert(!fs.existsSync(path.join(dir, "snapshot")), "default outDir used as well");
  return "custom/manifest.json";
});

check("A1.numeric-equals", "--max-part-bytes=<n> is honoured (equals form)", () => {
  const dir = makeRepo("a1c");
  const gen = run(["generate", `--cwd=${dir}`, "--max-part-bytes=8192"]);
  assertEqual(gen.status, 0, `exit ${gen.status}: ${gen.stderr.slice(0, 200)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot/manifest.json"), "utf8"));
  assertEqual(manifest.budgets.maxPartBytes, 8192, "budget recorded");
  for (const part of manifest.parts) assert(part.byteSize <= 8192, `${part.filename}=${part.byteSize}`);
  return `budget 8192, ${manifest.parts.length} part(s)`;
});

check("A1.mode-equals", "--mode=<command> is honoured", () => {
  const dir = makeRepo("a1d");
  run(["generate", `--cwd=${dir}`]);
  const val = run([`--mode=validate`, `--cwd=${dir}`, "--format=json"]);
  assertEqual(val.status, 0, `exit ${val.status}: ${val.stderr.slice(0, 200)}`);
  return "--mode=validate ran validate";
});

const USAGE_CASES = [
  ["unknown flag", ["generate", "--nonsense"], /Unknown option|nonsense/],
  ["unknown command", ["frobnicate", "--cwd={dir}"], /Unknown command/],
  ["typo'd command", ["valdate", "--cwd={dir}"], /Unknown command/],
  ["two commands", ["generate", "validate"], /Unexpected argument|Only one command/],
  ["bad --format", ["generate", "--format=yaml"], /format must be/],
  ["--max-part-bytes=abc", ["generate", "--max-part-bytes=abc"], /whole number/],
  ["--max-part-bytes=0", ["generate", "--max-part-bytes=0"], /must be at least/],
  ["--max-part-bytes=4095", ["generate", "--max-part-bytes=4095"], /must be at least 4096/],
  ["--max-part-bytes=-5", ["generate", "--max-part-bytes=-5"], /whole number|must be at least/],
  ["--large-file-bytes=abc", ["generate", "--large-file-bytes=abc"], /whole number/],
];

for (const [label, argv, expected] of USAGE_CASES) {
  check(`A4.${label}`, "exits 2 with usage, and does not write a snapshot", () => {
    const dir = makeRepo("a4");
    const args = argv.map((arg) => arg.replace("{dir}", dir));
    const result = run(args);
    assertEqual(result.status, 2, `exit ${result.status} (stderr: ${result.stderr.slice(0, 160)})`);
    assert(expected.test(result.stderr), `unexpected stderr: ${result.stderr.slice(0, 200)}`);
    assert(
      !fs.existsSync(path.join(dir, "snapshot")) && !fs.existsSync(path.join(dir, "snapshot.tmp")),
      "a snapshot was written by an invalid invocation"
    );
    assert(!/\n\s+at .+:\d+:\d+/.test(result.stderr), "stack trace leaked");
    return `exit 2, ${result.stderr.split("\n")[0].slice(0, 60)}`;
  });
}

check("A4.typo-does-not-overwrite", "a typo cannot replace an existing snapshot", () => {
  const dir = makeRepo("a4b");
  run(["generate", `--cwd=${dir}`]);
  const before = fs.readFileSync(path.join(dir, "snapshot/manifest.json"), "utf8");
  write(dir, "src/a.ts", "export const a = 999;\n");
  const result = run(["genrate", `--cwd=${dir}`]);
  const after = fs.readFileSync(path.join(dir, "snapshot/manifest.json"), "utf8");
  assertEqual(result.status, 2, `exit ${result.status}`);
  assertEqual(after, before, "the snapshot was regenerated by a typo'd command");
  return "snapshot untouched";
});

check("A4.help-version", "--help and --version exit 0", () => {
  const help = run(["--help"]);
  assertEqual(help.status, 0, `help exit ${help.status}`);
  assert(/Usage:/.test(help.stdout), "no usage text on stdout");
  const version = run(["--version"]);
  assertEqual(version.status, 0, `version exit ${version.status}`);
  assert(/^v\d+\.\d+\.\d+/.test(version.stdout.trim()), `version output: ${version.stdout}`);
  return `${version.stdout.trim()}`;
});

finish();
