import * as fs from "node:fs";
import * as path from "node:path";
const api = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
const { generateSnapshot } = api;
const base = path.join(process.cwd(), "audit", "poc");
for (const mode of ["full", "snapshot"]) {
  const dir = path.join(base, `api-mc-${mode}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mc" }));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  const m = await generateSnapshot({ cwd: dir, outDir: "snapout", includeMonolith: true, monolithContent: mode });
  const raw = fs.readFileSync(path.join(dir, "snapout", "full-codebase.json"), "utf8");
  const p = JSON.parse(raw);
  console.log(`monolithContent="${mode}" -> files=${m.files.length} monolithBytes=${Buffer.byteLength(raw)} entries=${p.files.length} firstContentLen=${p.files[0]?.content?.length}`);
}
