import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
const pkgDir = path.join(tmp, "node_modules", "@ankurhalder", "codebase-snapshot");
fs.mkdirSync(pkgDir, { recursive: true });

// Install exactly what `files` would publish.
for (const entry of fs.readdirSync(repo)) {
  if (["dist", "README.md", "LICENSE", "package.json"].includes(entry)) {
    const src = path.join(repo, entry);
    const dest = path.join(pkgDir, entry);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        if (f.endsWith(".map")) continue;
        fs.copyFileSync(path.join(src, f), path.join(dest, f));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}
// Satisfy the runtime `typescript` dependency without a network install.
fs.symlinkSync(
  path.join(repo, "node_modules", "typescript"),
  path.join(tmp, "node_modules", "typescript"),
  "junction"
);

fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));

const esm = `
import * as api from "@ankurhalder/codebase-snapshot";
import * as cli from "@ankurhalder/codebase-snapshot/cli";
import pkg from "@ankurhalder/codebase-snapshot/package.json" with { type: "json" };
console.log("ESM root exports:", Object.keys(api).length);
console.log("ESM cli exports:", Object.keys(cli).join(","));
console.log("ESM package.json version:", pkg.version);
console.log("ESM generateSnapshot is sync:", api.generateSnapshot.constructor.name);
`;
const cjs = `
const api = require("@ankurhalder/codebase-snapshot");
const cli = require("@ankurhalder/codebase-snapshot/cli");
const pkg = require("@ankurhalder/codebase-snapshot/package.json");
console.log("CJS root exports:", Object.keys(api).length);
console.log("CJS cli exports:", Object.keys(cli).join(","));
console.log("CJS package.json version:", pkg.version);
`;
const bin = `
const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, [require.resolve("@ankurhalder/codebase-snapshot/package.json").replace("package.json", require("node:path").join("dist","bin.js")), "--version"], { encoding: "utf8" });
console.log("CLI bin version:", out.trim());
`;

fs.writeFileSync(path.join(tmp, "esm.mjs"), esm);
fs.writeFileSync(path.join(tmp, "cjs.cjs"), cjs);
fs.writeFileSync(path.join(tmp, "bin.cjs"), bin);

const run = (file) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(tmp, file)], { encoding: "utf8", cwd: tmp }) };
  } catch (err) {
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
};

for (const file of ["esm.mjs", "cjs.cjs", "bin.cjs"]) {
  const result = run(file);
  console.log(`\n--- ${file} ---`);
  console.log(result.out.trim().split("\n").map((line) => (result.ok ? "  OK   " : "  FAIL ") + line).join("\n"));
}

console.log("\nfiles shipped in the package dir:");
console.log(
  fs.readdirSync(path.join(pkgDir, "dist")).sort().map((f) => "  " + f).join("\n")
);
fs.rmSync(tmp, { recursive: true, force: true });
