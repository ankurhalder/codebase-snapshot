/** Manifest fuzz: a tampered manifest must produce a diagnostic, never a stack trace. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.resolve("dist/bin.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-manifest-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"name":"f","version":"1.0.0"}');
fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
spawnSync(process.execPath, [BIN, "generate", "--cwd", root], { encoding: "utf8" });
const manifestPath = path.join(root, "snapshot", "manifest.json");
const clean = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const values = [0, -1, 1.5, 1e21, "5", "", null, [], {}, true, "audit", "brief.md", "x".repeat(200)];
const targets = [
  ["config.promptTask"], ["config.brief"], ["config.brief.path"], ["config.brief.digest"],
  ["config.attachmentSlots"], ["config.maxParts"], ["config.digest"], ["config.artifacts"],
  ["budgets.maxPartBytes"], ["budgets.largeFileBytes"], ["counts.totalFiles"], ["counts.partsCount"],
  ["parts.0.byteSize"], ["parts.0.filename"], ["parts.0.index"], ["files.0.relativePath"],
  ["files.0.inclusionMode"], ["fingerprint"], ["schemaVersion"], ["skips"], ["incomplete"],
];
const setPath = (object, dotted, value) => {
  const parts = dotted.split(".");
  let cursor = object;
  for (const key of parts.slice(0, -1)) {
    if (cursor[key] === undefined || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
};

const crashes = [];
for (const target of targets) {
  for (const value of values) {
    const tampered = JSON.parse(JSON.stringify(clean));
    setPath(tampered, target[0], value);
    fs.writeFileSync(manifestPath, JSON.stringify(tampered));
    for (const command of [["validate"], ["report"], ["status"]]) {
      const result = spawnSync(process.execPath, [BIN, ...command, "--cwd", root], { encoding: "utf8" });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (/at Object\.|at Module\.|TypeError|ReferenceError|Cannot read propert|is not a function/.test(out)) {
        crashes.push({ target: target[0], value: String(value).slice(0, 30), command: command[0], tail: out.split("\n").slice(-4).join(" | ") });
      }
    }
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(clean));
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ combinations: targets.length * values.length * 3, crashes: crashes.length, samples: crashes.slice(0, 5) }, null, 2));