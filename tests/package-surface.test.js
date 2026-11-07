import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTools } from "../dist/mcp.js";

/**
 * What the published package promises, from the 0.9.12 audit.
 *
 * Two promises were broken. Every tool but one ignored a custom output directory, so a snapshot
 * written where the agent asked for it was invisible to every tool that could inspect it. And every
 * shipped file ended with a `sourceMappingURL` comment pointing at a `.map` that `package.json#files`
 * deliberately does not ship.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every tool that reads a snapshot accepts the directory it was generated into", () => {
  const readers = [
    "snapshot_status",
    "snapshot_plan",
    "snapshot_generate",
    "snapshot_validate",
    "snapshot_locate",
    "snapshot_dependents",
    "snapshot_read",
    "snapshot_explain",
  ];
  for (const name of readers) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} exists`);
    assert.ok(
      tool.inputSchema.properties?.outDir,
      `${name} must accept outDir, or a snapshot in a custom directory is unreadable`
    );
  }
});

test("a snapshot generated into a custom directory is readable by every tool", async (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export function alpha(): number { return 1; }\n",
  });
  const context = contextFor(root);

  const generated = await tools.get("snapshot_generate").handler({ outDir: "custom-snap" }, context);
  assert.notEqual(generated.isError, true, generated.text);
  assert.ok(fs.existsSync(path.join(root, "custom-snap", "manifest.json")));

  const status = await tools.get("snapshot_status").handler({ outDir: "custom-snap" }, context);
  assert.equal(status.structured?.present, true, `status must see it: ${status.text}`);

  const read = await tools.get("snapshot_read").handler(
    { path: "src/app.ts", outDir: "custom-snap" },
    context
  );
  assert.notEqual(read.isError, true, `read must find it: ${read.text}`);
  assert.match(read.text, /export function alpha/);

  const located = await tools.get("snapshot_locate").handler(
    { query: "alpha", outDir: "custom-snap" },
    context
  );
  assert.ok(located.structured?.total > 0, `locate must search it: ${located.text}`);

  const validated = await tools.get("snapshot_validate").handler({ outDir: "custom-snap" }, context);
  assert.notEqual(validated.isError, true, `validate must check it: ${validated.text}`);
});

test("no shipped file points at a source map that is not shipped", () => {
  const offenders = [];
  for (const name of fs.readdirSync(DIST)) {
    if (!/\.(?:js|cjs|d\.ts|d\.cts)$/.test(name)) continue;
    const text = fs.readFileSync(path.join(DIST, name), "utf8");
    if (text.includes("sourceMappingURL")) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "a debugger resolves that comment, finds nothing, and reports a missing map for a file it " +
      "just loaded — so the comment must not be emitted when the maps are not published"
  );
  assert.equal(
    fs.readdirSync(DIST).some((name) => name.endsWith(".map")),
    false,
    "and no map files are left behind either"
  );
});
