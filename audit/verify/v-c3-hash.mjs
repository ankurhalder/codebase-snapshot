// C§3 (02 §3 / H3) — generate hashed the utf8-decoded string while validate
// hashed the raw Buffer, so any file with invalid UTF-8 produced permanent
// phantom drift. Check: manifest hash == sha256(raw bytes), validate is clean
// immediately after generate, stays clean after a regeneration, and still
// detects a genuine byte change.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, resolveConfig, validateSnapshot } from "../../dist/index.js";
import { assert, assertEqual, check, finish, selfTest, tmp, write } from "./v-lib.mjs";

selfTest();

const dir = tmp("c3");
const FILES = {
  "src/latin1-e9.ts": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x3d, 0x20, 0x31, 0x0a]),
  "src/raw-ff.bin.txt": Buffer.from([0xff, 0xfe, 0x00 + 0x41, 0x0a]),
  "src/truncated-multibyte.ts": Buffer.from([0x61, 0xe2, 0x82, 0x0a]),
  "src/lone-cr.ts": Buffer.from("a\rb\r", "utf8"),
  "src/bom.ts": Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0a]),
  "src/plain.ts": Buffer.from("export const a = 1;\n", "utf8"),
};

for (const [name, buffer] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
}

const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });

check("C3.single-domain", "manifest hashes equal sha256 of the raw bytes on disk", () => {
  const manifest = generateSnapshot(config);
  const byPath = new Map(manifest.files.map((file) => [file.relativePath, file.hashSha256]));
  const wrong = [];
  for (const [name, buffer] of Object.entries(FILES)) {
    const expected = crypto.createHash("sha256").update(buffer).digest("hex");
    if (byPath.get(name) !== expected) wrong.push(`${name} (${byPath.get(name)} != ${expected})`);
  }
  assertEqual(wrong.length, 0, `hash domain mismatch: ${wrong.join(", ")}`);
  return `${Object.keys(FILES).length}/${Object.keys(FILES).length} match the raw-byte hash`;
});

check("C3.validate-clean", "validate is clean immediately after generate (old: permanent drift)", () => {
  const result = validateSnapshot(config);
  assert(result.valid, `valid:false ${JSON.stringify(result.drift.hashMismatches)} ${result.errors.join("; ")}`);
  return "valid:true, 0 hashMismatches";
});

check("C3.regenerate-clean", "regenerating cannot re-introduce drift", () => {
  generateSnapshot(config);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert(result.valid, `still drifting: ${JSON.stringify(result.drift.hashMismatches)}`);
  return "valid:true after 2 regenerations";
});

check("C3.detects-real-change", "a genuine byte change is still reported (validator not neutered)", () => {
  const target = path.join(dir, "src/plain.ts");
  const original = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.from("export const a = 2;\n", "utf8"));
  const result = validateSnapshot(config);
  fs.writeFileSync(target, original);
  assert(!result.valid, "validator did not notice a modified file");
  assertEqual(result.drift.hashMismatches.length, 1, "hashMismatches");
  assertEqual(result.drift.hashMismatches[0].path, "src/plain.ts", "mismatch path");
  return "1 hashMismatch reported";
});

check("C3.invalid-utf8-edited", "editing an invalid-UTF-8 file is detected too", () => {
  const target = path.join(dir, "src/latin1-e9.ts");
  const original = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]));
  const result = validateSnapshot(config);
  fs.writeFileSync(target, original);
  assert(!result.valid, "not detected");
  assertEqual(result.drift.hashMismatches[0].path, "src/latin1-e9.ts", "mismatch path");
  return "detected";
});

check("C3.no-lossy-content", "invalid UTF-8 content is included, not silently dropped as binary", () => {
  const manifest = generateSnapshot(config);
  const included = new Set(manifest.files.map((file) => file.relativePath));
  for (const name of Object.keys(FILES)) assert(included.has(name), `${name} was dropped`);
  return `${Object.keys(FILES).length}/${Object.keys(FILES).length} included`;
});

check("C3.utf8-roundtrip", "the decoded text really is lossy here (so the check is meaningful)", () => {
  const buffer = FILES["src/latin1-e9.ts"];
  const viaString = Buffer.from(buffer.toString("utf8"), "utf8");
  assert(!buffer.equals(viaString), "fixture is not actually invalid UTF-8 — test would be vacuous");
  const buffer2 = FILES["src/raw-ff.bin.txt"];
  assert(!buffer2.equals(Buffer.from(buffer2.toString("utf8"), "utf8")), "second fixture is valid UTF-8");
  return "2 fixtures are genuinely lossy under utf8 round-trip";
});

finish();
