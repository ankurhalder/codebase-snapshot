<div align="center">
  <img src="https://raw.githubusercontent.com/ankurhalder/codebase-snapshot/main/docs/assets/favicon.svg" width="64" height="64" alt="codebase-snapshot">

  <h1>codebase-snapshot</h1>

  <p><b>A snapshot you can prove is current.</b><br>
  Plain-text parts under a hard byte budget, an index of every file and every skipped<br>
  file with the reason, and a <code>validate</code> command that fails when the code moves.</p>

  <p>
    <a href="https://www.npmjs.com/package/codebase-snapshot"><img alt="npm version" src="https://img.shields.io/npm/v/codebase-snapshot.svg"></a>
    <a href="https://www.npmjs.com/package/codebase-snapshot"><img alt="weekly downloads" src="https://img.shields.io/npm/dw/codebase-snapshot.svg"></a>
    <a href="#license"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <a href="https://nodejs.org"><img alt="node: 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg"></a>
    <a href="https://ankurhalder.github.io/codebase-snapshot/"><img alt="documentation" src="https://img.shields.io/badge/docs-read-1a7f37"></a>
  </p>
</div>

```bash
snapshot                        # detects the project, sets it up, generates
npx codebase-snapshot generate  # or no install at all, straight to the snapshot
```

That writes `./snapshot/` — a directory you can drop into a chat, a prompt, a RAG pipeline or a
repository review. TypeScript and JavaScript first, but also Python, Go, Rust, Java/Kotlin,
C#/.NET, PHP, Ruby, C/C++, Vue, Svelte and Astro, without configuration.

![Two ways to give a repository to a model: a dump that was silently truncated, and a snapshot
with a manifest and a validator](https://raw.githubusercontent.com/ankurhalder/codebase-snapshot/main/docs/assets/how-it-works.svg)

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#built-to-be-trusted">Trust</a> ·
  <a href="#for-ai-agents">AI agents</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://ankurhalder.github.io/codebase-snapshot/">Site</a>
</p>

---

## Why

Feeding a real repository to a model is awkward: files are too big, context windows are too small,
and choosing what matters by hand neither scales nor repeats. This does it deterministically.

- **A hard ceiling, not a target.** `maxPartBytes` is a limit. A file bigger than the budget is cut
  with an explicit omission marker naming the budget, and above `largeFileBytes` it becomes a
  head/tail excerpt instead — nothing silently overflows the window you sized.
- **An index, not just text.** `manifest.json` lists every included file with its layer, kind,
  language, part, hash and a structural summary, and every *excluded* file with the reason.
- **Provably current.** `validate` re-hashes the repository against the snapshot and exits non-zero
  on any drift, so a pipeline can gate on the context being fresh.
- **Repeatable.** Two runs over unchanged input give byte-identical parts and the same
  `manifest.fingerprint`; only the artifacts that carry a timestamp, run id or pid differ.

## Install

```bash
npm install -g codebase-snapshot      # puts `snapshot` on your PATH
npx codebase-snapshot generate        # or no install at all, one-off
npm install -D codebase-snapshot      # or add it to a project
```

`codebase-snapshot` is the canonical name to script against; `snapshot` is the short command a
global install provides, and from a project dependency the same binary is `npx snapshot` or the
`npm run snapshot` script `init` writes.

Requires **Node.js 18+**. Any npm client works — npm, yarn (classic and Berry with strict PnP), pnpm
and bun. Published from GitHub Actions with [build
provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm audit signatures`
verifies the tarball came from this repository at a tagged commit.

This is a **<!--@major-->0<!--/@major-->.x** release: the CLI surface may still change in a minor
release until 1.0.0, so pin an exact version if you need a fixed surface today.

→ [Installation guide](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/install.md)

## Quick start

Type it. That is the whole first run.

```bash
snapshot
```

It recognises the project and says what it keyed on — `Detected nextjs` / `Because next.config.ts`
— then offers the recommended setup in one keystroke, or a walk through every setting with each
question starting on its default. Either way it writes the config, adds the npm scripts and the
devDependency, installs with your package manager, and generates. A project that already has a
config just generates.

Nothing to press — CI, a container, an agent:

```bash
npx codebase-snapshot --autopilot
```

**A first run never guesses.** With no terminal and no `--autopilot` it exits `2` and names the
three ways forward, because a snapshot built from settings nobody chose is a snapshot nobody can
check.

```bash
npx codebase-snapshot init --yes   # config + scripts + devDependency + .gitignore
npm install                        # the package, into node_modules
npm run snapshot                   # generate
npm run snapshot:validate          # exit 0 = current with disk
```

The fingerprint is printed in full — all 64 hex characters, never elided — and it is the same value
as `manifest.fingerprint`.

## What you get

```
snapshot/
├── README.md                  human summary of this snapshot
├── manifest.json              machine index: files, parts, hashes, config, skips
├── parts/part-001.md …        the code, grouped and size-budgeted
└── reports/
    ├── project-tree.md        directory tree of included files
    ├── navigation.md          links between layers, kinds and parts
    └── audit.md               secrets, large files, parse diagnostics, git state
```

Every artifact can be turned off (`--skip-artifacts`, `--only-artifacts`, or the config).

→ [Snapshot output and manifest schema](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/output.md)

## Built to be trusted with a whole repository

A snapshot is only useful if you can believe it, so the tool is explicit about what it does *not*
contain.

- **Nothing is dropped silently.** Every excluded path is recorded in `manifest.skipped[]` with a
  reason — `binary`, `gitignore`, `sensitive-file`, `symlink`, `read-error`, `excluded` and the
  rest — and `explain <path>` answers the same question for any single file.
- **Counts describe what was emitted.** `includedBytes` and `includedLines` are measured from the
  block in the part, not from the file on disk. A file that is not valid UTF-8 is kept and labelled
  `utf-8-lossy` rather than vanishing as "binary".
- **Drift is checked, not assumed.** `validate` compares every file's hash *and* a digest of the
  settings the snapshot was generated with, so a changed budget or secret pattern is drift rather
  than silence.
- **The output directory is the tool's.** Each run is written to a scratch directory and swapped in
  atomically, and it refuses to replace a directory it did not create — `--out-dir src` cannot
  destroy source code.
- **Credential files are excluded by default** — `.env`, `*.pem`, `.npmrc`, `id_rsa`, `*.tfstate`
  and more — and secret-shaped strings inside ordinary files are redacted by masking only the
  matched span, never the whole line.

## Supported projects

25 presets, detected from the repository — each contributing layers, kinds, ecosystem ignore
patterns and a recommended part budget.

| | | | |
| :--- | :--- | :--- | :--- |
| Next.js | Nuxt | SvelteKit | Remix |
| Astro | Angular | Solid | Vue + Vite |
| React + Vite | NestJS | Express / Fastify / Koa | Node library |
| Monorepo | Django | FastAPI / Flask | Python library |
| Go | Rust | Java / Spring | .NET |
| Laravel (PHP) | Rails (Ruby) | Terraform / Docker infra | Docs-only |
| generic fallback | | | |

Non-TypeScript languages get import/export/class/function summaries rather than being treated as
opaque text, and every summary is labelled `ast`, `structural` or `heuristic` so you know how much
to trust it.

→ [Preset table and detection rules](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/configuration.md#project-presets)

## Commands

| Command | Does |
| :--- | :--- |
| *(none)* | The guided first run. Asks once when the project has no config; generates otherwise. |
| `generate` *(default)* | Write the snapshot. `--autopilot` sets the project up first, unasked. |
| `setup` | Config, npm scripts, devDependency, install and generate, in one command. |
| `validate` / `check` | Compare the snapshot with the repository; exit `1` on drift. |
| `report` | Snapshot health, layer metrics, secret audit. |
| `init` | Interactive (or `--yes`) setup that writes a self-documenting config. |
| `explain <path>` | Why one path is included, which part it lands in, or why it was skipped. |
| `diff <a> <b>` | Compare two snapshots. |
| `describe` | The machine-readable contract (`--format json`). |
| `skill` | Print or install the agent skill. |
| `mcp` | Serve the repository to an MCP client over stdio. |

Exit codes: `0` success · `1` drift, refused generation, or nothing to snapshot · `2` usage error,
or a first run with no terminal and no `--autopilot`.

Once a day it checks the npm registry for a newer release and mentions it on stderr — skipped in CI,
in any `--format json` run, and in `mcp`. Turn it off with `--no-update-check`.

→ [Full CLI reference](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md)

## For AI agents

Everything an agent needs is available as data, and the tool can install its own skill.

```bash
npx codebase-snapshot describe --format json   # contract: workflow, options, exit codes
npx codebase-snapshot skill --install          # into .claude/skills + .cursor/rules
npx -y codebase-snapshot@0.9.12 mcp             # or serve it over MCP
```

An agent told only "use `npx codebase-snapshot`" can read the contract, follow its ordered
workflow, and produce a validated snapshot unaided — that path is covered by a test.

The MCP server exposes eight tools — status, plan, generate, validate, locate, dependents, read, explain — plus
`snapshot://` resources and two prompts. Its reads come from the snapshot rather than the working
tree, so an excluded file stays excluded and a redacted value stays redacted, and
`snapshot_validate` answers the question an agent otherwise cannot ask: is the context I was given
still true?

→ [Using this with an AI agent](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/agent.md) · [MCP server](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/mcp.md) · [AGENTS.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/AGENTS.md) · [llms.txt](https://github.com/ankurhalder/codebase-snapshot/blob/main/llms.txt)

## Configuration

`snapshot.config.ts` (or `.mjs`) is written by `init` with **every** setting at its current value,
commented and grouped, so it doubles as the reference. Deleting any line is safe: the defaults are
real.

```js
const config = {
  maxPartBytes: "120k",                                   // hard budget per part
  excludePatterns: ["vendor/**", "**/*.min.js"],
  artifacts: { monolith: false },                         // single-file output stays off
  budgets: { default: "120k", byLayer: { docs: 40_000 } },
  includeSensitiveFiles: false,                           // .env, *.pem … stay out
};

export default config;
```

→ [Configuration reference](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/configuration.md)

## Programmatic API

```js
import { generateSnapshot, resolveConfig, validateSnapshot, loadConfigFile } from "codebase-snapshot";

// Pass the repository explicitly: loadConfigFile returns only the config it found, so a
// directory with no config file would leave resolveConfig scanning process.cwd() instead.
const dir = "/path/to/repo";
const config = resolveConfig(await loadConfigFile(dir), { cwd: dir });
const manifest = generateSnapshot(config);
const validation = validateSnapshot(config);
```

CommonJS works too (`require("codebase-snapshot")`), with type definitions for both. The CLI, the
API and the MCP server share one implementation, so anything one of them does is available in the
others.

## Documentation

| | |
| :--- | :--- |
| [Installation](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/install.md) | Every client, version pinning, agent skill install |
| [CLI reference](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md) | Commands, options, exit codes, examples |
| [Configuration](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/configuration.md) | Every setting, all 25 presets, budgets, hooks, secrets |
| [Snapshot output](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/output.md) | Directory layout and the full manifest schema |
| [AI agents](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/agent.md) | The contract, the skill, what an agent should avoid |
| [MCP server](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/mcp.md) | Eight tools, resources, both protocol eras |
| [Troubleshooting](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/troubleshooting.md) | Every message and what to do about it |
| [Changelog](https://github.com/ankurhalder/codebase-snapshot/blob/main/CHANGELOG.md) | Release history and breaking changes |

Guides: [feeding a codebase to ChatGPT, Claude or
Cursor](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/how-to-feed-a-repo-to-claude.md)
· [stale LLM context is a
bug](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/stale-context-is-your-bug.md) ·
[how many tokens a codebase
is](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/codebase-token-budget.md) ·
[budgeting a context
window](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/how-to-context-budget.md) ·
[vs repomix](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-repomix.md) · [vs
gitingest](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-gitingest.md) · [vs
code2prompt](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-code2prompt.md)

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/CONTRIBUTING.md) and the
[code of conduct](https://github.com/ankurhalder/codebase-snapshot/blob/main/CODE_OF_CONDUCT.md).
Security reports: [SECURITY.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/SECURITY.md).

## License

[MIT](https://github.com/ankurhalder/codebase-snapshot/blob/main/LICENSE) © Ankur Halder

<p align="center">
  <sub>Built by <a href="https://ankurhalder.com" rel="author">Ankur Halder</a> ·
  <a href="https://ankurhalder.github.io/codebase-snapshot/">documentation</a> ·
  <a href="https://www.npmjs.com/package/codebase-snapshot">npm</a></sub>
</p>
