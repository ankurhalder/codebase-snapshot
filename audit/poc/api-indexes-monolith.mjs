// api-indexes-monolith.mjs - manifest.indexes population + monolith options
import * as fs from "node:fs";
import * as path from "node:path";

const api = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
const { generateSnapshot } = api;
const work = path.join(process.cwd(), "audit", "poc", "api-next-work");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, "app", "api", "hello"), { recursive: true });
fs.mkdirSync(path.join(work, "components"), { recursive: true });
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "nextish", dependencies: { next: "14.0.0" } }));
fs.writeFileSync(path.join(work, "next.config.ts"), "export default {};\n");
fs.writeFileSync(path.join(work, "app", "api", "hello", "route.ts"), 'export async function GET() { return new Response("ok"); }\nexport async function POST() { return new Response("ok"); }\n');
fs.writeFileSync(path.join(work, "components", "Button.tsx"), '"use client";\nexport function Button() { return null; }\n');

const m = await generateSnapshot({ cwd: work, outDir: "snap-idx", maxPartBytes: 300 * 1024 });
console.log("=== manifest.indexes for a Next.js-shaped fixture ===");
console.log("  routes   :", JSON.stringify(m.indexes.routes));
console.log("  components:", JSON.stringify(m.indexes.components));
console.log("  handlers :", JSON.stringify(m.indexes.handlers));
console.log("  features :", JSON.stringify(m.indexes.features));
console.log("  imports  :", JSON.stringify(m.indexes.imports));
console.log("  directives:", JSON.stringify(m.indexes.directives));
console.log("  (directives exist on disk: " + JSON.stringify(m.files.filter((f) => f.summary?.directives?.length).map((f) => f.relativePath)) + ")");
console.log("  layers/kinds:", JSON.stringify(m.layers), JSON.stringify(m.kinds));

console.log("\n=== monolithContent is accepted but never read ===");
for (const mode of ["full", "snapshot"]) {
  const mm = await generateSnapshot({ cwd: work, outDir: `snap-${mode}`, includeMonolith: true, monolithContent: mode });
  const j = fs.readFileSync(path.join(work, `snap-${mode}`, "full-codebase.json"), "utf8");
  console.log(`  monolithContent="${mode}" -> full-codebase.json ${j.length}B, file entries=${JSON.parse(j).files.length}, content field present=${Object.prototype.hasOwnProperty.call(JSON.parse(j).files[0], "content")}`);
}

console.log("\n=== maxMonolithBytes caps the monolith (API-only option, no CLI flag) ===");
{
  const mm = await generateSnapshot({ cwd: work, outDir: "snap-cap", includeMonolith: true, maxMonolithBytes: 100 });
  console.log(`  maxMonolithBytes=100 -> artifacts=${JSON.stringify(mm.artifacts)}; files on disk=${fs.readdirSync(path.join(work, "snap-cap")).join(",")}`);
}

console.log("\n=== manifest embedded inside full-codebase.json vs the final manifest.json ===");
{
  const snap = path.join(work, "snap-full");
  const outer = JSON.parse(fs.readFileSync(path.join(snap, "manifest.json"), "utf8"));
  const inner = JSON.parse(fs.readFileSync(path.join(snap, "full-codebase.json"), "utf8")).manifest;
  console.log(`  final manifest.artifacts.fullJson = ${outer.artifacts.fullJson ? "set" : "null"}`);
  console.log(`  manifest inside full-codebase.json.artifacts = ${JSON.stringify(inner.artifacts)}`);
  console.log(`  same manifest? ${JSON.stringify(inner) === JSON.stringify(outer)}`);
  console.log(`  outer.artifacts.fullJson.byteSize=${outer.artifacts.fullJson?.byteSize} actual full-codebase.json bytes=${fs.statSync(path.join(snap, "full-codebase.json")).size}`);
}
