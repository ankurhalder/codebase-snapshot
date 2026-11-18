/**
 * The canary fixture: one small repository that exercises the pipeline's promises end to end.
 *
 * Each file is a known failure mode from the audit history: a sensitive file that must be skipped,
 * a credential that must be redacted everywhere, CRLF that must be normalised, a BOM that must not
 * survive, a binary that must not be emitted, an ignored file, and a file over the large-file
 * budget that must carry a reason and omitted ranges. The snapshot must generate, validate and
 * pass the deep audit with every one of them accounted for.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findSection, parsePartSections } from "../dist/mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");
const MARKER = "[REDACTED: potential secret-like value omitted from snapshot]";
const LIVE_KEY = "sk_live_CANARY_DO_NOT_EMIT_1234567890";
const PROJECT_KEY = "sk-proj-CANARY_DO_NOT_EMIT_ABCDEF123456";

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

function writeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("package.json", JSON.stringify({ name: "canary", version: "1.0.0" }, null, 2) + "\n");
  write("src/leak.ts", 'export const apiKey = "' + PROJECT_KEY + '";\n');
  write("src/crlf.ts", "export const one = 1;\r\nexport const two = 2;\r\n");
  write("src/bom.ts", "\uFEFFexport const bom = true;\n");
  write(
    "src/large.ts",
    Array.from({ length: 300 }, (_, index) => "export const value" + index + " = " + index + ";").join("\n") + "\n"
  );
  write("src/blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));
  write(".env", "CANARY_TOKEN=" + LIVE_KEY + "\n");
  write("ignored.txt", "this file is ignored\n");
  write(".gitignore", "ignored.txt\n");
  return root;
}

function walk(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

test("the canary repository survives every documented transformation", (t) => {
  const root = writeFixture(t);
  const generated = cli(
    ["generate", "--max-part-bytes", "8k", "--large-file-bytes", "4k", "--pack", "json"],
    root
  );
  assert.equal(generated.code, 0, generated.out);

  const snapshotDir = path.join(root, "snapshot");
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
  const included = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const skipped = new Map(manifest.skipped.map((record) => [record.path, record.reason]));

  assert.ok(included.has("src/leak.ts"));
  assert.equal(skipped.get(".env"), "sensitive-file", "the .env is excluded with the documented reason");
  assert.equal(skipped.get("src/blob.bin"), "binary", "a NUL-bearing file is skipped as binary");
  assert.equal(skipped.get("ignored.txt"), "gitignore", "the .gitignore rule is applied in a walk");

  const crlf = included.get("src/crlf.ts");
  assert.equal(crlf.inclusionMode, "full");
  assert.equal(crlf.originalLines, 2);

  const large = included.get("src/large.ts");
  assert.equal(large.inclusionMode, "preview", "a file over the large-file budget is a preview");
  assert.equal(large.truncationReason, "large-file-budget");
  assert.ok(Array.isArray(large.omittedRanges) && large.omittedRanges.length === 1, "the omission is named");

  const sections = new Map();
  for (const part of manifest.parts) {
    for (const section of parsePartSections(fs.readFileSync(path.join(snapshotDir, "parts", part.filename), "utf8"))) {
      sections.set(section.path, section);
    }
  }
  const leak = findSection([...sections.values()], "src/leak.ts");
  assert.ok(leak, "the redacted file has a section");
  assert.ok(leak.body.includes(MARKER), "the credential is masked");
  assert.equal(leak.body.includes(PROJECT_KEY), false, "the credential itself is absent");

  const crlfSection = findSection([...sections.values()], "src/crlf.ts");
  assert.equal(crlfSection.body.includes("\r"), false, "CRLF is normalised to LF in the part");
  const bomSection = findSection([...sections.values()], "src/bom.ts");
  assert.equal(bomSection.body.startsWith("export const bom"), true, "the BOM does not reach the part");

  // No artifact carries either canary value. Read every text file rather than trusting the parts.
  for (const relative of walk(snapshotDir)) {
    if (!/\.(md|json|txt|xml|sarif)$/i.test(relative)) continue;
    const text = fs.readFileSync(path.join(snapshotDir, relative), "utf8");
    assert.equal(text.includes(LIVE_KEY), false, relative + " carries the .env value");
    assert.equal(text.includes(PROJECT_KEY), false, relative + " carries the source credential");
  }

  const pack = JSON.parse(fs.readFileSync(path.join(snapshotDir, "full-codebase.json"), "utf8"));
  const packedCrlf = pack.files.find((file) => file.relativePath === "src/crlf.ts");
  assert.ok(packedCrlf, "the JSON pack holds the CRLF file");
  assert.equal(packedCrlf.content.includes("\r"), false, "the pack normalises line endings like the parts");

  const health = cli(["health", "--deep", "--format", "json"], root);
  assert.equal(health.code, 0, health.out);
  const report = JSON.parse(health.out.slice(health.out.indexOf("{")));
  assert.equal(report.counts.fail, 0, JSON.stringify(report.checks.filter((check) => check.status === "fail")));
  assert.equal(report.checks.find((check) => check.id === "fidelity.bodies").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "packs.bodies").status, "pass");

  // The same settings, because validate compares the recorded configuration with this run's.
  const validate = cli(
    ["validate", "--max-part-bytes", "8k", "--large-file-bytes", "4k", "--pack", "json"],
    root
  );
  assert.equal(validate.code, 0, validate.out);
});
