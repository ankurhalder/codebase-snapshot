import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot } from "../dist/index.js";

/**
 * A file emitted as a head/tail preview carries only a slice of its lines, so a
 * whole-file structural summary describes lines the snapshot does not contain —
 * and building one dominated the run: masking every identifier (through
 * `findSecretInPath`) for a summary the partitioner then discards. Previews are
 * no longer summarised, and the manifest says so in one grouped warning.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-preview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** A source file comfortably above the preview threshold. */
function bigSource(prefix, lines) {
  return Array.from({ length: lines }, (_, index) => `export const ${prefix}${index} = ${index};`).join("\n") + "\n";
}

const SMALL = 'export const small = 1;\nexport function helper() { return small; }\n';

function entryFor(manifest, relativePath) {
  const entry = manifest.files.find((file) => file.relativePath === relativePath);
  assert.ok(entry, `${relativePath} must be in the manifest`);
  return entry;
}

test("a previewed source file gets no structural summary, and the manifest says so", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  write(dir, "src/small.ts", SMALL);
  write(dir, "src/big.ts", bigSource("bulk", 4000));

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 4096 });

  const big = entryFor(manifest, "src/big.ts");
  assert.equal(big.inclusionMode, "preview");
  assert.equal(big.summary, undefined, "a preview must not carry a whole-file summary");
  assert.equal(big.summaryQuality, undefined);

  // A whole file still gets its summary.
  const small = entryFor(manifest, "src/small.ts");
  assert.equal(small.inclusionMode, "full");
  assert.ok(small.summary, "a whole file keeps its summary");
  assert.equal(small.summaryQuality, "ast");

  const grouped = manifest.warnings.filter((warning) => /head\/tail previews and were not parsed/.test(warning));
  assert.equal(grouped.length, 1, `expected one grouped warning: ${JSON.stringify(manifest.warnings)}`);
  assert.match(grouped[0], /src\/big\.ts/);
  assert.match(grouped[0], /^1 file\(s\)/);
});

test("the preview warning names at most five paths and counts the rest", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  for (let index = 0; index < 7; index += 1) {
    write(dir, `src/big${index}.ts`, bigSource(`bulk${index}_`, 900));
  }

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 1024 });

  const grouped = manifest.warnings.filter((warning) => /head\/tail previews and were not parsed/.test(warning));
  assert.equal(grouped.length, 1);
  assert.match(grouped[0], /^7 file\(s\)/);
  assert.match(grouped[0], /and 2 more/);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(
      entryFor(manifest, `src/big${index}.ts`).summary,
      undefined,
      "every preview must be unsummarised"
    );
  }
});

test("a whole file just under the threshold keeps its summary", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  write(dir, "src/medium.ts", bigSource("m", 40));

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 10_000_000 });

  const medium = entryFor(manifest, "src/medium.ts");
  assert.equal(medium.inclusionMode, "full");
  assert.ok(medium.summary, "no preview means no reason to drop the summary");
  assert.equal(
    manifest.warnings.some((warning) => /head\/tail previews and were not parsed/.test(warning)),
    false
  );
});

test("a previewed file whose language has no profile is not reported", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  write(dir, "logs/huge.log", "line\n".repeat(50_000));

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 1024 });

  const log = entryFor(manifest, "logs/huge.log");
  assert.equal(log.summary, undefined, "a .log never had a summary");
  assert.equal(
    manifest.warnings.some((warning) => /head\/tail previews and were not parsed/.test(warning)),
    false,
    "warning about a summary that could never exist would be noise"
  );
});

test("a previewed JSON file is not summarised either", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  const rows = Array.from({ length: 4000 }, (_, index) => `  {"id": ${index}, "name": "row${index}"}`).join(",\n");
  write(dir, "data/rows.json", `[\n${rows}\n]\n`);

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 4096 });

  const json = entryFor(manifest, "data/rows.json");
  assert.equal(json.inclusionMode, "preview");
  assert.equal(json.summary, undefined);
  assert.ok(
    manifest.warnings.some((warning) => /head\/tail previews and were not parsed/.test(warning)),
    "the omission must be visible"
  );
});
