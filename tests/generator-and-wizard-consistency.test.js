import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

/**
 * 4.1.0 regression cover for four LOW findings from a wave over the generators and the wizard.
 *
 * D1 — the monolith emitted control and bidi characters raw while parts, tree, navigation and audit
 *      escaped them.
 * D2 — the snapshot README linked to reports that `--skip-artifacts` never wrote.
 * D3 — a config layer or kind name containing `|` or a backtick broke the table or the inline-code
 *      span it was listed in.
 * D4 — the wizard treated `package.json#snapshot` as an existing config when it was an array.
 *
 * These drive the CLI, because a repository config file is a CLI feature: the library's
 * `generateSnapshot` takes a config object and never reads `snapshot.config.*`.
 */

function tempDir(t, prefix = "snap-generators-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  return dir;
}

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const read = (dir, ...parts) => fs.readFileSync(path.join(dir, "snapshot", ...parts), "utf8");

test("D1: the monolith escapes control and bidi characters like every other artifact", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(
    path.join(dir, "snapshot.config.mjs"),
    'export default {\n  layersMode: "replace",\n  layers: [{ name: "core\\u202Ex", match: "**/*.ts" }],\n};\n',
    "utf8"
  );

  const { code, out } = cli(["generate", "--include-monolith"], dir);
  assert.equal(code, 0, out);

  const monolith = read(dir, "full-codebase.md");
  assert.doesNotMatch(monolith, /\u202E/, "no raw bidi override in the monolith");
  assert.match(monolith, /core\\u202Ex/, "the layer name is re-spelled instead");
});

test("D2: the snapshot README links only to artifacts that were written", (t) => {
  const dir = makeRepo(t);

  const { code, out } = cli(
    ["generate", "--skip-artifacts", "navigation,projectTree,audit"],
    dir
  );
  assert.equal(code, 0, out);

  const readme = read(dir, "README.md");
  assert.doesNotMatch(readme, /reports\/navigation\.md/, "no dangling navigation link");
  assert.doesNotMatch(readme, /reports\/project-tree\.md/, "no dangling tree link");
  assert.doesNotMatch(readme, /reports\/audit\.md/, "no dangling audit link");
  assert.match(readme, /manifest\.json/, "what was written is still linked");
});

test("D2: with only the README written, it says so instead of linking nowhere", (t) => {
  const dir = makeRepo(t);

  const { code, out } = cli(["generate", "--only-artifacts", "readme"], dir);
  assert.equal(code, 0, out);

  const readme = read(dir, "README.md");
  assert.match(readme, /every other artifact was disabled/);
  assert.doesNotMatch(readme, /\]\(parts\//, "no part links either");
});

test("D3: a layer name with a pipe or a backtick cannot break a table", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(
    path.join(dir, "snapshot.config.mjs"),
    'export default {\n  layersMode: "replace",\n  layers: [{ name: "co`re|pipe", match: "**/*.ts" }],\n  kinds: [{ kind: "ki`nd|x", match: "**/*.ts" }],\n};\n',
    "utf8"
  );

  const { code, out } = cli(["generate"], dir);
  assert.equal(code, 0, out);

  for (const artifact of ["reports/navigation.md", "reports/audit.md", "README.md"]) {
    const body = read(dir, ...artifact.split("/"));
    // The escaped spelling is the only one that may appear: `|` becomes `\|` inside the cell.
    const escapedName = "co`re\\|pipe";
    const row = body.split("\n").find((line) => line.includes(escapedName));
    assert.ok(row, `${artifact} lists the hostile layer name escaped: ${body.slice(0, 600)}`);
    assert.doesNotMatch(
      body,
      /co`re[^\\]+\|pipe/,
      `${artifact}: an unescaped pipe must not survive`
    );
  }
});

test("D4: an array-valued package.json#snapshot does not count as an existing config", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", snapshot: [{ maxPartBytes: 4096 }] }, null, 2)}\n`,
    "utf8"
  );

  const { code, out } = cli(["init", "--yes"], dir);

  assert.equal(code, 0, `init must proceed: ${out}`);
  const configName = fs
    .readdirSync(dir)
    .find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));
  assert.ok(configName, "a config was written");
});
