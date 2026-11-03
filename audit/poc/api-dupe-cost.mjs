import * as fs from "node:fs";
const p = process.argv[2];
const raw = fs.readFileSync(p, "utf8");
const m = JSON.parse(raw);
const bytes = (o) => Buffer.byteLength(JSON.stringify(o, null, 2), "utf8");
let fileDup = 0;
for (const f of m.files) {
  fileDup += bytes({ path: f.path, bytes: f.bytes, sha256: f.sha256 });
}
let partFileDup = 0;
for (const part of m.parts) for (const f of part.includedFiles || []) partFileDup += bytes({ path: f.path, sizeBytes: f.sizeBytes, relativePath: f.relativePath, bytes: f.bytes });
let partMetaDup = 0;
for (const part of m.parts) partMetaDup += bytes({ byteSize: part.byteSize });
const totalDup = fileDup + partFileDup + partMetaDup;
console.log(`manifest=${raw.length}B files=${m.files.length} parts=${m.parts.length}`);
console.log(`duplicate-alias payload: files=${fileDup}B includedFiles=${partFileDup}B partMeta=${partMetaDup}B total=${totalDup}B (${(100*totalDup/raw.length).toFixed(1)}% of manifest, ${Math.round(totalDup/Math.max(1,m.files.length))}B per file)`);
console.log(`FileEntry fields=${Object.keys(m.files[0]).length} (3 are pure aliases) ; PartFileEntry fields=7 (3 aliases) ; PartMetadata fields=${Object.keys(m.parts[0]).length} (1 alias)`);
console.log(`totals.totalContentBytes=${m.totals.totalContentBytes} === totals.totalSourceBytes=${m.totals.totalSourceBytes}`);
