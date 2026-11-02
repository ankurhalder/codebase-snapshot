# @ankurhalder/codebase-snapshot

> Production-grade LLM codebase snapshot generator, auditor, and AST partitioner for modern full-stack repositories.

[![npm version](https://img.shields.io/npm/v/@ankurhalder/codebase-snapshot.svg)](https://www.npmjs.com/package/@ankurhalder/codebase-snapshot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`@ankurhalder/codebase-snapshot` inspects your codebase, scans and redacts sensitive credentials, parses TypeScript AST structures, and partitions your repository into budget-capped, LLM-ready markdown chunks (`parts/part-XXX.md`) accompanied by complete navigation indexes, visual directory trees, and health audits.

---

## ✨ Features

- **LLM Context Budgeting**: Partitions codebases into bounded byte-size chunks (`part-001.md`, `part-002.md`) to prevent LLM context degradation.
- **Smart Head/Tail Preview**: Truncates oversized files with configurable head and tail windows while preserving structure.
- **Automated Secrets Redaction**: Scans for private keys, JWTs, AWS credentials, GitHub tokens, database URIs, and Stripe keys, redacting them before snapshots are emitted.
- **TypeScript AST Extraction**: Gathers directives (`"use client"`), imports, exports, functions, classes, interfaces, types, enums, React components, hooks, and route handlers.
- **Structured File Summaries**: Automatically parses JSON keys and Markdown headings for instant file comprehension.
- **Zero-Config Presets**: Auto-detects Next.js (App Router / Pages), Vite, Node/Express/Nest, and standard TypeScript projects.
- **Built-in Integrity Validator**: Detects code drift, outdated snapshots, missing files, and hash mismatches via SHA-256 integrity checks.
- **CLI & Programmatic API**: Use as an `npx` one-liner or import directly into Node/TypeScript pipelines.

---

## 🚀 Quick Start

### Run with `npx` (No installation needed)

```bash
npx @ankurhalder/codebase-snapshot generate
```

### Install as a Dev Dependency

```bash
npm install -D @ankurhalder/codebase-snapshot
# or
pnpm add -D @ankurhalder/codebase-snapshot
# or
yarn add -D @ankurhalder/codebase-snapshot
```

Add to your `package.json`:

```json
{
  "scripts": {
    "snapshot": "codebase-snapshot generate",
    "snapshot:validate": "codebase-snapshot validate"
  }
}
```

---

## 🛠️ CLI Commands & Options

```bash
codebase-snapshot [command] [options]
snap [command] [options]
```

### Commands

| Command | Description |
| :--- | :--- |
| `generate` *(default)* | Generates snapshot parts, reports, tree, and manifest |
| `validate`, `check` | Verifies snapshot integrity against disk; exits with code 1 on drift |
| `init` | Creates a starter `snapshot.config.ts` |
| `report` | Prints metrics and health audits |

### Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `--cwd <path>` | Target repository directory | `process.cwd()` |
| `--include-monolith` | Generates `full-codebase.json` & `full-codebase.md` | `false` |
| `--max-part-bytes <n>` | Max byte budget per markdown part | `307200` (300 KB) |
| `--large-file-bytes <n>`| Threshold for head/tail preview truncation | `204800` (200 KB) |
| `--format <text\|json>` | Output format | `text` |

---

## ⚙️ Configuration (`snapshot.config.ts`)

Run `npx @ankurhalder/codebase-snapshot init` to generate a config file:

```typescript
import { defineConfig } from "@ankurhalder/codebase-snapshot";

export default defineConfig({
  branch: "main",
  outDir: "snapshot",
  maxPartBytes: 300 * 1024,
  largeFileBytes: 200 * 1024,
  previewHeadLines: 80,
  previewTailLines: 40,
  excludePatterns: ["tests/fixtures"],
  layers: [
    { name: "app", match: "src/app/**" },
    { name: "features", match: "src/features/**" },
    { name: "shared", match: "src/shared/**" },
    { name: "scripts", match: "scripts/**" },
  ],
  kinds: [
    { kind: "route", match: (p) => p.includes("/api/") || p.endsWith("route.ts") },
    { kind: "component", match: (p) => p.endsWith(".tsx") },
    { kind: "hook", match: (p) => p.includes("/hooks/") },
  ],
  secrets: {
    customPatterns: [
      { rule: "internal-corp-token", pattern: /CORP-[A-Z0-9]{32}/ },
    ],
  },
});
```

---

## 📦 Programmatic API

```typescript
import {
  generateSnapshot,
  validateSnapshot,
  resolveConfig,
} from "@ankurhalder/codebase-snapshot";

// Generate snapshot programmatically
const manifest = await generateSnapshot({
  cwd: process.cwd(),
  maxPartBytes: 300 * 1024,
});

console.log(`Generated ${manifest.counts.partsCount} parts for ${manifest.counts.totalFiles} files.`);

// Validate snapshot on disk
const validation = validateSnapshot(resolveConfig(null, { cwd: process.cwd() }));
if (!validation.valid) {
  console.error("Drift detected:", validation.errors);
}
```

---

## 📁 Snapshot Output Structure

Running `codebase-snapshot generate` creates:

```text
snapshot/
├── README.md                 # Overview for LLMs and developers
├── manifest.json             # Machine-readable metadata and AST registry
├── parts/
│   ├── part-001.md           # Chunked markdown parts with code blocks
│   ├── part-002.md
│   └── ...
└── reports/
    ├── navigation.md         # File-to-part lookup index
    ├── project-tree.md       # Full ASCII repository hierarchy
    └── audit.md              # Security findings, layer distributions, large files
```

---

## 📄 License

MIT © [Ankur Halder](https://github.com/ankurhalder)

