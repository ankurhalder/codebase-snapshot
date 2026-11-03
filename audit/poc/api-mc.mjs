import * as fs from "node:fs";
import * as path from "node:path";
const api = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
const { generateSnapshot } = api;
const base = path.join(process.cwd(), "audit", "poc", "api-mc-work");
for (const mode of ["full", "snapshot"]) {
  const dir = path.join(base, mode);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mc" }));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  const m = await generateSnapshot({ cwd: dir, outDir: "snap", includeMonolith: true, monolithContent: mode });
  const raw = fs.readFileSync(path.join(dir, "snap", "full-codebase.json"), "utf8");
  const p = JSON.parse(raw);
  console.log(`mode=${mode} manifestFiles=${m.files.length} monolithBytes=${Buffer.byteLength(raw)} topKeys=${Object.keys(p).join(",")} filesType=${Array.isArray(p.files) ? "array(" + p.files.length + ")" : typeof p.files} innerManifestFiles=${p.manifest?.files?.length}`);
}
