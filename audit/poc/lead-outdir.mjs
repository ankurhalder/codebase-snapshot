import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateSnapshot } from "../../dist/index.js";

// Disaster check: outDir "." -> path.join(cwd,".") === cwd -> rmSync(cwd, recursive) BEFORE rename.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-outdir-"));
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "precious.ts"), "export const precious = 1; // do not delete\n");
fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"victim"}');
fs.writeFileSync(path.join(tmp, "README.md"), "# keep me\n");

const before = fs.readdirSync(tmp).sort();
console.log("before:", before.join(", "));

await generateSnapshot({ cwd: tmp, outDir: ".", tmpDir: "snapshot.tmp" });

const after = fs.readdirSync(tmp).sort();
console.log("after :", after.join(", "));
console.log("precious.ts survived?", fs.existsSync(path.join(tmp, "src", "precious.ts")));
console.log("src/ survived?       ", fs.existsSync(path.join(tmp, "src")));
console.log("README survived?     ", fs.existsSync(path.join(tmp, "README.md")));
console.log("package.json now:    ", fs.existsSync(path.join(tmp,"package.json")) ? fs.readFileSync(path.join(tmp,"package.json"),"utf8").slice(0,60) : "(gone)");
