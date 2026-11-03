import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSnapshot, resolveConfig, validateSnapshot } from "../../dist/index.js";

const ok = (label, pass, extra = "") =>
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);

const mk = (prefix, files = {}, git = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    try {
      execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], { cwd: dir, stdio: "ignore" });
    } catch {
      // empty repository: nothing to commit
    }
  }
  return dir;
};
const cfg = (cwd, o = {}) => resolveConfig({ cwd, outDir: "snapshot", tmpDir: "snapshot.tmp", ...o });

// 1. empty repo
const empty = mk("edge-empty-");
const em = generateSnapshot(cfg(empty));
ok("empty repo: no crash, 0 parts", em.counts.partsCount === 0 && em.counts.totalFiles === 0);
ok("empty repo: validation passed", em.validation.status === "passed");
ok("empty repo: validate() agrees", validateSnapshot(cfg(empty)).valid === true);

// 2. only binary/asset files
const onlyBin = mk("edge-bin-", { "a.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) });
const ob = generateSnapshot(cfg(onlyBin));
ok("binary-only repo: skipped with reason", ob.skipped.some((s) => s.reason === "binary"));
ok("binary-only repo: 0 parts", ob.counts.partsCount === 0);

// 3. huge single-line file with multibyte UTF-8 at the cut point
const mb = mk("edge-mb-", { "blob.txt": "é".repeat(120000) });
const mbm = generateSnapshot(cfg(mb, { maxPartBytes: 64 * 1024, largeFileBytes: 8 * 1024 }));
const worst = Math.max(...mbm.parts.map((p) => p.byteSize));
ok(`multibyte blob: no part over 65536B`, worst <= 64 * 1024, `max=${worst}`);
const partText = fs.readFileSync(path.join(mb, "snapshot", "parts", mbm.parts[0].filename), "utf8");
ok("multibyte blob: no U+FFFD introduced", !partText.includes("\uFFFD"));

// 4. includeSensitiveFiles opt-in redacts nothing but IS reported
const sens = mk("edge-sens-", { ".env": "API_KEY=abcdefghijklmnop\n", "src/a.ts": "export const a=1;\n" });
const s = generateSnapshot(cfg(sens, { includeSensitiveFiles: true }));
ok("opt-in emits .env", s.files.some((f) => f.relativePath === ".env"));
const sensText = fs.readFileSync(path.join(sens, "snapshot", "parts", s.parts[0].filename), "utf8");
ok("opt-in still redacts the value", !sensText.includes("abcdefghijklmnop"));

// 5. very long path
const longName = "d/".repeat(40) + "file.ts";
const lp = mk("edge-path-", { [longName]: "export const a=1;\n" });
const lpm = generateSnapshot(cfg(lp, { maxPartBytes: 8 * 1024 }));
ok("path longer than budget still bounded", Math.max(...lpm.parts.map((p) => p.byteSize)) <= 8 * 1024);

// 6. maxPartBytes floor is enforced on the API too
try {
  generateSnapshot(cfg(lp, { maxPartBytes: 512 }));
  ok("tiny maxPartBytes rejected", false);
} catch (err) {
  ok("tiny maxPartBytes rejected", /at least 4096/.test(err.message));
}

// 7. validate after a stray extra file on disk
const addl = mk("edge-add-", { "a.ts": "export const a=1;\n" });
generateSnapshot(cfg(addl));
fs.writeFileSync(path.join(addl, "b.ts"), "export const b=2;\n");
const v = validateSnapshot(cfg(addl));
ok("new file detected as missing from snapshot", v.drift.missingInSnapshot.includes("b.ts"));

// 8. repeated generation is stable (fingerprint + byte-identical parts)
const stable = mk("edge-stable-", { "a.ts": "export const a=1;\n", "b.ts": "export const b=2;\n" });
const r1 = generateSnapshot(cfg(stable));
const p1 = r1.parts.map((p) => p.sha256).join(",");
const r2 = generateSnapshot(cfg(stable));
const p2 = r2.parts.map((p) => p.sha256).join(",");
ok("regeneration is byte-identical (excluding timestamps)", p1 === p2);
ok("fingerprint stable", r1.fingerprint === r2.fingerprint);

for (const d of [empty, onlyBin, mb, sens, lp, addl, stable]) fs.rmSync(d, { recursive: true, force: true });
