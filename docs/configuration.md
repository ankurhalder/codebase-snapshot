# Configuration reference

Everything `@ankurhalder/codebase-snapshot` can be told to do, in one place.

```bash
npx @ankurhalder/codebase-snapshot init     # writes a starter config
```

Config files are resolved in this order, first match wins:

`snapshot.config.ts` → `.js` → `.mjs` → `.cjs` → `.json` → `.snapshotrc.json` → `.snapshotrc` → `"snapshot"` in `package.json`.

> A `.ts` config is only importable natively from Node **22.6+**. `init` writes `.mjs` on older Node, and an unloadable config is reported on stderr rather than ignored.

---

## Scoping: which files get in

```javascript
export default {
  include: ["src/**", "packages/*/src/**"],   // allow-list, empty = everything
  excludePatterns: ["**/*.test.ts", "docs"],  // narrows what include let through
};
```

`include` runs first, `excludePatterns` narrows the survivors. Both accept globs
(`**`, `*`, `?`, `{a,b}`, `[abc]`) or plain strings; a plain string matches a
whole path segment sequence, so `"docs"` matches `docs/a.md` and `src/docs/b.md`
but not `docsite/c.md`.

Every dropped file is recorded in `manifest.skipped` with `reason` and the exact
pattern responsible (`excluded`, `default-ignore`, `sensitive-file`, `binary`,
`symlink`, `read-error`, `not-file`).

```javascript
export default {
  includeSensitiveFiles: false,   // .env, *.pem, .npmrc, .ssh/, .tfstate …
};
```

## Classification: layers and kinds

```javascript
export default {
  layersMode: "merge",   // default: your rules first, then the preset's
  layers: [
    { name: "billing", match: "src/features/billing/**" },
    { name: "legacy", match: (p) => p.includes(".legacy.") },
  ],
  kinds: [
    { kind: "route", match: /(^|\/)route\.tsx?$/ },
    { kind: "hook", match: "src/hooks/**" },
  ],
};
```

Rules are evaluated in order, **first match wins**, with an `other` fallback.
`match` may be a string, a `RegExp`, or a predicate function.

`layersMode: "merge"` (the default) keeps the detected preset's rules and lets
yours win by being evaluated first. `"replace"` discards the preset entirely.

Presets are auto-detected: **nextjs** → **vite** → **node** → **default**.

## Sizing: byte budgets

```javascript
export default {
  maxPartBytes: "120k",      // hard ceiling per part; default 300 KB, min 4096 B
  largeFileBytes: "200k",    // above this a file gets a head/tail preview
  previewHeadLines: 80,
  previewTailLines: 40,

  budgets: {                 // optional per-layer overrides
    default: "120k",
    byLayer: { docs: 40_000, core: 300_000 },
  },
};
```

Budgets accept raw bytes (`122880`) or human sizes (`"120k"`, `"1.5mb"`, `"2 GB"`).
Anything unparseable is an error rather than a silent fallback to the default.

Files under different budgets are partitioned separately and the resulting parts
are re-numbered, so filenames and `Previous:`/`Next:` links stay correct.

## Artifacts: what gets written

Everything is on by default. Each artifact can be switched off independently —
`artifacts` in config, or `--skip-artifacts` / `--only-artifacts` on the CLI.

| Artifact | Default | File |
| :--- | :--- | :--- |
| `readme` | on | `README.md` |
| `manifest` | on | `manifest.json` — **off breaks `validate` and `report`** |
| `parts` | on | `parts/part-XXX.md` |
| `navigation` | on | `reports/navigation.md` — dangles if `parts` is off |
| `projectTree` | on | `reports/project-tree.md` |
| `audit` | on | `reports/audit.md` |
| `monolith` | off | `full-codebase.{json,md}` |

```javascript
export default {
  artifacts: { parts: false, navigation: false },   // reports-only pass
  includeMonolith: false,
  maxMonolithBytes: null,
};
```

Unknown artifact names are rejected, not ignored. The selection is recorded in
`manifest.config.artifacts`, so changing it later shows up as config drift.

The monolith is built from the **pre-partition** contents, so it holds the whole
file even when a part had to truncate it.

## Secrets: redaction rules

21 built-in rules cover PEM keys, JWT, AWS, GitHub, Slack, Stripe, Google,
OpenAI/Anthropic, npm, PyPI, SendGrid, Twilio, DigitalOcean, Azure, database
URIs, basic-auth URLs and `.env`-style assignments.

```javascript
export default {
  secrets: {
    customPatterns: [
      { rule: "internal-token", pattern: /CORP-[A-Z0-9]{32}/ },
      { rule: "from-json", pattern: "ACME_[a-z0-9]{10}" },   // strings allowed
    ],
    disableDefaultPatterns: false,
  },
};
```

Only the matched span is replaced; the rest of the line survives. Multi-line PEM
blocks are masked as a block, including ones cut off before their `END` marker.
No excerpt of a matched line is ever written to any artifact.

## Output layout

```javascript
export default {
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
  branch: "main",   // fallback when git cannot report one
};
```

`outDir` may not be the working directory, an ancestor, or the filesystem root,
and `outDir`/`tmpDir` may not contain each other. Writes are atomic: the previous
snapshot survives until the new one is fully in place.

## Hooks

```javascript
export default {
  hooks: {
    afterGenerate: (manifest) => {
      // runs after a successful generate (and after a dry run)
    },
  },
};
```

A throwing hook becomes a warning on the manifest — it never loses a snapshot
that was already written.

---

# Commands

| Command | Purpose |
| :--- | :--- |
| `generate` *(default)* | Write the snapshot |
| `validate`, `check` | Re-hash sources and parts, compare config, detect drift |
| `report` | Print metrics, layer distribution and drift status |
| `explain <path>` | Show how one path would be treated |
| `diff <a> <b>` | Compare two snapshots |
| `init` | Write a starter config |

## `explain`

```
$ snap explain src/app/page.tsx

src/app/page.tsx

  included   yes
  layer      app   (rule (p) => p.startsWith("src/app/") || ...)
  kind       component   (rule (p) => { const base = p.split("/").pop() ...)
  language   tsx
  size       48 B, 1 line(s)
  part       part-001.md
  inclusion  full
  secrets    none
```

Excluded paths say why:

```
$ snap explain .env

.env

  included   no
  reason     sensitive-file
  detail     credential-bearing file; enable includeSensitiveFiles to emit it
```

Exits `0` when the path is included, `1` when it is not. `--format json` emits the
same data as an object.

## `diff`

```
$ snap diff old-snapshot new-snapshot

before  2026-11-03T10:00:00.000Z  812 file(s), 4 part(s)
after   2026-11-03T11:30:00.000Z  820 file(s), 4 part(s)

  + 9 added
  - 1 removed
  ~ 3 changed
  = 808 unchanged
```

Both arguments may be snapshot directories or paths to a `manifest.json`.

## `--watch`

```bash
npx @ankurhalder/codebase-snapshot generate --watch
```

Re-generates on every change, ignoring writes into the output and temporary
directories (including the atomic-swap backup) so it cannot trigger itself.

---

# Drift

`validate` compares five things: source hashes on disk, the emitted parts (size
and SHA-256), the manifest's own bookkeeping, the recorded configuration
(budgets, includes, excludes, artifacts, layers mode), and git state. Changing a
config value without re-generating is reported as drift, not silently accepted.
