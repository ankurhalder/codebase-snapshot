import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateSnapshot } from "../../dist/index.js";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-tot-"));
fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"x"}');
// a file whose redaction shrinks content, to test totalContentBytes semantics
fs.writeFileSync(path.join(tmp, "a.ts"), 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst keep = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";\n');
const m = await generateSnapshot({ cwd: tmp, outDir: "snapshot", tmpDir: "snapshot.tmp" });
console.log("totalSourceBytes :", m.totals.totalSourceBytes);
console.log("totalContentBytes:", m.totals.totalContentBytes);
console.log("equal?           :", m.totals.totalContentBytes === m.totals.totalSizeBytes);
console.log("type of each     :", typeof m.totals.totalContentBytes, typeof m.totals.totalSizeBytes);
// actual emitted content bytes across all parts
const pdir = path.join(tmp, "snapshot", "parts");
let emitted = 0;
for (const f of fs.readdirSync(pdir)) emitted += Buffer.byteLength(fs.readFileSync(path.join(pdir, f), "utf8"));
console.log("actual emitted part bytes:", emitted);
// part metadata bytes vs real file size
const man = JSON.parse(fs.readFileSync(path.join(tmp, "snapshot", "manifest.json"), "utf8"));
for (const p of man.parts) {
  const real = Buffer.byteLength(fs.readFileSync(path.join(pdir, p.filename), "utf8"));
  console.log(`  ${p.filename}: metadata.bytes=${p.bytes} realFileBytes=${real} match=${p.bytes === real}  fileCount=${p.fileCount}`);
}
