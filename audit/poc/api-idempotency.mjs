// api-idempotency.mjs - does a second run re-ingest the first run's output?
import * as fs from "node:fs";
import * as path from "node:path";

const api = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
const { generateSnapshot } = api;
const work = path.join(process.cwd(), "audit", "poc", "api-idem-work");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "idem" }));
fs.writeFileSync(path.join(work, "src", "a.ts"), "export const a = 1;\n");

for (const outDir of ["snapshot", "out-custom"]) {
  console.log(`\n=== outDir="${outDir}" (default name vs custom name) ===`);
  const runs = [];
  for (let i = 1; i <= 2; i++) {
    const m = await generateSnapshot({ cwd: work, outDir });
    runs.push({ run: i, files: m.counts.totalFiles, bytes: m.counts.totalSizeBytes, fingerprint: m.fingerprint.slice(0, 12), warnings: m.warnings.length });
  }
  for (const r of runs) console.log(`  run ${r.run}: totalFiles=${r.files} totalSizeBytes=${r.bytes} fingerprint=${r.fingerprint}`);
  console.log(`  idempotent? ${runs[0].fingerprint === runs[1].fingerprint}  (${runs[1].files - runs[0].files} extra files on the 2nd run)`);
  if (outDir === "out-custom") {
    const files = JSON.parse(fs.readFileSync(path.join(work, outDir, "manifest.json"), "utf8")).files.map((f) => f.relativePath);
    const selfRef = files.filter((f) => f.startsWith(outDir + "/"));
    console.log(`  files from inside its own output dir: ${selfRef.length} -> ${selfRef.slice(0, 6).join(", ")}${selfRef.length > 6 ? " ..." : ""}`);
  }
  fs.rmSync(path.join(work, outDir), { recursive: true, force: true });
}
