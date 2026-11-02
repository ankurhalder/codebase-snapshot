import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { summarizeJson, summarizeMarkdown } from "../dist/index.js";
import { summarizeTypeScriptSource } from "../dist/index.js";
import { scanAndRedactSecrets } from "../dist/index.js";
import { DEFAULT_SECRET_PATTERNS } from "../dist/index.js";
import { detectLanguage } from "../dist/index.js";
import { isBinaryExtension, isBinaryBuffer } from "../dist/index.js";
import { truncatePreview } from "../dist/index.js";
import { partitionFiles } from "../dist/index.js";
import { generateProjectTree } from "../dist/index.js";
import { generateSnapshot, validateSnapshot } from "../dist/index.js";

test("detectLanguage identifies language from extension and basename", () => {
  assert.equal(detectLanguage("src/app/page.tsx"), "tsx");
  assert.equal(detectLanguage("src/lib/utils.ts"), "typescript");
  assert.equal(detectLanguage("package.json"), "json");
  assert.equal(detectLanguage("README.md"), "markdown");
  assert.equal(detectLanguage("Dockerfile"), "dockerfile");
  assert.equal(detectLanguage(".env.local"), "bash");
});

test("isBinary checks accurately identify binary extensions and buffers", () => {
  assert.equal(isBinaryExtension("image.png"), true);
  assert.equal(isBinaryExtension("font.woff2"), true);
  assert.equal(isBinaryExtension("code.ts"), false);

  const textBuffer = Buffer.from("Hello world\nThis is clean text.");
  assert.equal(isBinaryBuffer(textBuffer), false);

  const binBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
  assert.equal(isBinaryBuffer(binBuffer), true);
});

test("scanAndRedactSecrets redacts sensitive credentials and logs findings", () => {
  const code = [
    'const apiKey = "AKIAIOSFODNN7EXAMPLE";',
    'const db = "mongodb+srv://user:pass12345@cluster.mongodb.net/prod";',
    'const normalVar = "hello-world";',
  ].join("\n");

  const { redacted, findings } = scanAndRedactSecrets(code, DEFAULT_SECRET_PATTERNS, "test.ts");

  assert.ok(findings.length >= 2);
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes("aws-access-key-id"));
  assert.ok(rules.includes("database-uri-credentials"));
  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!redacted.includes("pass12345"));
  assert.ok(redacted.includes("normalVar"));
});

test("summarizeTypeScriptSource extracts AST declarations and metrics", () => {
  const tsCode = `
    "use client";
    import { useState } from "react";
    import type { User } from "./types";

    export interface Props {
      id: string;
    }

    export type Status = "active" | "idle";

    export function useCounter() {
      return useState(0);
    }

    export function UserCard(props: Props) {
      return null;
    }

    export async function GET(req: Request) {
      return new Response("ok");
    }
  `;

  const summary = summarizeTypeScriptSource("src/test.tsx", tsCode);

  assert.deepEqual(summary.directives, ["use client"]);
  assert.ok(summary.imports.includes("react"));
  assert.ok(summary.interfaces.includes("Props"));
  assert.ok(summary.types.includes("Status"));
  assert.ok(summary.hooks.includes("useCounter"));
  assert.ok(summary.reactComponents.includes("UserCard"));
  assert.ok(summary.routeHandlers.includes("GET"));
});

test("summarizeJson and summarizeMarkdown extract structured summaries", () => {
  const jsonSummary = summarizeJson('{"name": "app", "version": "1.0.0", "scripts": {}}');
  assert.equal(jsonSummary.shape, "object");
  assert.equal(jsonSummary.itemCount, 3);
  assert.ok(jsonSummary.keys.includes("name"));

  const mdSummary = summarizeMarkdown("# Title\n\n## Subtitle\n\nContent");
  assert.equal(mdSummary.headings.length, 2);
  assert.equal(mdSummary.headings[0], "# Title");
  assert.equal(mdSummary.headings[1], "## Subtitle");
});

test("truncatePreview preserves head and tail and inserts omission marker", () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = truncatePreview(lines, 20, 10);

  assert.equal(result.isTruncated, true);
  assert.equal(result.originalLines, 150);
  assert.equal(result.includedLines, 31);
  assert.ok(result.content.startsWith("line 1\n"));
  assert.ok(result.content.endsWith("\nline 150"));
  assert.ok(result.content.includes("120 lines omitted"));
});

test("partitionFiles respects part byte budgets", () => {
  const files = [
    {
      relativePath: "file1.ts",
      sizeBytes: 1000,
      lines: 20,
      hashSha256: "abc",
      layer: "app",
      kind: "component",
      language: "typescript",
      inclusionMode: "full",
      isLarge: false,
      isPreviewTruncated: false,
      originalLines: 20,
      includedLines: 20,
      content: 'console.log("hello 1");',
    },
    {
      relativePath: "file2.ts",
      sizeBytes: 1000,
      lines: 20,
      hashSha256: "def",
      layer: "app",
      kind: "component",
      language: "typescript",
      inclusionMode: "full",
      isLarge: false,
      isPreviewTruncated: false,
      originalLines: 20,
      includedLines: 20,
      content: 'console.log("hello 2");',
    },
  ];

  const parts = partitionFiles(files, 50000);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].filename, "part-001.md");
  assert.equal(parts[0].metadata.fileCount, 2);
});

test("generateProjectTree formats ascii directory trees", () => {
  const tree = generateProjectTree(["src/app/page.tsx", "src/lib/utils.ts", "package.json"]);
  assert.ok(tree.includes("package.json"));
  assert.ok(tree.includes("src"));
  assert.ok(tree.includes("app"));
  assert.ok(tree.includes("page.tsx"));
});

test("generateSnapshot and validateSnapshot produce complete snapshots and pass integrity check", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  const srcDir = path.join(tmpDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "fixture-app" }));
  fs.writeFileSync(path.join(srcDir, "index.ts"), 'export const message = "hello world";\n');
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Fixture Readme\n");

  const manifest = await generateSnapshot({
    cwd: tmpDir,
    branch: "main",
    outDir: "snapshot",
    maxPartBytes: 100000,
    largeFileBytes: 50000,
  });

  assert.equal(manifest.counts.totalFiles, 3);
  assert.equal(manifest.parts.length, 1);

  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "manifest.json")));
  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "README.md")));
  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "parts", "part-001.md")));
  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "reports", "project-tree.md")));
  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "reports", "navigation.md")));
  assert.ok(fs.existsSync(path.join(tmpDir, "snapshot", "reports", "audit.md")));

  const validation = validateSnapshot({
    cwd: tmpDir,
    branch: "main",
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    maxPartBytes: 100000,
    largeFileBytes: 50000,
    previewHeadLines: 80,
    previewTailLines: 40,
    includeMonolith: false,
    monolithContent: "full",
    maxMonolithBytes: null,
    layers: [],
    kinds: [],
    excludePatterns: [],
    secretRules: [],
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
