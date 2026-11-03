// Runs every v-*.mjs against the frozen dist and records the real output.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const here = import.meta.dirname;
const repo = path.resolve(here, "..", "..");
const scripts = fs
  .readdirSync(here)
  .filter((name) => name.startsWith("v-") && name.endsWith(".mjs") && name !== "v-lib.mjs")
  .sort();

const distHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(repo, "dist", "index.cjs")))
  .digest("hex");

const log = [];
const rows = [];
log.push(`# verification run ${new Date().toISOString()}`);
log.push(`# node ${process.version} · win32 ${process.arch}`);
log.push(`# frozen dist/index.cjs sha256 ${distHash}`);
log.push(`# scripts: ${scripts.length}`);
log.push("");

for (const script of scripts) {
  const started = Date.now();
  let output = "";
  let status = 0;
  try {
    output = execFileSync(process.execPath, [path.join(here, script)], {
      encoding: "utf8",
      cwd: repo,
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    status = typeof err.status === "number" ? err.status : 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const pass = (output.match(/^PASS /gm) ?? []).length;
  const fail = (output.match(/^FAIL /gm) ?? []).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  rows.push({ script, pass, fail, status, seconds });
  log.push(`===== ${script} — ${pass} PASS / ${fail} FAIL / exit ${status} / ${seconds}s =====`);
  log.push(output.trimEnd());
  log.push("");
}

fs.writeFileSync(path.join(here, "RUN-LOG.txt"), log.join("\n"), "utf8");

console.log(`dist/index.cjs sha256 ${distHash}`);
console.log("");
console.log("script                                   pass fail exit  time");
for (const row of rows) {
  console.log(
    `${row.script.padEnd(40)} ${String(row.pass).padStart(4)} ${String(row.fail).padStart(4)} ${String(row.status).padStart(4)}  ${row.seconds}s`
  );
}
const totals = rows.reduce(
  (acc, row) => ({ pass: acc.pass + row.pass, fail: acc.fail + row.fail }),
  { pass: 0, fail: 0 }
);
console.log("");
console.log(`TOTAL ${totals.pass} PASS / ${totals.fail} FAIL across ${rows.length} scripts`);
console.log(`full log: ${path.join(here, "RUN-LOG.txt")}`);
const unexpected = rows.filter((row) => row.fail > 0 || row.status !== 0);
if (unexpected.length > 0) {
  console.log(`scripts with failures: ${unexpected.map((row) => row.script).join(", ")}`);
}
