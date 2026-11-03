import { generateSnapshot, isSensitivePath, resolveConfig } from "../../dist/index.js";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
let pass=0, fail=0;
const ok=(l,p,e="")=>{p?pass++:fail++;console.log(`  ${p?"PASS":"FAIL"}  ${l}${e?"  "+e:""}`)};

console.log("=== S5 residuals ===");
for (const n of [".env-", ".env_", ".env_backup", ".netrc.bak", ".npmrc.bak", "id_rsa.bak", ".envrc", ".envbackup"]) ok(`${n} denied`, isSensitivePath(n));
for (const n of [".env.example", ".env.production.example", "credentials.example.json", "id_rsa.template", ".npmrc.sample", ".environment", "src/env.ts"]) ok(`${n} allowed`, !isSensitivePath(n));

console.log("=== lossy JSON round-trip now fails loudly ===");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lossy-"));
fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
const resolved = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", secrets: { customPatterns: [{ rule: "acme", pattern: /ACME_[a-z0-9]{10}/ }] } });
let threw = null;
try { generateSnapshot(JSON.parse(JSON.stringify({ ...resolved, cwd: dir, outDir: "s2", tmpDir: "s2.tmp" }))); } catch (e) { threw = e.message; }
ok("JSON clone of a config throws a clear error", Boolean(threw) && /cannot survive JSON serialization/.test(threw), threw ? threw.slice(0, 70) + "..." : "no throw");
let okRun = true;
try { generateSnapshot(resolved); } catch { okRun = false; }
ok("the real resolved config still works", okRun);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);