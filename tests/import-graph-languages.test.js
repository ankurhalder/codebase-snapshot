import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildImportResolver,
  explainPath,
  generateSnapshot,
  importsOfText,
  resolveConfig,
  resolveSpecifier,
  summarizeWithProfile,
} from "../dist/index.js";

/**
 * 0.9.14 — the import graph, from three sides.
 *
 * 1.2 — `--with-dependents` dropped an importer whose summary was skipped for being a preview,
 * while `validate` and `explain` read that same file unconditionally. Generating with the flag
 * and then validating with it reported the included file as missing: two commands, two answers,
 * and the generator's answer was the one that lost a dependent.
 *
 * 5.1 — only JavaScript and TypeScript specifiers were resolved. `importsOfText` has extracted
 * Python, Ruby, C/C++ and Dart imports for several releases, so the graph had edges the resolver
 * could not follow: `from .models import Order` was recorded and then resolved to nothing.
 *
 * 4.2 — a `.vue` or `.astro` script block was always parsed as `.ts`, so a `lang="tsx"` block and
 * Astro frontmatter helpers that use JSX were parsed as if `<Foo>` were a type assertion.
 */

function git(dir, args) {
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

function makeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imports-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "first"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, write };
}

const configFor = (dir, extra) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra }, {}, dir);

// ---------------------------------------------------------------------------
// 1.2 — a previewed importer is still an importer
// ---------------------------------------------------------------------------

test("--with-dependents keeps an importer too large for a summary", (t) => {
  // `largeFileBytes` defaults to 200 KB, and a previewed file is not parsed for a structural
  // summary — which is where the generator read imports from. The file's bytes are still in the
  // repo (head and tail in the part), so `validate` and `explain` happily read its imports and
  // called it a dependent the generator had dropped.
  const filler = Array.from({ length: 4000 }, (_v, i) => `export const pad${i} = ${i};`).join("\n");
  const { dir, write } = makeRepo(t, {
    "src/changed.ts": "export const changed = 1;\n",
    "src/big-consumer.ts": `import { changed } from "./changed.js";\n${filler}\nexport const total = changed;\n`,
    "src/untouched.ts": "export const untouched = 1;\n",
  });

  const scope = { changedSince: "HEAD", withDependents: true };

  write("src/changed.ts", "export const changed = 2;\n");
  const manifest = generateSnapshot(configFor(dir, { ...scope, largeFileBytes: 2048 }));
  const paths = manifest.files.map((file) => file.relativePath);

  assert.ok(paths.includes("src/changed.ts"), "the changed file is in the snapshot");
  assert.ok(
    paths.includes("src/big-consumer.ts"),
    "its importer is in the snapshot even though the importer is a preview"
  );
  assert.ok(!paths.includes("src/untouched.ts"), "and the unrelated file is not");

  // The other two commands must agree with the generator, which is the whole point.
  const explained = explainPath(configFor(dir, { ...scope, largeFileBytes: 2048 }), "src/big-consumer.ts");
  assert.equal(explained.included, true, "explain agrees the importer is included");
});

test("imports are capped at the same size generate refuses to summarize", () => {
  // One rule, three commands: `importsOfText` refuses a body over the summary ceiling, so a file
  // generate will not parse is a file validate and explain will not parse either.
  const oversized = `import { x } from "./x.js";\n${"// padding\n".repeat(200000)}`;
  assert.ok(Buffer.byteLength(oversized, "utf8") > 2 * 1024 * 1024);
  assert.deepEqual(importsOfText("big.ts", oversized), []);
  assert.deepEqual(importsOfText("small.ts", 'import { x } from "./x.js";\n'), ["./x.js"]);
});

// ---------------------------------------------------------------------------
// 5.1 — relative imports in languages that are not JavaScript
// ---------------------------------------------------------------------------

const resolver = buildImportResolver([
  { relativePath: "pkg/__init__.py" },
  { relativePath: "pkg/models.py" },
  { relativePath: "pkg/views.py" },
  { relativePath: "lib/user.rb" },
  { relativePath: "src/board.h" },
  { relativePath: "include/render.h" },
  { relativePath: "lib/widget.dart" },
  { relativePath: "src/app.ts" },
]);

test("Python relative imports resolve to the module file", () => {
  assert.equal(resolveSpecifier("pkg/views.py", ".models", resolver), "pkg/models.py");
  assert.equal(resolveSpecifier("pkg/views.py", ".", resolver), "pkg/__init__.py");
});

test("Ruby require_relative resolves, and a bare require does not", () => {
  assert.equal(resolveSpecifier("lib/app.rb", "./user", resolver), "lib/user.rb");
  assert.equal(
    resolveSpecifier("lib/app.rb", "json", resolver),
    null,
    "a gem name is not a path in this repository"
  );
});

test("C and C++ local includes resolve", () => {
  // A quoted include searches the including file's own directory first, which is the only search
  // path a snapshot can reproduce; `-I include` is a compiler flag the repository does not record.
  assert.equal(resolveSpecifier("src/draw.c", "./board.h", resolver), "src/board.h");
  assert.equal(resolveSpecifier("src/draw.c", "stdio.h", resolver), null, "a system header is not");
});

test("a C include of a header that lives elsewhere does not guess", () => {
  // `include/render.h` exists, and `src/draw.c` cannot reach it without an -I path. Inventing the
  // edge would make `--with-dependents` include a file on a guess, and `validate` then disagree.
  assert.equal(resolveSpecifier("src/draw.c", "./render.h", resolver), null);
});

test("Dart relative imports resolve without a leading ./", () => {
  assert.equal(resolveSpecifier("lib/main.dart", "widget.dart", resolver), "lib/widget.dart");
  assert.equal(
    resolveSpecifier("lib/main.dart", "package:flutter/widgets.dart", resolver),
    null,
    "a package import is not a path"
  );
});

test("a Python package import is recorded per module, not as one edge to the package", () => {
  // `from . import models` names the module in the *import list*, so recording the dotted prefix
  // alone (`.`) pointed the edge at a package directory and lost the module. Both spellings now
  // produce the same edge, and the summary de-duplicates them.
  const summary = summarizeWithProfile(
    "pkg/views.py",
    "from . import models\nfrom .models import Order\n"
  );
  assert.ok(summary, "the Python profile answered");
  assert.deepEqual(summary.summary.imports, [".models"]);
});

test("--with-dependents follows a Python relative import", (t) => {
  const { dir, write } = makeRepo(t, {
    "pkg/__init__.py": "",
    "pkg/models.py": "class Order:\n    pass\n",
    "pkg/views.py": "from .models import Order\n\n\ndef show():\n    return Order()\n",
    "pkg/other.py": "VALUE = 1\n",
  });

  write("pkg/models.py", "class Order:\n    total = 1\n");
  const manifest = generateSnapshot(
    configFor(dir, { changedSince: "HEAD", withDependents: true })
  );
  const paths = manifest.files.map((file) => file.relativePath);

  assert.ok(paths.includes("pkg/models.py"), "the changed module is included");
  assert.ok(paths.includes("pkg/views.py"), "and the module that imports it");
  assert.ok(!paths.includes("pkg/other.py"), "but not an unrelated module");
});

// ---------------------------------------------------------------------------
// 4.2 — single-file components are parsed with the right script kind
// ---------------------------------------------------------------------------

test("a Vue script block declared as tsx is parsed as tsx", () => {
  // The same line parses as six errors in a `.ts` kind and none in `.tsx`: an opening tag is a
  // type assertion to the TypeScript grammar, and the attribute list after it is not a type.
  const component = [
    "<template><div /></template>",
    '<script lang="tsx">',
    "export const Widget = () => <Button onClick={() => go()} disabled={true}>ok</Button>;",
    "</script>",
  ].join("\n");
  const outcome = summarizeWithProfile("src/Widget.vue", component);
  assert.ok(outcome, "the SFC profile answered");
  assert.equal(outcome.summary.parseErrors ?? 0, 0, "JSX in a tsx block is not a parse error");
  assert.ok(outcome.summary.exports.includes("Widget"), "and the export is found");
});

test("Astro frontmatter is parsed as tsx", () => {
  const component = [
    "---",
    "const el = <Button onClick={() => go()} disabled={true}>ok</Button>;",
    "export const ok = 1;",
    "---",
    "",
    "<div />",
  ].join("\n");
  const outcome = summarizeWithProfile("src/Page.astro", component);
  assert.ok(outcome, "the SFC profile answered");
  assert.equal(outcome.summary.parseErrors ?? 0, 0, "JSX in Astro frontmatter is not a parse error");
  assert.ok(outcome.summary.exports.includes("ok"));
});
