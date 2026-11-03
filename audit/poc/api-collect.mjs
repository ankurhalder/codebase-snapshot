import * as path from "node:path";
const { collectFiles } = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
for (const rel of ["audit/poc/api-mc-work/snapshot", "audit/poc/api-mc-work/full", "audit/poc/api-fixture", "audit/poc/api-mc-work"]) {
  const cwd = path.resolve(rel);
  console.log(`cwd=${rel} -> collectFiles(${collectFiles(cwd).length}) : ${collectFiles(cwd).slice(0,6).join(", ")}`);
}
