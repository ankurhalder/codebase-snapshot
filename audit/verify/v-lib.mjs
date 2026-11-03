// Shared helpers for the adversarial verification scripts.
// Everything here is throw-away: fixtures live under os.tmpdir() and are removed.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const DIST = path.join(REPO, "dist", "index.js");
export const BIN = path.join(REPO, "dist", "bin.js");

const created = [];

export function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `csv-${name}-`));
  created.push(dir);
  return dir;
}

export function cleanupAll() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function write(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export function gitInit(dir) {
  const run = (args) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "v@example.invalid"]);
  run(["config", "user.name", "verifier"]);
  run(["config", "commit.gpgsign", "false"]);
  return {
    add(...args) {
      run(["add", ...args]);
    },
    commit(message = "init") {
      run(["commit", "-m", message, "--allow-empty"]);
    },
  };
}

/** Every file under `dir` as { relativePath: text|Buffer }. */
export function readTree(dir, { encoding = "utf8" } = {}) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const buffer = fs.readFileSync(full);
        out[path.relative(dir, full).replace(/\\/g, "/")] =
          encoding === "buffer" ? buffer : buffer.toString(encoding);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export function listTree(dir) {
  return Object.keys(readTree(dir, { encoding: "buffer" })).sort();
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------- reporting

let failures = 0;
let passes = 0;
const lines = [];

/** Runs one named check; a throw is a FAIL, everything else a PASS. */
export function check(id, title, fn) {
  try {
    const detail = fn() || "";
    if (detail && typeof detail.then === "function") {
      throw new Error(
        "check() received a Promise — use checkAsync() so the assertion cannot pass silently"
      );
    }
    passes += 1;
    const line = `PASS ${id} :: ${title}${detail ? ` :: ${detail}` : ""}`;
    lines.push(line);
    console.log(line);
  } catch (err) {
    failures += 1;
    const line = `FAIL ${id} :: ${title} :: ${err?.message ?? String(err)}`;
    lines.push(line);
    console.log(line);
  }
}

/** Awaitable variant for checks that need the async config loader. */
export async function checkAsync(id, title, fn) {
  try {
    const detail = (await fn()) || "";
    passes += 1;
    const line = `PASS ${id} :: ${title}${detail ? ` :: ${detail}` : ""}`;
    lines.push(line);
    console.log(line);
  } catch (err) {
    failures += 1;
    const line = `FAIL ${id} :: ${title} :: ${err?.message ?? String(err)}`;
    lines.push(line);
    console.log(line);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertNotIncludes(haystack, needle, label) {
  if (typeof needle !== "string" || needle.length < 4) {
    throw new Error(`assertNotIncludes needs a realistic needle, got ${JSON.stringify(needle)}`);
  }
  if (haystack.includes(needle)) {
    const at = haystack.indexOf(needle);
    const context = haystack.slice(Math.max(0, at - 80), at + 120).replace(/\n/g, "\\n");
    throw new Error(`${label}: found ${JSON.stringify(needle)} at offset ${at} … ${context}`);
  }
}

export function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

export function summarize() {
  console.log(`\n--- ${passes} passed, ${failures} failed ---`);
  return failures === 0 ? 0 : 1;
}

export function finish() {
  const code = summarize();
  cleanupAll();
  process.exit(code);
}

/** Self-check: an assertion that cannot fail is not a test. */
export function selfTest() {
  let threw = false;
  try {
    assertEqual(1, 2, "self-test");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("harness is broken: assertEqual does not throw");
  let threw2 = false;
  try {
    assertNotIncludes("abc supers3cret xyz", "supers3cret", "self-test");
  } catch {
    threw2 = true;
  }
  if (!threw2) throw new Error("harness is broken: assertNotIncludes does not throw");
}
