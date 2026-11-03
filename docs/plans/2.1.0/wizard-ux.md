# Interactive setup — the `create-*` experience

The goal: a developer who has never heard of this package should be able to go
from "I have a repo" to "I have a snapshot" in under a minute, without reading
documentation, and still be able to reach every knob.

Two entry points, one wizard:

```bash
npm create codebase-snapshot@latest      # the familiar convention
npx @ankurhalder/codebase-snapshot init  # if the package is already installed
```

---

## Flow

```
Detect  →  Confirm type  →  Scope  →  Size  →  Artifacts  →  Safety  →  Review  →  Write
```

Detection is never silent: the wizard always *shows* what it found and lets the
developer override it. Seven questions with sensible defaults, so pressing
<kbd>Enter</kbd> through every screen produces a working config.

---

## Screen by screen

### 1 · Intro and detection

```
  @ankurhalder/codebase-snapshot v2.1.0

  Turn this repository into an LLM-ready, redacted, byte-bounded snapshot.

◇  Scanning… done
│
│  Detected   Next.js (app router)
│  Language   TypeScript
│  Package    pnpm workspace
│  Ignoring   node_modules, .next, dist, coverage
│
◆  Is this right?
│  ❯ Yes, set up for Next.js
│    Choose a different project type
│    Start from scratch
└
```

### 2 · Project type (only if they choose to change it)

Every available type is listed — nothing is hidden behind detection.

```
◆  What kind of project is this?   (↑↓ to move, enter to select)

│  ── Frontend ───────────────────────────────
│    Next.js
│    React + Vite
│    Vue + Vite
│    Nuxt
│    SvelteKit
│    Angular
│    Astro
│    Remix
│    Solid
│
│  ── Backend / Node ─────────────────────────
│    NestJS
│    Express / Fastify
│    Node library
│
│  ── Other languages ────────────────────────
│    Python · Django
│    Python · FastAPI / Flask
│    Python · library
│    Go
│    Rust
│    Java / Kotlin (Spring)
│    C# / .NET
│    PHP · Laravel
│    Ruby · Rails
│
│  ── Repository shapes ──────────────────────
│    Monorepo (workspaces)
│    Documentation
│    Infrastructure (Terraform / k8s)
│    Generic — just take everything
└
```

### 3 · Scope

```
◆  What should go into the snapshot?

│  ❯ Everything the scanner finds          (recommended — respects .gitignore)
│    Only specific folders…
│    Everything, but skip tests
│    Let me write glob patterns
└
```

Choosing *specific folders* shows a multi-select of real top-level directories
read from disk, not invented ones:

```
◆  Select folders
│  ◼ app/
│  ◼ src/
│  ◻ scripts/
│  ◻ docs/
│  ◻ tests/
└
```

### 4 · Part size

Sizes are described in **tokens**, because that is what the developer is
actually reasoning about.

```
◆  How large should each part be?

│    Small    60 KB    ~15k tokens   tight context windows, many parts
│  ❯ Medium  120 KB    ~30k tokens   recommended for most models
│    Large   300 KB    ~75k tokens   fewer, bigger parts (default)
│    Custom…
└
```

Choosing *Custom* accepts `150k`, `1.5mb` or raw bytes, validated immediately —
the same parser the CLI uses.

### 5 · Artifacts

```
◆  Which artifacts should be generated?   (space to toggle, enter to confirm)

│  ◼ README.md                       orientation page
│  ◼ manifest.json                   machine-readable registry
│  ◼ parts/                          the code payload
│  ◼ reports/navigation.md           file → part index
│  ◼ reports/project-tree.md         ASCII tree
│  ◼ reports/audit.md                security + health findings
│  ◻ full-codebase.json / .md        one big file (roughly doubles output)
└
```

### 6 · Safety

```
◆  Include credential files (.env, *.pem, .npmrc, .ssh/)?

│  ❯ No — skip them                    (recommended)
│    Yes, include them
└

✔  All 21 secret patterns stay active. Matched values are masked in place and
   never reproduced in any report.
```

### 7 · Review

```
  Review

  project          nextjs
  include          src/, app/
  part size        120 KB  (~30k tokens)
  artifacts        README, manifest, parts, navigation, audit (5 of 7)
  credentials      skipped
  excludes         .next, node_modules, coverage, **/*.test.tsx

  ┌ snapshot.config.mjs ─────────────────────────────────┐
  │ import { defineConfig } from                         │
  │   "@ankurhalder/codebase-snapshot";                  │
  │                                                      │
  │ export default defineConfig({                        │
  │   preset: "nextjs",                                  │
  │   maxPartBytes: "120k",                              │
  │   include: ["src/**", "app/**"],                     │
  │   excludePatterns: ["**/*.test.tsx"],                │
  │   artifacts: { projectTree: false, monolith: false },│
  │ });                                                  │
  └──────────────────────────────────────────────────────┘

◆  Write this and continue?
│  ❯ Yes
│    Go back and change something
│    Cancel
└
```

### 8 · Done

```
  ✓ Created snapshot.config.mjs
  ✓ Added npm scripts: snapshot, snapshot:validate
  ✓ Added snapshot/ and snapshot.tmp/ to .gitignore

◆  Generate the first snapshot now?
│  ❯ Yes
│    Not now
└

  ✓ 847 files · 6 parts · integrity passed · 1.2s

  Next:
    npm run snapshot           regenerate
    npm run snapshot:validate  check the snapshot is still current
    npx ... explain <path>     why is this file (not) included?
```

---

## Non-interactive parity

Every answer has a flag. Two rules:

- **No TTY** (CI, piping, `CI=1`) → never prompt, use flags and defaults, print
  what it decided.
- **`--yes`** → accept all defaults, write the config, do not generate.

```bash
snap init --preset nextjs --yes
snap init --preset go --max-part-bytes 200k --include "cmd/**,internal/**"
snap init --preset react-vite --no-artifacts projectTree,monolith
snap init --preset generic --dry-run          # print the config, write nothing
```

| Flag | Equivalent question |
| :--- | :--- |
| `--preset <name>` | project type |
| `--include <globs>` / `--exclude <globs>` | scope |
| `--max-part-bytes <size>` | part size |
| `--skip-artifacts` / `--only-artifacts` | artifacts |
| `--include-sensitive-files` | safety |
| `--dry-run` | print instead of write |
| `--yes`, `--non-interactive` | skip every prompt |

---

## Edge cases

| Situation | Behaviour |
| :--- | :--- |
| `snapshot.config.*` already exists | Refuse to overwrite; offer `--force` to replace, print a diff of what would change |
| No `package.json` (Python, Go, Ruby repo) | Fully supported — scripts are skipped, config is still written, message says so |
| No git repository | Works; detection falls back to directory inspection and says git was not found |
| Not a TTY | Wizard is skipped entirely, flags/defaults used, decisions printed |
| Unknown `--preset` value | Usage error listing every valid preset (exit 2) |
| Detection is wrong | Screen 1 always offers "Choose a different project type" |
| Terminal too narrow (< 60 cols) | Lists degrade to a simple numbered prompt |

---

## What the wizard writes

Three things, all reversible, each reported on the done screen:

1. **`snapshot.config.mjs`** — commented, and containing *only non-default
   values*, so it stays readable as the project grows.
2. **`package.json` scripts** — `snapshot` and `snapshot:validate`, skipped if
   the keys already exist (never silently overwritten).
3. **`.gitignore` entries** — `snapshot/` and `snapshot.tmp/`, appended only if
   absent.

Nothing else is touched: no lockfile rewrite, no dependency added, no existing
file modified without saying so.

---

## Why this shape

- **Detection is a suggestion, not a decision.** The single most common complaint
  about scaffolders is a wrong guess the user cannot see or fix.
- **Defaults are real defaults.** Eight screens of questions is a lot; pressing
  Enter eight times must produce a good snapshot.
- **The generated config is the documentation.** Each line the wizard writes is
  explained on screen, so editing it later needs no lookup.
- **Every prompt has a flag.** A wizard that only works interactively is a
  wizard that breaks in CI.
