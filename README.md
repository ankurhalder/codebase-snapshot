# @ankurhalder/codebase-snapshot

> LLM codebase snapshot generator, auditor, and AST partitioner for modern full-stack repositories.

[![npm version](https://img.shields.io/npm/v/@ankurhalder/codebase-snapshot.svg)](https://www.npmjs.com/package/@ankurhalder/codebase-snapshot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`@ankurhalder/codebase-snapshot` inspects your codebase, redacts sensitive credentials, parses TypeScript
AST structures, and partitions your repository into **hard byte-bounded**, LLM-ready markdown chunks
(`parts/part-XXX.md`) accompanied by navigation indexes, a directory tree, and a health audit.

---

## ⚡ Set up a repository

```bash
npm create codebase-snapshot
```

Detects the project type, asks a handful of questions with real defaults, and
writes a `snapshot.config.mjs` that lists **every setting at its default** — so
the config doubles as the documentation. Works for 25 project shapes including
Next.js, Nuxt, SvelteKit, Astro, Vue, React, NestJS, Django, FastAPI, Go, Rust,
Java, .NET, PHP, Ruby, monorepos and infra repos.

Non-interactive, with every answer as a flag:

```bash
npx @ankurhalder/codebase-snapshot init --preset react-vite --max-part-bytes 120k --yes
```

---

## ✨ Features

- **25 project presets** — detection reads the repository once and picks the most
  specific match: Next.js, Nuxt, SvelteKit, Remix, Astro, Angular, Solid, Vue,
  React, NestJS, Express/ Fastify, Python (Django / FastAPI / library), Go, Rust,
  Java/Spring, .NET, Laravel, Rails, monorepos, infra and docs.
- **Structural summaries beyond TypeScript** — imports, declarations and exports
  for Python, Go, Rust, Java/Kotlin/Scala, C#, PHP, Ruby and C/C++, plus the
  script block of Vue/Svelte/Astro components through the real TypeScript
  compiler. Every summary is labelled `ast`, `structural` or `heuristic`.
- **Interactive setup** — `npm create codebase-snapshot` walks every tunable
  parameter and writes a self-documenting config.
- **Per-ecosystem ignores** — `__pycache__`, `.venv`, `target`, `.gradle`,
  `bin`/`obj`, `vendor`, `.svelte-kit` and friends are recognised per preset.
- **Hard byte budgeting** — every `part-XXX.md` is guaranteed to stay under `maxPartBytes`. A single
  oversized file is byte-truncated and marked rather than emitted whole.
- **Bounded redaction** — masks only the matched span (not the whole line), and masks multi-line PEM
  private keys as a block. **No excerpt of a matched line is ever written to any artifact.**
- **Credential files are skipped by default** — `.env`, `*.pem`, `*.key`, `.npmrc`, `.netrc`,
  `.git-credentials`, `id_rsa`, `.kube/config`, `*.tfstate`, … Opt back in with `includeSensitiveFiles`.
- **TypeScript AST extraction** — directives, imports, exports (including `export *` and anonymous
  defaults), functions, classes, interfaces, types, enums, components, hooks, and route handlers.
- **Structured summaries** — JSON key shapes and Markdown headings, computed from redacted text.
- **Zero-config presets** — auto-detects Next.js, Vite, Node/Express/Nest, and plain TypeScript.
- **Real integrity validation** — verifies source hashes, every emitted `parts/*.md` against its recorded
  `byteSize`/`sha256`, monolith artifacts, and the recorded configuration.
- **Safe output swapping** — the previous snapshot survives until the new one is fully in place, and
  destructive `outDir`/`tmpDir` combinations are refused.
- **CLI & programmatic API** — `npx`, ESM, and CJS.

---

## 🚀 Quick Start

```bash
npx @ankurhalder/codebase-snapshot generate
```

Or install it in your project. Any npm-compatible client works — they all resolve the
same published package:

```bash
npm install -D @ankurhalder/codebase-snapshot
yarn add -D @ankurhalder/codebase-snapshot
pnpm add -D @ankurhalder/codebase-snapshot
bun add -d @ankurhalder/codebase-snapshot
```

```json
{
  "scripts": {
    "snapshot": "codebase-snapshot generate",
    "snapshot:validate": "codebase-snapshot validate"
  }
}
```

Requires **Node.js 18+**. Every client above is verified in CI, including yarn Berry with
strict PnP. See [docs/install.md](docs/install.md) for global installs, version pinning,
and troubleshooting.

---

## 🛠️ CLI

```bash
codebase-snapshot [command] [options]
snap [command] [options]
```

Every option accepts both `--opt value` and `--opt=value`. Human-readable progress goes to **stderr**;
payloads (`--format json`) go to **stdout**, so the output is safe to pipe into `jq`.

### Commands

| Command | Description |
| :--- | :--- |
| `generate` *(default)* | Generates snapshot parts, reports, tree, and manifest |
| `validate`, `check` | Verifies snapshot integrity against disk and against the recorded config |
| `init` | Creates a starter `snapshot.config.ts` (or `.mjs` on Node < 22.6) |
| `report` | Prints metrics and health audits |
| `explain <path>` | Explains how one path is treated: layer, kind, part, or why it was skipped |
| `diff <a> <b>` | Compares two snapshots file by file |

See [docs/configuration.md](docs/configuration.md) for the full option reference.

### Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `--cwd <path>` | Target repository directory | `process.cwd()` |
| `--out-dir <path>` | Snapshot output directory | `snapshot` |
| `--include-monolith` | Also write `full-codebase.json` & `full-codebase.md` | `false` |
| `--max-monolith-bytes <n>` | Skip monolith artifacts above this size | unlimited |
| `--max-part-bytes <n>` | Hard byte budget per markdown part (min `4096`). Accepts units: `120k`, `1.5mb` | `307200` (300 KB) |
| `--large-file-bytes <n>` | Threshold for head/tail preview truncation. Accepts units | `204800` (200 KB) |
| `--include-sensitive-files` | Emit credential-bearing files (skipped by default) | `false` |
| `--skip-artifacts <names>` | Omit artifacts, comma-separated: `readme`, `manifest`, `parts`, `navigation`, `projectTree`, `audit`, `monolith` | everything on |
| `--only-artifacts <names>` | Write *only* the named artifacts. Cannot be combined with `--skip-artifacts` | — |
| `--format <text\|json>` | Output format | `text` |
| `--dry-run` | Compute the snapshot and print the plan without writing | `false` |
| `--watch` | Re-generate whenever the repository changes | `false` |

### Exit codes

`0` success · `1` drift detected or generation failed · `2` usage error (unknown flag, bad number, …).

Unknown flags and unknown commands are **rejected**; they do not fall through to `generate`.

---

## ⚙️ Configuration

Run `npx @ankurhalder/codebase-snapshot init`. Supported filenames, in order:
`snapshot.config.ts`, `.js`, `.mjs`, `.cjs`, `.json`, `.snapshotrc.json`, `.snapshotrc`, and a `"snapshot"`
key in `package.json`.

> **Node note:** a `.ts` config is only importable natively from Node **22.6+**. `init` writes `.mjs`
> instead on older Node versions, and a config that cannot be loaded is reported on stderr rather than
> being silently ignored.

```typescript
import { defineConfig } from "@ankurhalder/codebase-snapshot";

export default defineConfig({
  branch: "main",
  outDir: "snapshot",
  maxPartBytes: 300 * 1024,
  largeFileBytes: 200 * 1024,
  previewHeadLines: 80,
  previewTailLines: 40,

  // Credential files are excluded unless you opt in:
  includeSensitiveFiles: false,

  // Every artifact is generated by default; switch individual ones off here.
  artifacts: {
    audit: false,        // skip reports/audit.md
    projectTree: false,  // skip reports/project-tree.md
  },

  // Allow-list: when non-empty, only matching files are candidates.
  include: ["src/**", "packages/*/src/**"],

  // Plain strings match a whole path segment sequence; globs are supported.
  excludePatterns: ["tests/fixtures", "**/*.lock", "**/__snapshots__/**"],

  // "src/app/**" matches src/app and below — not src/apple or src/application.
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
    // Strings are accepted here too (JSON configs can only express strings).
    customPatterns: [{ rule: "internal-corp-token", pattern: /CORP-[A-Z0-9]{32}/ }],
  },
});
```

### Scoping with `include` / `excludePatterns`

`include` is an allow-list: when it is non-empty, a file must match at least one
pattern to enter the snapshot. `excludePatterns` then narrows what survived.

```typescript
export default defineConfig({
  include: ["src/**"],                       // only src/, everything else is out
  excludePatterns: ["**/*.test.ts"],         // …minus tests
});
```

Both accept globs (`**`, `*`, `?`) or plain strings, where a plain string matches
a whole path segment sequence — `"docs"` matches `docs/a.md` and `src/docs/b.md`
but not `docsite/c.md`.

Files dropped by either list are recorded in `manifest.skipped` with
`reason: "excluded"` and the pattern that removed them, so an omission is always
explicable. The effective `include` list is written into
`manifest.config.include`, so changing it later is reported as configuration
drift by `validate`.

### Choosing which artifacts to emit

Everything is written by default. Each artifact can be switched off without
affecting the others, from a config file (`artifacts`) or the CLI
(`--skip-artifacts audit,navigation`):

| Artifact | Default | Notes |
| :--- | :--- | :--- |
| `readme` | on | `README.md` orientation page |
| `manifest` | on | `manifest.json` — **off breaks `validate` and `report`** |
| `parts` | on | `parts/part-XXX.md`, the code payload itself |
| `navigation` | on | `reports/navigation.md` — dangles if `parts` is off |
| `projectTree` | on | `reports/project-tree.md` |
| `audit` | on | `reports/audit.md` |
| `monolith` | off | `full-codebase.{json,md}`; also set by `includeMonolith` |

```typescript
export default defineConfig({
  // Reports only — a security/health pass with no code payload:
  artifacts: { parts: false, navigation: false },
});
```

Unknown artifact names are **rejected**, not ignored, so a typo cannot quietly
leave something enabled. Combinations that produce an unusable snapshot (a
disabled manifest, or navigation without parts) are recorded in
`manifest.warnings`. The selection is written into `manifest.config.artifacts`,
so changing it later is reported as configuration drift by `validate`.

### Redaction behaviour

- Only the matched substring is replaced; the rest of the line survives.
- Multi-line `-----BEGIN … PRIVATE KEY-----` blocks are masked as a whole, including keys that were
  cut off before their `END` marker.
- A rule supplied with the `/g` flag is compiled without it, so it cannot skip every other line.
- `reports/audit.md` lists *where* secrets were found (file, line, rule) and never reproduces the value.

---

## 📦 Programmatic API

```typescript
import { generateSnapshot, resolveConfig, validateSnapshot } from "@ankurhalder/codebase-snapshot";

// `generateSnapshot` is synchronous — it does blocking file I/O by design.
// (`generateSnapshotAsync` is provided if you prefer an async call site.)
const config = resolveConfig({ cwd: process.cwd() }, { maxPartBytes: 300 * 1024 });
const manifest = generateSnapshot(config);

console.log(`Generated ${manifest.counts.partsCount} parts for ${manifest.counts.totalFiles} files.`);
console.log(`Integrity: ${manifest.validation.status}`);

// Dry run: compute everything, write nothing.
const plan = generateSnapshot(config, { dryRun: true });

// Validate against disk
const validation = validateSnapshot(config);
if (!validation.valid) {
  console.error("Drift detected:", validation.errors);
  console.error(validation.drift);           // hashMismatches, partIssues, configMismatches, …
}
```

`resolveConfig(userConfig, cliOptions?, baseDir?)` brands its result; `isResolvedConfig(value)` lets you
check for it, and `generateSnapshot`/`validateSnapshot` accept either a resolved config or a plain
`SnapshotConfig`.

---

## 📁 Snapshot Output

```text
snapshot/
├── README.md                 # Overview for LLMs and developers
├── manifest.json             # Machine-readable metadata and AST registry
├── parts/
│   ├── part-001.md           # Byte-bounded chunks with anchored code blocks
│   └── ...
└── reports/
    ├── navigation.md         # File-to-part lookup index (anchors resolve)
    ├── project-tree.md       # ASCII repository hierarchy
    └── audit.md              # Security findings, layer distributions, large files
```

`manifest.json` records the effective configuration (budgets, preview sizes, excludes,
`includeSensitiveFiles`), so `validate` can detect configuration drift as well as code drift.
`manifest.validation.status` is computed from a real pre-write integrity pass (part digests, byte
budgets, file-to-part assignment) — it is not a constant.

---

## 🔄 Upgrading from 1.x

Version 2.0.0 contains breaking changes, all in service of correctness:

| Change | Reason |
| :--- | :--- |
| `generateSnapshot()` is synchronous | It never awaited anything; the `async` signature only promised concurrency it did not have. `await generateSnapshot(...)` still works; `generateSnapshotAsync` is available. |
| Manifest `schemaVersion` is `3.0.0` | The shape changed materially (below). |
| Removed duplicate fields: `path`, `bytes`, `sha256` (on entries), `PartMetadata.bytes`, `PartMetadata.files`, `contentFingerprint`, `generator.script` | Each was a permanent alias of a canonical field that could only ever agree. Use `relativePath`, `sizeBytes`, `hashSha256`, `byteSize`, `includedFiles[].relativePath`. |
| `totals.summaryOnlyFiles` → `totals.previewFiles` | The old name claimed more than the value meant. |
| `SecretFinding.snippet` removed | It carried the raw matched source line — the vector that leaked secrets into `reports/audit.md`. |
| Credential files skipped by default | A private key or registry token cannot be reliably masked by a regex; opt in with `includeSensitiveFiles`. |
| `monolithContent` option removed, `--force` removed | Never implemented / never read. |
| `dist/cli.js` is no longer the executable | The bin is now `dist/bin.js`; `./cli` is a side-effect-free module usable from both ESM and CJS. |

---

## 📄 License

MIT © [Ankur Halder](https://github.com/ankurhalder)
