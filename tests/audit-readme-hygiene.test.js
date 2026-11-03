/**
 * Audit + README display hygiene for *config* text (L1 / L2 of the wave-3 re-audit).
 *
 * File names were already re-spelled in every artifact, but a layer name supplied
 * by a committed `snapshot.config.json` reached two tables raw: the audit's layer
 * distribution and the README's "Layers Covered" column. A layer name is config
 * text from the repository under analysis, so it is the same untrusted input.
 *
 * The contract these tests pin down:
 *   - `reports/audit.md` and the snapshot `README.md` re-spell control and bidi
 *     characters as `\uXXXX`;
 *   - the raw code point does not appear in either;
 *   - `manifest.json` keeps the raw name, because it is the machine index and has
 *     to describe the configuration as it is on disk.
 *
 * Fixtures are created without git on purpose: this suite never runs git.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, loadConfigFile, resolveConfig } from "../dist/index.js";

const RLO = "\u202E"; // right-to-left override
const ESC = "\u001B"; // C0 escape, the start of every ANSI sequence

const RLO_LAYER = `core${RLO}gnp.exe`;
const ESC_LAYER = `retro${ESC}[31mred`;
const ESCAPED_RLO_LAYER = String.raw`core\u202Egnp.exe`;
const ESCAPED_ESC_LAYER = String.raw`retro\u001B[31mred`;

async function withRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-readme-hygiene-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (relativePath, content) => {
    const full = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  // A committed config: the layer names are the untrusted input under test.
  write(
    "snapshot.config.json",
    JSON.stringify(
      {
        layersMode: "replace",
        layers: [
          { name: RLO_LAYER, match: "src/**" },
          { name: ESC_LAYER, match: "docs/**" },
        ],
      },
      null,
      2
    )
  );
  write("src/a.ts", "export const a = 1;\n");
  write("docs/notes.md", "# notes\n");

  const loaded = await loadConfigFile(dir);
  const manifest = generateSnapshot(
    resolveConfig({ ...loaded, cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" })
  );
  const read = (relativePath) => fs.readFileSync(path.join(dir, "snapshot", relativePath), "utf8");
  return {
    manifest,
    audit: read(path.join("reports", "audit.md")),
    readme: read("README.md"),
    manifestJson: read("manifest.json"),
  };
}

test("L1: audit.md re-spells a config layer name instead of printing it raw", async (t) => {
  const { audit } = await withRepo(t);

  assert.ok(audit.includes(ESCAPED_RLO_LAYER), "the layer table must show the escaped spelling");
  assert.ok(audit.includes(ESCAPED_ESC_LAYER), "an ESC in a layer name must be escaped too");
  assert.equal(audit.includes(RLO), false, "U+202E must not reach audit.md raw");
  assert.equal(audit.includes(ESC), false, "ESC must not reach audit.md raw");
});

test("L2: the snapshot README re-spells the Layers Covered column", async (t) => {
  const { readme } = await withRepo(t);

  assert.ok(readme.includes(ESCAPED_RLO_LAYER), "the part table must show the escaped spelling");
  assert.ok(readme.includes(ESCAPED_ESC_LAYER), "an ESC in a layer name must be escaped too");
  assert.equal(readme.includes(RLO), false, "U+202E must not reach README.md raw");
  assert.equal(readme.includes(ESC), false, "ESC must not reach README.md raw");
});

test("L3: manifest.json keeps the raw layer name", async (t) => {
  const { manifest, manifestJson } = await withRepo(t);

  assert.ok(manifest.layers[RLO_LAYER] >= 1, "the machine index must key the layer by its raw name");
  assert.ok(manifest.layers[ESC_LAYER] >= 1, "the ESC layer must be keyed by its raw name too");
  assert.ok(manifestJson.includes(RLO_LAYER), "the raw U+202E must survive into manifest.json");
  assert.equal(manifestJson.includes(ESCAPED_RLO_LAYER), false, "manifest.json must not be escaped");
});
