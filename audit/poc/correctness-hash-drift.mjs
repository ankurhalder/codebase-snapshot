// PoC: claim C - generate() hashes the utf8-decoded STRING, validate() hashes the raw Buffer.
// Run: node audit/poc/correctness-hash-drift.mjs
import { generateSnapshot, validateSnapshot, resolveConfig } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-hash-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });

const write = (rel, buf) => fs.writeFileSync(path.join(repo, rel), buf);
write("src/ok-ascii.ts", Buffer.from("export const a = 1;\n", "utf8"));
write("src/latin1-e9.ts", Buffer.from("export const s = 'caf", "latin1")); // then append raw 0xE9
fs.appendFileSync(path.join(repo, "src/latin1-e9.ts"), Buffer.from([0xe9, 0x27, 0x3b, 0x0a]));
write("src/raw-ff.bin.txt", Buffer.from([0x61, 0x3d, 0x31, 0x3b, 0x0a, 0xff, 0xfe, 0x0a]));
write("src/lone-cr.ts", Buffer.from("a\rb\r\n", "utf8"));
write("src/bom.ts", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const b = 2;\n", "utf8")]));

// Show byte-level reality first
for (const rel of ["src/latin1-e9.ts", "src/raw-ff.bin.txt", "src/lone-cr.ts", "src/bom.ts"]) {
  const buf = fs.readFileSync(path.join(repo, rel));
  const asString = fs.readFileSync(path.join(repo, rel), "utf8");
  console.log(
    `${rel}: rawBytes=${buf.length} hashRaw=${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12)} hashOfDecodedString=${crypto.createHash("sha256").update(asString).digest("hex").slice(0, 12)} lossy=${crypto.createHash("sha256").update(buf).digest("hex") !== crypto.createHash("sha256").update(asString).digest("hex")}`
  );
}

const cfg = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const m1 = await generateSnapshot(cfg);
console.log("\nmanifest file hashes (as recorded by generate):");
for (const f of m1.files) {
  const diskHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, f.relativePath))).digest("hex");
  console.log(`  ${f.relativePath}: manifest=${f.hashSha256.slice(0, 12)} diskRaw=${diskHash.slice(0, 12)} equal=${f.hashSha256 === diskHash}`);
}

const v1 = validateSnapshot(cfg);
console.log("\nvalidate #1:", JSON.stringify({ valid: v1.valid, drift: v1.drift }, null, 2));

// Regenerate, change nothing, validate again: is the phantom drift permanent?
const m2 = await generateSnapshot(cfg);
const v2 = validateSnapshot(cfg);
console.log("\nvalidate #2 after a second generate (no source edits):", JSON.stringify({ valid: v2.valid, errors: v2.errors, mismatches: v2.drift.hashMismatches.map((x) => x.path) }));
console.log("fingerprint stable across regenerations:", m1.fingerprint === m2.fingerprint);

// Proof the mismatch is only the raw-vs-decoded difference:
for (const mm of v2.drift.hashMismatches) {
  const buf = fs.readFileSync(path.join(repo, mm.path));
  const str = fs.readFileSync(path.join(repo, mm.path), "utf8");
  console.log(`  ${mm.path}: snapshotHash==hash(string)=${mm.snapshotHash === crypto.createHash("sha256").update(str).digest("hex")} diskHash==hash(buffer)=${mm.diskHash === crypto.createHash("sha256").update(buf).digest("hex")}`);
}

// Control: what does git itself think?
console.log("\n(control) files whose only 'difference' is decoding are listed above; ascii/bom/lone-cr files are unaffected.");
fs.rmSync(root, { recursive: true, force: true });
