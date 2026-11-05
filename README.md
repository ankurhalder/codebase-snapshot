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

That writes `./snapshot/` — a directory you can drop into a chat, a prompt, a RAG pipeline or
a repository review. TypeScript and JavaScript first, but also Python, Go, Rust, Java/Kotlin,
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

Feeding a real repository to a model is awkward: files are too big, context windows are too
small, and picking what matters by hand does not scale or repeat. `codebase-snapshot` does it
deterministically:

- **One file per part, never over budget.** `maxPartBytes` is a hard ceiling. A file bigger
  than the budget is truncated with an explicit omission marker naming the budget rather than
  blowing the limit — and above `largeFileBytes` it becomes a head/tail excerpt instead.
- **An index, not just text.** `manifest.json` lists every included file with its layer, kind,
  language, part, hash and a structural summary — and every *excluded* file with the reason.
- **Provably current.** `validate` re-hashes the repository against the snapshot and exits
  non-zero on any drift, so a pipeline can gate on context being fresh.
- **Deterministic where it matters.** Two runs over unchanged input give byte-identical
  `parts/`, `reports/navigation.md` and `reports/project-tree.md`, and the same
  `manifest.fingerprint`. Only `manifest.json`, the snapshot's `README.md`,
  `reports/audit.md` and `.codebase-snapshot` change between runs, because they carry
  timestamps, a run id and a pid.
- **Safe by default.** Credential files are skipped unless asked for, secret-shaped strings are
  redacted, and a mistyped output directory cannot delete source code.
- **Usable by agents, not just humans.** A machine-readable contract and an installable skill
  let an agent with no prior knowledge drive the whole thing.

## Install

```bash
npm install -g codebase-snapshot      # puts `snapshot` on your PATH
npx codebase-snapshot generate        # or no install at all, one-off
npm install -D codebase-snapshot      # or add it to a project
```

`codebase-snapshot` is the canonical name to script against; `snapshot` is the short command a
global install provides. From a project dependency the same binary is `npx snapshot`,
`pnpm exec snapshot`, `yarn snapshot` or the `npm run snapshot` script `init` writes — the bare
word only exists on `PATH` when the package is installed globally.

This is a **<!--@major-->0<!--/@major-->.x** release. Version numbers follow semver's 0.x conventions, so the CLI surface may change in a minor release until 1.0.0 — pin an exact version if you need a fixed surface today.

Any npm-compatible client works — npm, yarn (classic and Berry with strict PnP), pnpm and bun —
each verified against the packed tarball before release. Requires **Node.js 18+**.

Published from GitHub Actions with [build provenance](https://docs.npmjs.com/generating-provenance-statements): npm shows the tarball was built from this repository at a tagged commit, and `npm audit signatures` verifies it.

→ [Installation guide](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/install.md)

## Quick start

Type it. That is the whole first run.

```bash
snapshot
```

In a project with no configuration the tool recognises the project and says what it keyed on —
`Detected nextjs` / `Because next.config.ts` — then offers one keystroke for the recommended
setup, or a walk through every setting with each question starting on its default. Either way it
writes the config, adds the npm scripts and the devDependency, installs with your package
manager, and generates. In a project that already has a config, or that it has generated before,
the same command just generates.

Nothing to press — CI, a container, an agent:

```bash
npx codebase-snapshot --autopilot
```

Same work, no questions. This is the part that matters: **a first run never guesses.** With no
terminal and no `--autopilot` it exits `2` and tells you the three ways forward, because a
snapshot built from settings nobody chose is a snapshot nobody can check.

```bash
# Or step by step, if you want to see each stage:
npx codebase-snapshot init --yes   # config + scripts + devDependency + .gitignore
npm install                                     # the package, into node_modules
npm run snapshot                                # generate
npm run snapshot:validate                       # exit 0 = current with disk
```

`setup` is the same one-command path as `--autopilot`, spelled as a command; both keep a config
the repository already has, and `--no-install` skips the install (CI, offline, or a lockfile you
would rather not touch).

```
📸 Generating snapshot for: /Users/you/project
   Branch: main | Part budget: 300 KB

✅ Snapshot generated in 0.14s:
   - Tracked files: 128
   - Total lines:   9,431
   - Total size:    0.41 MB
   - Parts written: 3 under snapshot/parts/
   - Reports:       snapshot/reports/ (project-tree, navigation, audit)
   - Manifest:      snapshot/manifest.json
   - Fingerprint:   e4607b570268c8def0911babbace97e4a0196d9eaf2cac22c8847500883d70aa
   - Integrity:     passed
```

The fingerprint is printed in full — all 64 hex characters, never elided — and it is the same
value as `manifest.fingerprint`.

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

A snapshot is only useful if you can believe it, so the tool is explicit about everything it does
*not* contain:

- **Nothing is dropped silently.** Every excluded path is recorded in `manifest.skipped[]` with a
  reason — `binary`, `gitignore`, `default-ignore`, `sensitive-file`, `sensitive-path`, `symlink`,
  `outside-root`, `read-error`, `not-file`, `nested-repository`, `excluded` — and `explain <path>`
  answers the same question for any single path.
- **Encoding is stated, not guessed.** UTF-16 files are transcoded instead of vanishing as
  "binary"; a file that is not valid UTF-8 is kept but labelled `utf-8-lossy` with the count of
  undecodable bytes, so you never mistake mojibake for source.
- **Counts describe what was emitted.** `includedBytes` and `includedLines` are measured from the
  block in the part, not from the file on disk.
- **Drift is checked, not assumed.** `validate` compares every file's hash *and* a digest of the
  settings the snapshot was generated with, so a changed budget, layer rule or secret pattern is
  drift rather than silence.
- **Memory is bounded.** Files above 2 MB are not parsed for a structural summary (that is where a 50 MB file
  used to reach 3 GB of resident memory), and 130 000 files in one directory or a 3 000-level path
  scan without crashing.
- **`diff` compares payloads, not just paths.** Two snapshots of identical sources with different
  settings say so instead of reporting "0 changed".
- **When git cannot list files** — an interrupted clone, a dehydrated `.git`, `safe.directory` —
  the run refuses rather than quietly scanning something different, and `--discovery walk` is the
  documented escape hatch.

## Supported projects

25 presets, detected automatically from the repository — each contributing layers, kinds,
ecosystem ignore patterns and a recommended part budget.

| | | | |
| :--- | :--- | :--- | :--- |
| Next.js | Nuxt | SvelteKit | Remix |
| Astro | Angular | Solid | Vue + Vite |
| React + Vite | NestJS | Express / Fastify / Koa | Node library |
| Monorepo | Django | FastAPI / Flask | Python library |
| Go | Rust | Java / Spring | .NET |
| Laravel (PHP) | Rails (Ruby) | Terraform / Docker infra | Docs-only |
| generic fallback | | | |

Non-TypeScript languages get import/export/class/function summaries rather than being treated
as opaque text. Vue, Svelte and Astro script blocks go through the real TypeScript compiler.
Every summary is labelled `ast`, `structural` or `heuristic` so you know how much to trust it —
Python, for example, is a line-scan `heuristic`, while JSON and Markdown get `structural`
shapes.

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

Exit codes: `0` success · `1` drift, refused generation, or nothing to snapshot · `2` usage
error, or a first run with no terminal and no `--autopilot`.

→ [Full CLI reference](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md)

## For AI agents

Everything an agent needs is available as data, and the tool can install its own skill:

```bash
# The contract: workflow, every option and default, exit codes, presets, safety rules
npx codebase-snapshot describe --format json

# Install the skill into the registries agent tools read: .claude/skills/, .cursor/rules/
# (it adds those files to .gitignore, and never touches your own AGENTS.md)
npx codebase-snapshot skill --install
```

An agent told only "use `npx codebase-snapshot`" can read the contract, follow its
ordered workflow, and produce a validated snapshot unaided — that path is covered by a test.

Or skip the shell and let the client talk to a server:

```bash
npx -y codebase-snapshot@0.9.4 mcp
```

Seven tools over MCP — status, plan, generate, validate, locate, read, explain — with `snapshot://`
resources and two prompts. Reads are served from the snapshot rather than the working tree, so an
excluded file stays excluded and a redacted value stays redacted.

→ [Using this with an AI agent](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/agent.md) · [MCP server](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/mcp.md) · [AGENTS.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/AGENTS.md) · [llms.txt](https://github.com/ankurhalder/codebase-snapshot/blob/main/llms.txt)

## Configuration

`snapshot.config.ts` (or `.mjs`) is written by `init` with **every** setting at its current
value, commented and grouped, so it doubles as the reference. Deleting any line is safe: the
defaults are real. The object is exported through a name — `export default { … }` is
`import/no-anonymous-default-export`, on by default in `eslint-config-next`.

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

CommonJS works too (`require("codebase-snapshot")`), with type definitions for
both. The CLI and the API share one implementation, so anything the CLI does is available here.

## Documentation

| | |
| :--- | :--- |
| [Installation](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/install.md) | Every client, version pinning, agent skill install |
| [CLI reference](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md) | Commands, options, exit codes, examples |
| [Configuration](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/configuration.md) | Every setting, all 25 presets, budgets, hooks, secrets |
| [Snapshot output](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/output.md) | Directory layout and the full manifest schema |
| [AI agents](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/agent.md) | The contract, the skill, what an agent should avoid |
| [Troubleshooting](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/troubleshooting.md) | Every message and what to do about it |
| [Changelog](https://github.com/ankurhalder/codebase-snapshot/blob/main/CHANGELOG.md) | Release history and breaking changes |

## Guides

| | |
| :--- | :--- |
| [Feeding a codebase to ChatGPT, Claude or Cursor](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/how-to-feed-a-repo-to-claude.md) | The full recipe, including the parts most guides skip |
| [Stale LLM context is a bug](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/stale-context-is-your-bug.md) | Drift, fingerprints and the CI gate that catches a snapshot going out of date |
| [How many tokens is a codebase?](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/codebase-token-budget.md) | The arithmetic of bytes, tokens and context windows, measured |
| [Budgeting LLM context](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/how-to-context-budget.md) | Choosing the numbers from the destination, not from taste |
| [vs repomix](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-repomix.md) | Including where repomix is the better choice |
| [vs gitingest](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-gitingest.md) | Including where gitingest is the better choice |
| [vs code2prompt](https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/vs-code2prompt.md) | Including where code2prompt is the better choice |

## Safety

- **Credential files are excluded by default** — `.env`, `*.pem`, `*.key`, `.npmrc`, `.netrc`,
  `.git-credentials`, `id_rsa`, `.kube/config`, `*.tfstate` — and listed in
  `manifest.skipped[]` with the reason.
- **Secrets are redacted** inside ordinary files: only the matched span is masked, never the
  whole line, and no excerpt reaches any artifact.
- **The output directory is owned by the tool.** Each run is written to a scratch directory and
  swapped in atomically; the previous snapshot survives a failure.
- **It refuses to replace a directory it did not create**, so `--out-dir src` cannot destroy
  source code.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/CONTRIBUTING.md) and the
[code of conduct](https://github.com/ankurhalder/codebase-snapshot/blob/main/CODE_OF_CONDUCT.md). Security reports: [SECURITY.md](https://github.com/ankurhalder/codebase-snapshot/blob/main/SECURITY.md).

## License

[MIT](https://github.com/ankurhalder/codebase-snapshot/blob/main/LICENSE) © Ankur Halder

<p align="center">
  <sub>Built by <a href="https://ankurhalder.com" rel="author">Ankur Halder</a> ·
  <a href="https://ankurhalder.github.io/codebase-snapshot/">documentation</a> ·
  <a href="https://www.npmjs.com/package/codebase-snapshot">npm</a></sub>
</p>
