
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTools } from "../../dist/mcp.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-probe-"));
const write = (r, c) => { const t = path.join(root, r); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c); };
write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
write("src/a.ts", "export const a = 1;\n");
write("src/b.ts", "export const b = 2;\n");
write("notes/ignored.md", "# ignored\n");
write("snapshot.config.json", '{ "outDir": "ctx", "excludePatterns": ["notes/**"] }\n');
const tool = buildTools().find((t) => t.name === "snapshot_plan");
const out = await tool.handler({}, { cwd: root, roots: [root], log: () => {} });
console.log(out.text);
console.log(JSON.stringify(out.structured, null, 2));
fs.rmSync(root, { recursive: true, force: true });
