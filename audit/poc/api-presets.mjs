import * as path from "node:path";
const { detectPreset } = await import(`file://${path.resolve("dist/index.js").replace(/\\/g, "/")}`);
for (const name of ["nextjs","vite","node-express","nest","plain"]) {
  const p = detectPreset(path.resolve("audit/poc/api-presets", name));
  console.log(`  ${name.padEnd(14)} -> preset=${p.presetName} layers=${p.layers.length} kinds=${p.kinds.length}`);
}
