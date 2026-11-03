import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateSnapshot } from "../../dist/index.js";

// Fixture WITHOUT a git repo -> collectFiles() falls back to walkDirectory(), which ignores .gitignore entirely.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-nogit-"));
fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n.env\n*.pem\n");
fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"x"}');
fs.writeFileSync(path.join(tmp, ".env"), "STRIPE=sk_live_abcdefghijklmnopqrstuvwx\nDB_PASS=supersecretvalue\n");
fs.writeFileSync(path.join(tmp, "id.pem"), "-----BEGIN PRIVATE KEY-----\nAAAAsecretbodyBBBB\n-----END PRIVATE KEY-----\n");

const m = await generateSnapshot({ cwd: tmp, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const parts = fs.readdirSync(path.join(tmp, "snapshot", "parts")).map(f => fs.readFileSync(path.join(tmp, "snapshot", "parts", f), "utf8")).join("\n");
console.log("git absent -> fallback walker used");
console.log("  .env included in snapshot? ", m.files.some(f => f.relativePath === ".env"));
console.log("  id.pem included?          ", m.files.some(f => f.relativePath === "id.pem"));
console.log("  .gitignore honored?       ", !m.files.some(f => f.relativePath === ".env"));
console.log("  STRIPE secret in parts?   ", parts.includes("sk_live_abcdefghijklmnopqrstuvwx"));
console.log("  PEM body in parts?        ", parts.includes("AAAAsecretbodyBBBB"));
console.log("  DB_PASS in parts?         ", parts.includes("supersecretvalue"));
