import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, renderExplainText, validateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for two trust boundaries in the validator.
 *
 * T-04 — `parts[].filename` came from the manifest and was joined onto `snapshot/parts` with no
 * confinement, so a manifest naming `../../../some/file` made `validate` read that file and report
 * its byte size back — a read primitive with a byte-size oracle attached.
 *
 * T-05/T-06 — the text form of `explain` interpolated repository-derived names raw, so a bidi
 * override or C1 control in a path, layer or part name could reorder the line or drive the
 * terminal. Values are re-spelled as `\uXXXX` now.
 */

function tempDir(t, prefix = "snap-validator-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const makeRepo = (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  return dir;
};

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));

const writeManifest = (dir, manifest) =>
  fs.writeFileSync(
    path.join(dir, "snapshot", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

test("T-04: a part filename that climbs out of snapshot/parts is refused, not read", (t) => {
  const dir = makeRepo(t);
  generateSnapshot({ cwd: dir });

  // A file outside the snapshot with a distinctive, knowable size.
  const outside = path.join(dir, "outside-secret.txt");
  fs.writeFileSync(outside, "x".repeat(44), "utf8");
  const relativeEscape = path
    .relative(path.join(dir, "snapshot", "parts"), outside)
    .replace(/\\/g, "/");

  const manifest = readManifest(dir);
  manifest.parts.push({ filename: relativeEscape, fileCount: 0, byteSize: 44, sha256: "0".repeat(64) });
  writeManifest(dir, manifest);

  const result = validateSnapshot({ cwd: dir });

  const issues = result.drift.partIssues.map((issue) => `${issue.part}: ${issue.issue}`).join("\n");
  assert.match(issues, /resolves outside snapshot\/parts/, "the escape is reported");
  assert.doesNotMatch(
    issues,
    /byteSize is .* on disk/,
    "the outside file was never read, so its size cannot leak"
  );
  assert.equal(result.valid, false);
});

test("T-04: an absolute part filename is refused too", (t) => {
  const dir = makeRepo(t);
  generateSnapshot({ cwd: dir });

  const manifest = readManifest(dir);
  manifest.parts.push({
    filename: path.join(dir, "outside-abs.txt"),
    fileCount: 0,
    byteSize: 1,
    sha256: "0".repeat(64),
  });
  writeManifest(dir, manifest);

  const result = validateSnapshot({ cwd: dir });
  const issues = result.drift.partIssues.map((issue) => issue.issue).join("\n");
  assert.match(issues, /resolves outside snapshot\/parts/);
});

test("T-04: a legitimate snapshot still validates as current", (t) => {
  const dir = makeRepo(t);
  generateSnapshot({ cwd: dir });

  const result = validateSnapshot({ cwd: dir });

  assert.equal(result.valid, true, "the confinement must not reject real part names");
  assert.deepEqual(result.drift.partIssues, []);
});

test("T-05/T-06: explain's text form re-spells control and bidi characters", () => {
  const rendered = renderExplainText({
    path: `docs/invoice\u202Efdp.txt`,
    exists: true,
    included: true,
    layer: "src\u009bstill",
    kind: "code",
    language: "typescript",
    part: "part\u202E001.md",
    lines: 3,
    bytes: 12,
    secretCount: 0,
  });

  assert.doesNotMatch(rendered, /[\u202E\u009B]/, "no raw bidi or C1 control reaches the terminal");
  assert.match(rendered, /invoice\\u202Efdp\.txt/);
  assert.match(rendered, /src\\u009Bstill/);
  assert.match(rendered, /part\\u202E001\.md/);
});

test("T-05/T-06: ordinary names are untouched by the escaping", () => {
  const rendered = renderExplainText({
    path: "src/café/naïve.ts",
    exists: true,
    included: true,
    layer: "Core",
    kind: "code",
    language: "typescript",
    lines: 1,
    bytes: 5,
    secretCount: 0,
  });

  assert.match(rendered, /src\/café\/naïve\.ts/);
});
