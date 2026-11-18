/**
 * The language profiles: one fixture per language, asserting what the summary promises.
 *
 * These are the claims the docs make: imports, top-level definitions and route decorators are
 * extracted for Python, Go, Rust, Java, C#, Ruby and PHP, so snapshot_locate can find a symbol and
 * the import graph can connect files in those languages.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

const FIXTURES = {
  "app.py": "import os\nfrom flask import Flask\n\nclass Service:\n    pass\n\ndef run():\n    return 1\n\n@app.get('/health')\ndef health():\n    return 'ok'\n",
  "main.go": "package main\n\nimport \"fmt\"\n\ntype Server struct{}\n\nfunc main() { fmt.Println(\"hi\") }\n",
  "lib.rs": "use std::collections::HashMap;\n\npub struct Store {}\n\npub fn open() -> Store { Store {} }\n",
  "App.java": "import java.util.List;\n\npublic class App {\n  public void run() {}\n}\n",
  "Program.cs": "using System;\n\nnamespace Demo {\n  public class Program {\n    public static void Main() {}\n  }\n}\n",
  "task.rb": "require 'json'\n\nclass Task\n  def run\n  end\nend\n",
  "index.php": "<?php\nnamespace App;\n\nclass Controller {\n  public function index() {}\n}\n"
};

test("every advertised language yields imports and definitions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "langs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(root, name), content);
  fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"langs\",\"version\":\"1.0.0\"}\n");

  const result = spawnSync(process.execPath, [BIN, "generate"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, (result.stdout ?? "") + (result.stderr ?? ""));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  const summaryOf = (name) => manifest.files.find((file) => file.relativePath === name).summary;

  const python = summaryOf("app.py");
  assert.ok(python.imports.includes("flask"), "python imports");
  assert.ok(python.classes.includes("Service"), "python class");
  assert.ok(python.functions.includes("run"), "python function");
  assert.ok(python.routeHandlers.length > 0, "python route decorator");

  assert.ok(summaryOf("main.go").imports.includes("fmt"), "go import");
  assert.ok(summaryOf("main.go").classes.includes("Server"), "go type");
  assert.ok(summaryOf("lib.rs").imports.some((item) => item.startsWith("std::")), "rust use");
  assert.ok(summaryOf("lib.rs").functions.includes("open"), "rust fn");
  assert.ok(summaryOf("App.java").classes.includes("App"), "java class");
  assert.ok(summaryOf("App.java").imports.includes("java.util.List"), "java import");
  assert.ok(summaryOf("Program.cs").classes.includes("Program"), "csharp class");
  assert.ok(summaryOf("Program.cs").imports.includes("System"), "csharp using");
  assert.ok(summaryOf("task.rb").classes.includes("Task"), "ruby class");
  assert.ok(summaryOf("task.rb").imports.includes("json"), "ruby require");
  assert.ok(summaryOf("index.php").classes.includes("Controller"), "php class");
});
