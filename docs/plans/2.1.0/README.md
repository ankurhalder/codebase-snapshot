# 2.1.0 — Multi-project support and an interactive setup

Status: **planning** · Branch `feat/2.1.0` · Target: 2.1.0 (minor, additive)

---

## First, a correction that changes the scope

The premise "we only support TypeScript projects" is half right, and the half that's
wrong is important — it decides how much work 2.1.0 actually is.

**Already language-agnostic today.** A Django or Go repo run through the current
CLI gets a complete, *safe* snapshot: git-aware discovery, `.gitignore` handling,
the credential deny list (`.env`, `*.pem`, `.ssh/`, `.tfstate`, …), all 21
redaction rules, byte-bounded parts, navigation, tree, audit, manifest, and full
drift validation. None of that knows what language it is looking at.

**What is actually TypeScript-only:**

| Capability | Today | Why |
| :--- | :--- | :--- |
| Structural summaries | `.ts .tsx .js .jsx .mts .cts .mjs .cjs` only | Uses the real TypeScript compiler API |
| JSON / Markdown summaries | Any repo | `JSON.parse` and heading regexes are generic |
| `manifest.indexes` (routes, components, hooks, handlers, directives) | TS/JS only | Derived from the AST summaries |
| Presets | `nextjs`, `vite`, `node`, `default` | Detection is JS-ecosystem oriented |
| Language *tagging* | 41 extensions already | `detectLanguage` is broad |

So a Python file is already scanned, redacted, budgeted, chunked and validated —
it just arrives with no structural summary and lands in the `default` preset's
buckets.

**The real gap is structure + presets + developer experience, not basic support.**
That is what 2.1.0 should close.

---

## The four pillars

### 1. Structural summaries for the top ecosystems

New `LanguageProfile` registry. Each profile maps extensions to a *heuristic*
summarizer that extracts imports, exports, declarations and types from line
patterns.

| Language | Extracts |
| :--- | :--- |
| Python | `import` / `from … import`, `class`, `def` / `async def`, module constants |
| Go | `package`, `import` blocks, `func`, `type … struct/interface`, `var`/`const` |
| Rust | `use`, `fn`, `struct`/`enum`/`trait`/`impl`, `pub` visibility |
| Java / Kotlin / Scala | `package`, `import`, `class`/`interface`/`enum`/`record`, methods |
| C# | `using`, `namespace`, `class`/`interface`/`struct`/`record` |
| PHP | `namespace`, `use`, `function`, `class`/`interface`/`trait` |
| Ruby | `require`, `class`/`module`, `def` |
| C / C++ | `#include`, function definitions, `struct`/`class`/`enum` |

**Honesty requirement.** These are not parsers. TypeScript keeps the real
compiler; every other language is pattern-matched, and the manifest must say so:

```ts
summary?: SourceSummary | JsonSummary | MarkdownSummary;
summaryQuality?: "ast" | "heuristic";   // new
```

`parts/*.md` renders `- Summary Quality: heuristic` so nobody mistakes a
line-scan for a parse. No new runtime dependency — this stays regex-based.

### 2. A preset for every common project shape

Expand from 4 presets to **25** — 21 project types plus 4 repository shapes —
each with detection signals, layers, kinds and a recommended budget. Full table
in [project-matrix.md](project-matrix.md).

Detection stays **first-match-wins** but becomes ordered by specificity:
framework preset → runtime preset → language preset → `generic`.

Two new override surfaces so a wrong guess is never a dead end:

```js
export default {
  preset: "python-fastapi",   // force it, skip detection
  // or
  extendsPreset: false,       // no preset at all; only my layers/kinds
};
```

### 3. Interactive setup — the `create-*` experience

```bash
npm create codebase-snapshot@latest
# or
npx @ankurhalder/codebase-snapshot init
```

Auto-detects the project, shows what it found, lets the developer confirm or pick
from **every** available type, then walks every tunable parameter. Ends with a
review screen and a written `snapshot.config.mjs` plus npm scripts.

**The generated config lists every setting at its default, commented and
grouped** — not just the ones the developer changed. Most people never read
documentation; a config that only records differences cannot tell them what else
exists. The file becomes the reference, and deleting any line is safe.
`--minimal` writes the terse version for those who want it.

Full screen-by-screen flow in [wizard-ux.md](wizard-ux.md).

### 4. Non-interactive parity

Every wizard answer has a flag, so CI and scripted setup never need a TTY:

```bash
npx @ankurhalder/codebase-snapshot init --preset react-vite --yes
```

---

## Milestones

| # | Milestone | Acceptance |
| :-- | :--- | :--- |
| M1 | Language profiles + heuristic summarizers | Fixtures per language produce expected imports/exports/declarations; `summaryQuality: "heuristic"` present; TS still reports `"ast"` |
| M2 | Preset registry expansion | 25 presets, detection fixture per ecosystem, `preset` override honoured, `layersMode`/`extendsPreset` interact correctly |
| M3 | Prompt toolkit (zero dependency) | Arrow-key select, multiselect, confirm, text input, all driven by `node:readline` in raw mode; works on Windows + POSIX |
| M4 | `init` wizard + `npm create` package | Wizard writes a config the loader can read back; non-TTY falls back to flags/`--yes`; `create-codebase-snapshot` publishes alongside |
| M5 | Docs + release | `docs/configuration.md` updated, README quick start, 2.1.0 tagged and published |

Each milestone lands with its own tests; the branch stays green between them.

---

## Technical design

### Language profile registry — `src/ast/profiles/`

```ts
export interface LanguageProfile {
  readonly id: string;                      // "python"
  readonly extensions: readonly string[];
  readonly summarizer?: (path: string, content: string) => SourceSummary;
}

export function summarizeWithProfile(path: string, content: string): {
  summary: SourceSummary;
  quality: "ast" | "heuristic";
} | null;
```

`src/index.ts` `summarizeFile()` currently dispatches on extension; it becomes a
registry lookup, with TypeScript keeping its special case.

### Preset registry — `src/presets/registry.ts`

```ts
export interface PresetDefinition {
  readonly name: string;
  readonly priority: number;                // higher wins
  readonly detect: (context: PresetContext) => boolean;
  readonly layers: LayerRule[];
  readonly kinds: KindRule[];
  readonly budget?: ByteSize;               // recommended, not enforced
  readonly exclude?: string[];              // e.g. Python's __pycache__, .venv
}
```

`PresetContext` carries `packageJson`, `topLevelFiles`, `topLevelDirs`, and
`lockfiles` — read once, shared by all detectors. Today each detector re-reads
`package.json`; that goes away.

### Prompt toolkit — `src/wizard/prompts.ts`

Zero dependency, `node:readline` in raw mode. Building blocks:

- `select(message, choices, { default })`
- `multiSelect(message, choices, { defaults })`
- `confirm(message, { default })`
- `text(message, { default, validate })`

The same toolkit powers `init` and the `create-*` package, so there is exactly
one prompt implementation to test and to keep working on Windows terminals.

### `create-codebase-snapshot` package

Thin bin that shells into the same wizard, published from a `packages/create/`
workspace. Keeps the core package free of scaffolding concerns, and gives the
`npm create` convention its own entry point.

### Config generation

The wizard emits a **commented** `snapshot.config.mjs` — the file is the
documentation. Only non-default values are written, so a 30-question wizard does
not produce a 30-line config:

```js
import { defineConfig } from "@ankurhalder/codebase-snapshot";

export default defineConfig({
  preset: "react-vite",
  maxPartBytes: "120k",
  include: ["src/**"],
  excludePatterns: ["**/*.test.tsx"],
  artifacts: { projectTree: false },
});
```

---

## Decisions I need from you

1. **Prompt library.** Build the zero-dependency toolkit (keeps "one runtime
   dependency" true, ~350 lines to own and test), or add `@clack/prompts` to the
   `create-*` package only? Recommendation: **own it** — it is the same code path
   either way, and a scaffold tool that fails on an odd terminal is a bad first
   impression.
2. **`init` behaviour change.** Make `init` interactive by default when attached
   to a TTY (with `--yes`/`--non-interactive` for the old behaviour)? This is the
   `create-next-app` convention. Recommendation: **yes**, TTY-gated.
3. **Separate `create-*` package**, or keep `npm create` as a thin alias for
   `init`? A separate package is the convention but adds a second publish target.
   Recommendation: **separate**, so `npm create` stays a one-liner.
4. **How far to go on languages.** The 8 in pillar 1 cover the overwhelming
   majority. Adding Elixir/Swift/Dart/Lua/R is cheap per language (~40 lines) but
   each needs a fixture. Recommendation: **ship 8, leave the registry open.**

---

## Risks

| Risk | Mitigation |
| :--- | :--- |
| Heuristic summaries produce wrong symbols | Label as `heuristic`, never mix with `ast`, fixture every language |
| 18 presets fight each other and misfire | Explicit priority ordering + a detection fixture per ecosystem in CI |
| Wizard breaks on Windows terminals | Same raw-mode code tested on all three CI OSes; non-TTY fallback always exists |
| Config drift from a wrong preset guess | `preset` override + `validate` already reports recorded config |
| Scope creep into being a language server | Hard non-goal: no tree-sitter, no LSP, no type checking |
