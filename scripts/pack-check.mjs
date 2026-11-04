/**
 * Verifies the tarball that `npm publish` would upload.
 *
 * This lives here rather than inline in a workflow so it runs on every machine
 * that can run `npm run verify` — the same check the publish job performs, with
 * no GitHub Actions minutes spent on it. A tarball missing an entry point, the
 * readme, the licence, or containing sourcemaps is a packaging bug that should
 * fail before a version number is spent on it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Entry points and files that must exist in a published tarball. */
const REQUIRED = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.d.cts",
  "dist/cli.js",
  "dist/cli.cjs",
  "dist/cli.d.ts",
  "dist/bin.js",
  "README.md",
  "LICENSE",
];

function listTarballFiles() {
  const asJson = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const raw = (asJson.stdout ?? "").trim();
  if (asJson.status === 0 && raw.startsWith("[")) {
    try {
      return JSON.parse(raw).flatMap((entry) => (entry.files ?? []).map((file) => file.path));
    } catch {
      // Fall through to the plain-text parser.
    }
  }

  const plain = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const text = `${plain.stdout ?? ""}\n${plain.stderr ?? ""}`;
  if (plain.status !== 0) {
    console.error(`npm pack --dry-run exited with code ${plain.status}`);
    console.error(text);
    return null;
  }

  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes("Tarball Contents"));
  if (start === -1) return null;

  const files = [];
  for (const line of lines.slice(start + 1)) {
    if (line.includes("Tarball Details") || line.includes("===")) break;
    const cleaned = line.replace(/^npm notice\s+/, "").trim();
    if (!cleaned) continue;
    files.push(cleaned.split(/\s+/).pop());
  }
  return files.filter(Boolean);
}

const files = listTarballFiles();
if (!files) {
  console.error("FAIL: could not read the tarball file list from npm pack --dry-run");
  process.exit(1);
}

const problems = [];
for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing required file: ${required}`);
}
const sourcemaps = files.filter((file) => file.endsWith(".map"));
if (sourcemaps.length > 0) {
  problems.push(`tarball must not contain .map files: ${sourcemaps.join(", ")}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const createJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages", "create", "package.json"), "utf8")
);
if (createJson.version !== packageJson.version) {
  problems.push(
    `packages/create is at ${createJson.version} but the package is at ${packageJson.version}`
  );
}
const createDependency = createJson.dependencies?.["codebase-snapshot"];
if (createDependency !== `^${packageJson.version}`) {
  problems.push(
    `packages/create depends on ${createDependency ?? "nothing"}; expected ^${packageJson.version}`
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}

console.log(`OK: tarball has ${files.length} files, every required entry, and no sourcemaps`);
