import * as path from "node:path";
const file = path.resolve("audit/poc/api-cfg-esm/snapshot.config.ts");
try {
  const m = await import(`file://${file}`);
  console.log("import OK, default keys:", Object.keys(m.default || {}).join(","));
} catch (e) {
  console.log(`import FAILED: code=${e.code} message=${e.message}`);
}
