# CLI reference

```bash
npx codebase-snapshot <command> [options]
```

The package installs one executable under two names: **`codebase-snapshot`** (canonical, and the
one to script against) and **`snapshot`** (the short command a global install puts on your
`PATH`). Both are the same file. From a project dependency use `npx codebase-snapshot` or
`npx snapshot` — both resolve the local copy first.

Running with no command is the guided first run: in a project with no configuration it asks
once, sets the project up and generates; in a configured project it is the same as `generate`.
Naming the command (`codebase-snapshot generate`) always means "do exactly this", on the
documented defaults. `--autopilot` sets the project up first without asking.

```bash
snapshot                     # global install: guided first run, then generate
npx codebase-snapshot        # the same, from a project dependency
npx codebase-snapshot --autopilot   # the same with no questions
```

## The first run

```bash
snapshot                # global install
npx codebase-snapshot   # from a project dependency
```

In a project with no configuration the tool reports what it recognised **and what it keyed on**,
then asks one question:

```
  codebase-snapshot

  Detected   nextjs
  Because    next.config.ts
  Directory  /Users/you/app

  ◆ How should I set this up?
    ❯ Use the recommended setup      nextjs · config · npm scripts · install · generate
      Go through each setting        every question starts on its default
      Pick a different preset        everything else stays at the defaults
```

The first entry is the whole setup in one keystroke. The second walks through the settings, and
every prompt starts on its answer, so pressing `enter` through the lot is the recommended setup
spelled out. When nothing matched, the tool says so, names the manifests it looked for, and asks
which preset is closest — the one case where it needs an answer it cannot find itself.

A project that already has a config, or one this tool generated before, skips all of it and just
generates. `--autopilot` does the same work with no questions at all, and reports each decision
as it makes it.

## Contents

- [Commands](#commands)
  - [`generate`](#generate)
  - [`validate` / `check`](#validate--check)
  - [`report`](#report)
  - [`setup`](#setup)
  - [`init`](#init)
  - [`explain <path>`](#explain-path)
  - [`diff <before> <after>`](#diff-before-after)
  - [`describe`](#describe)
  - [`skill`](#skill)
- [Options](#options)
- [Exit codes](#exit-codes)
- [Output streams](#output-streams)
- [Examples](#examples)

## Commands

### `generate`

```bash
codebase-snapshot generate [options]
```

Scans the repository and writes the snapshot to `outDir` (default `./snapshot`).

Naming the command is the deterministic form: it runs on the documented defaults and writes nothing
but the snapshot. Without a command word an unconfigured project gets the
[guided first run](#the-first-run) first; `--autopilot` asks for that setup from an explicit
`generate` too, and never prompts.

A first run neither form can resolve — no config, no previous snapshot, no `--autopilot`, no
terminal — exits `2` and names the alternatives. It does not quietly generate on defaults.

Detection is automatic: a preset is chosen from the 25 in the
[preset table](configuration.md#project-presets), which supplies layers, kinds and ecosystem
ignores. The preset's *recommended* part budget is not applied by `generate` — that runs on
`--max-part-bytes` (default 307200) or your config. `init` is what writes the recommended
budget into a fresh config, so a project set up with `init` gets the preset's figure.

Exit `0` when the snapshot passes its own integrity check, `1` when it does not.

```
📸 Generating snapshot for: /path/to/repo
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
   - Redacted:      2 line(s) — values masked; see snapshot/reports/audit.md
```

The fingerprint is printed in full — all 64 hex characters, never elided — and it matches
`manifest.fingerprint`.

The summary only lists artifacts that were actually written, so a run with
`--only-artifacts parts` does not claim a manifest exists.

**`Redacted` and `Warnings` are different lines, and that is deliberate.** A redaction means the
tool masked a secret-shaped value: it is the tool doing its job, and it is counted **once per
line** even when two rules match that line. The per-line list — file, line, every rule that
matched — is `reports/audit.md`, and `manifest.totals.redactedLines` carries the count.

`Warnings` is for things you may want to act on: a disabled artifact, a file too large to parse
for a summary, a non-UTF-8 file that was transcoded. The summary shows the first ten and then
says `… and N more in manifest.warnings[]`; nothing is dropped silently.

### `validate` / `check`

```bash
codebase-snapshot validate [options]
```

Compares the snapshot on disk with the repository. Reports five classes of drift — modified
files, deleted files, files added since the snapshot, damaged or missing parts, and config
changes — plus bookkeeping mismatches in the manifest.

Exit `0` when the snapshot is current, `1` on any drift. It never writes anything.

### `report`

```bash
codebase-snapshot report [options]
```

Prints what the snapshot says about itself: counts, layer breakdown, warnings, fingerprint.
It reads `manifest.json` and nothing else, so it is fast on any repository size — a 20 000-file
snapshot reports in about half a second. Requires an existing `manifest.json` (exit `1` if
missing); exits `0` otherwise. It does **not** check whether the snapshot is still true — that
is `validate`, which re-reads the repository and exits `1` on drift.

### `setup`

```bash
codebase-snapshot setup
```

The whole first run in one command, with defaults and no prompts. This is the same implementation
`--autopilot` uses, spelled as a command word:

1. Detects the project preset.
2. Writes `snapshot.config.ts` (or `.mjs`) — **only when the repository has none**. An existing
   config is kept byte for byte and the output says `Keeping …`.
3. Adds `scripts.snapshot`, `scripts.snapshot:validate`, the `devDependencies` entry and the
   `.gitignore` entries, exactly as `init` does.
4. Installs dependencies with the package manager the repository already uses — a lockfile
   decides (`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, otherwise npm). A failed install is a
   warning, not a dead end: the snapshot is still generated.
5. Generates through the normal `generate` command, so the summary, the output-directory guard and
   the `--format json` document are the ones a plain run produces.

```
🚀 Setup for: /path/to/repo
✅ Created snapshot.config.ts (preset: nextjs)
   Added npm scripts: snapshot, snapshot:validate
   Added devDependency: codebase-snapshot ^0.9.5
   Added to .gitignore: snapshot/, snapshot.tmp/
⏳ Installing dependencies…
✅ Installed dependencies (npm install, 2.1s)
✅ Snapshot generated in 0.16s:
   - Tracked files: 128
   …
   Next:  npm run snapshot
```

- `--no-install` skips step 4 — CI, an offline machine, or a lockfile you would rather no package
  manager touched.
- `--dry-run` prints the plan and the config it would write, and writes nothing.
- `--force` rewrites an existing config; `--preset`, `--include`, `--exclude`, `--out-dir`,
  `--max-part-bytes`, `--include-sensitive-files` and `--skip-artifacts` behave as they do for
  `generate` and `init`.
- `--format json` emits **one** document:
  `{ "setup": { configPath, configReused, preset, scripts, dependency, gitignoreEntries, install, notes }, "manifest": { … } }`,
  where `manifest` is the same object `generate --format json` writes.
- If `outDir` holds files this tool did not write, `setup` still refuses to replace it (exit 1,
  naming the entries) after writing the config — the guard is not weakened by the convenience.
### `init`

```bash
codebase-snapshot init [options]
```

Detects the project and writes `snapshot.config.ts` (or `.mjs`, see below) containing
**every** setting at its current value, commented and grouped. It is a reference you can
keep, not just a diff — there is no shorter variant, because the file that documents the
settings is the file you edit.

It also has three side effects on files you own, and it says so when it does them:

```
✅ Created snapshot.config.ts (preset: node-lib)
   Added npm scripts: snapshot, snapshot:validate
   Added devDependency: codebase-snapshot ^0.9.5
   Added to .gitignore: snapshot/, snapshot.tmp/
```

- `scripts.snapshot` and `scripts.snapshot:validate` are added to `package.json` if those keys
  are absent. Existing values are left alone, and the rewrite keeps the file's own indentation
  and line endings. Without a `package.json` it notes that scripts were not added.
- `codebase-snapshot` is added to `devDependencies` when no dependency field
  declares it yet. That is what puts a real copy in `node_modules` and stops `npm run
  snapshot` from resolving `@latest` out of the registry on every run. A range you already
  declared — including a pin to an older version — is never overwritten.
- `snapshot/` and `snapshot.tmp/` are appended to `.gitignore` if they are not already listed;
  the file is created if missing, and entries already present are not duplicated.

### Going back

At a terminal, `init` asks five questions and every one of them can be revisited: **`←`** goes back
on a list or a text field, **`b`** on a list or a confirmation. `text` takes `←` alone because `b` is
a character you may be typing, and `confirm` takes `b` alone because `←`/`→` already mean yes/no.

Back steps to the previous question with your earlier answer still selected; back from the first one
returns to *"How should I set this up?"*. Answering **No** at the review steps back rather than
abandoning the run — Ctrl+C is how you abandon.

Nothing else in the repository is touched: no `AGENTS.md`, no `.claude/`, no `.cursor/`. In a
repository with a `package.json` and no config, `git status` shows the config as the only new
file.

Interactive by default; with `--yes` it accepts every default and never prompts, which is
what agents and release checks should use.

The filename adapts to the project: `.ts` only when the running Node can strip types
(≥ 22.6) **and** the project is an ES module; otherwise `.mjs`, which loads everywhere. The
generated file is a plain object with no imports, so it works even when the package is only
run through `npx` and never installed.

Related options: `--preset`, `--include`, `--exclude`, `--yes` and `--force`
apply to `init` only. `init` also accepts `--dry-run`, `--max-part-bytes`, `--out-dir`,
`--include-sensitive-files`, `--skip-artifacts` and `--only-artifacts`, which it shares with
the commands that re-read a snapshot, and records their effect in the generated file. The
`Applies to` column is in the [options table](#options).

### `explain <path>`

```bash
codebase-snapshot explain src/server.ts
```

Answers "what would happen to this file?" — layer, kind, language, size, which part it lands
in, and the exact reason if it is skipped (`sensitive-file`, `binary`, `default-ignore`,
`excluded`, and the other reasons in [Troubleshooting](troubleshooting.md#a-file-is-missing-from-the-snapshot)).

Exit `0` whenever the path could be inspected, whether or not it would be included — the
answer is in the output. Exit `1` only when the command itself could not run.

This is the fastest way to debug a file that is unexpectedly missing from a snapshot.

With `--format json` the same answer is one object on stdout, with only the keys that apply:

```json
{
  "path": "src/math.ts",
  "exists": true,
  "included": true,
  "layer": "src",
  "kind": "other",
  "language": "typescript",
  "layerMatch": "function (custom predicate)",
  "bytes": 63,
  "lines": 3,
  "secretCount": 0,
  "secrets": [],
  "part": "part-001.md",
  "inclusionMode": "full"
}
```

| Key | Meaning |
| :--- | :--- |
| `path` | The path you asked about, relative to `--cwd` and with POSIX separators. |
| `exists` | Whether anything is on disk at that path. |
| `included` | Whether the scanner would include it in the next snapshot. |
| `reason`, `detail` | Why not, when `included` is `false`. The same strings `manifest.skipped[]` uses, plus `missing` and `not-discovered`. A path with no record of its own inherits the record of the nearest skipped ancestor directory, and `detail` names that ancestor — for example ``ignored by .gitignore — inherited from the skipped directory `ignored` `` or ``built-in ignore: directory "node_modules" (not descended) — inherited from the skipped directory `node_modules` ``. |
| `layer`, `kind`, `language` | The classification, present only when `included` is `true`. |
| `layerMatch`, `kindMatch` | Which rule chose the layer or kind. A glob is printed as written (`src/api/**`); a `RegExp` as its literal form (`/\.tsx$/i`); a function matcher, which is what the presets use, as `function (custom predicate)`. Absent when no rule matched and the `other` fallback was used. |
| `bytes`, `lines` | Size of the file on disk. |
| `encoding` | Present only when the file is not plain UTF-8 — `utf-16le`, `utf-16be` or `utf-8-lossy`. |
| `secretCount`, `secrets` | How many secret rules fire, and the first 20 as `{ rule, line }` — never the matched text. |
| `part` | The part filename from the last written manifest, or `null` when it is not in that snapshot. |
| `inclusionMode` | `full` or `preview`, when a part entry exists. |

When `included` is `false` the object stops after `path`, `exists`, `included`, `reason` and
`detail`.

### `diff <before> <after>`

```bash
codebase-snapshot diff ./snapshot-old ./snapshot
codebase-snapshot diff ./a/manifest.json ./b/manifest.json
```

Compares two snapshots and lists added, removed and changed files. Either argument may be a
snapshot directory or a `manifest.json`. Useful in review: "what changed in the context we
hand to the model?"

Comparison is per file (`relativePath` + `sha256`), so on its own it cannot see a run that
repacked the *same* sources differently. `diff` therefore also compares the two manifests'
`generator.version`, `config.digest`, content fingerprint, part count and layer totals, and
prints a `payload/configuration differs:` section when the file set is identical but the
emitted payload — or the configuration that produced it — is not. That covers `--large-file-bytes`
(a preview becomes a full body), the preview head/tail counts, redaction rules, artifact
selection and per-layer budgets, none of which move a source hash. The per-file lists and the
JSON fields `added` / `removed` / `changed` / `unchanged` are unchanged; the extra data is
under `payload` in `--format json`.

Manifests written before 4.0.5 have no `config.digest`. In that case `diff` compares the
content fingerprint and the part count only, and prints `configuration not compared: a
manifest has no config digest (written before 4.0.5).` rather than implying the settings match.

### `describe`

```bash
codebase-snapshot describe              # human-readable
codebase-snapshot describe --format json # machine-readable contract
```

Prints the tool's complete contract: the supported invocation, an ordered workflow, every
command, every option with its default, the exit-code meanings, all presets, the artifact
list, config filenames, output layout, safety rules and a troubleshooting table. The JSON
form is what an agent should read instead of `--help`. See [Using this with an AI
agent](agent.md).

### `skill`

```bash
codebase-snapshot skill                     # print on stdout
codebase-snapshot skill --install           # write both registries
codebase-snapshot skill --install --target claude
```

Prints or installs the bundled agent skill. Installation writes
`.claude/skills/codebase-snapshot/SKILL.md` and `.cursor/rules/codebase-snapshot.mdc`;
`--target claude` or `--target cursor` limits it to one. Both are **registries keyed by
skill name**, so the file cannot be mistaken for your own documentation.

It does not write `AGENTS.md`. That file is your project's agent contract — build commands,
conventions, house rules — and a tool has no business editing it. If you want the skill
there, print it and paste it:

```bash
codebase-snapshot skill >> AGENTS.md
```

Whatever the install *creates* is appended to `.gitignore` in the same run, so a one-line
command does not leave three untracked files behind. Re-running is idempotent, and a file that
already existed is never ignored. `--format json` reports what was created, updated or
unchanged, plus the ignore entries it added.

Printing goes to **stdout** so it can be redirected: `codebase-snapshot skill > SKILL.md`.

### `mcp`

```bash
codebase-snapshot mcp                 # serve the current directory over stdio
codebase-snapshot mcp --cwd <path>    # serve another repository
```

Serves the repository to a Model Context Protocol client over stdio: seven tools, `snapshot://`
resources and two prompts. Stdout carries JSON-RPC messages and nothing else; every note goes to
stderr. It speaks both protocol eras — the legacy `initialize` handshake and the stateless
`2026-07-28` revision — and answers whichever the client starts with.

`--cwd` is the only directory it will read. A tool's `root` argument can name a sub-directory of it
and nothing outside, symlinks included. It never installs packages and never writes a config file.

There is no `--format` here, because stdout *is* the protocol stream. The full tool list, resource
URIs and protocol versions appear in [the MCP server guide](mcp.md) and in
`describe --format json` under `mcp`.

## Options

An option a command does not accept is **rejected**, not ignored: exit `2` and a message
naming the commands that do accept it. Options marked *init only* or *skill only* are the
narrowest cases of the same rule.

| Option | Type | Default | Applies to | Meaning |
| :--- | :--- | :--- | :--- | :--- |
| `--cwd <path>` | path | current directory | generate, validate, report, explain, init, skill | Repository to operate on. Must exist and be a directory. `diff` and `describe` take no `--cwd`. |
| `--out-dir <path>` | path | `snapshot` | generate, validate, report, explain, init | Where the snapshot is written or read. May be absolute. |
| `--max-part-bytes <n>` | size | `307200` (300 KB) | generate, validate, report, explain, init | Hard ceiling per markdown part. Accepts `120k`, `1.5mb`. Minimum 4096. |
| `--large-file-bytes <n>` | size | `204800` (200 KB) | generate, validate, report, explain | Above this, a file becomes a head/tail preview. |
| `--max-monolith-bytes <n>` | size | unset | generate, validate, report, explain | Skip the single-file monolith when it would exceed this. |
| `--include-monolith` | flag | off | generate, validate, report, explain | Also write `full-codebase.json` and `full-codebase.md`. |
| `--include-sensitive-files` | flag | off | generate, validate, report, explain, init | Emit `.env`, `*.pem`, `.npmrc` and similar. Off by default; they are reported as skipped. |
| `--skip-artifacts <names>` | list | unset | generate, validate, report, explain, init | Comma-separated artifacts to omit. |
| `--only-artifacts <names>` | list | unset | generate, validate, report, explain, init | Write only these. Cannot be combined with `--skip-artifacts`. |
| `--format <text\|json>` | enum | `text` | generate, validate, report, explain, init, setup, diff, describe, skill | `json` writes a pure JSON payload to stdout. Every command honours it, and `describe` reports the same nine-command list. |
| `--dry-run` | flag | off | generate, init, setup | Compute everything, print it, write nothing. |
| `--watch` | flag | off | generate | Regenerate on every change until interrupted. |
| `--autopilot` | flag | off | generate | Set the project up without asking — config, `.gitignore`, npm scripts, devDependency, install — then generate. Never overwrites an existing config; refuses an empty directory (exit `1`); contradicts `--no-config` (exit `2`). |
| `--no-install` | flag | off | setup, generate `--autopilot` | Skip the dependency install. Anywhere else it is a usage error, because it would change nothing. |
| `--no-config` | flag | off | generate, validate, report, explain, diff | Ignore every `snapshot.config.*` file and run on the built-in defaults. `diff` never loads a config anyway and accepts the flag for consistency. |
| `--discovery <mode>` | enum | `auto` | generate, validate, explain | How files are found: `auto` lists through git when git works and refuses when a `.git` directory cannot be listed; `git` requires git; `walk` scans the tree and reads `.gitignore` files directly. The escape hatch for a broken `.git`. |
| `--preset <name>` | name | detected | *init only* | Force a preset instead of detecting one. |
| `--include <globs>` | list | unset | *init only* | Allow-list recorded in the generated config. |
| `--exclude <globs>` | list | unset | *init only* | Exclude globs recorded in the generated config. |
| `--yes` | flag | off | *init only* | Never prompt; accept every default. |
| `--force` | flag | off | *init only* | Replace an existing `.ts`/`.js`/`.mjs` config in place. A JSON-family config is refused, naming the file to remove. |
| `--install` | flag | off | *skill only* | Write the skill into the repository instead of printing it. |
| `--target <name>` | enum | `all` | *skill only* | `claude`, `cursor` or `all`. |
| `-h`, `--help` | flag | — | every command | Print usage. |
| `-v`, `--version` | flag | — | every command | Print the version on stdout: a bare `v`-prefixed semver (for example `v1.2.3`), with no package name. |

The artifact and size options apply to `validate`, `report` and `explain` as well as
`generate` because those commands re-read the snapshot: pass the selection you generated
with and the comparison is like for like. `validate --skip-artifacts parts` on a snapshot
built without parts therefore agrees, while the same flag on a full snapshot reports a
config mismatch.

Every option also accepts the `--option=value` form. That form is required for negative
numbers, which otherwise look like flags.

### `--mode`

`--mode <command>` names the command instead of passing it positionally, which is handy when
a wrapper builds the argument list. `--mode validate` and `codebase-snapshot validate` are the
same run. It accepts the nine command names, and it is deliberately strict: asking for two
different commands is an error rather than a silent winner.

```
❌ --mode validate contradicts the command "generate". Pass one or the other.
❌ Unknown --mode "bogus". Expected one of: generate, validate, check, report, init, explain, diff, describe, skill.
```

`--mode` is not listed in `describe`'s option table or `--help`, on purpose: an agent has no
reason to use it, and the positional form is the documented one.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Success. For `validate`/`check`, no drift. |
| `1` | Drift detected, generation refused or failed (nothing was written), or the state the command needed was not there. |
| `2` | Usage error: unknown flag or command, an option the command does not accept, bad value, wrong argument count. Also a first run that needs an answer and has no terminal — run `--autopilot`, `init --yes`, or name the command. |

`1` covers the cases where the tool did the right thing but the state is not what you wanted
— drift, a refused output directory, an unparseable config. `2` means the command itself was
wrong and retrying it unchanged will fail the same way.

## Output streams

- **stdout** carries the payload. With `--format json` it is pure JSON, safe to pipe into
  `jq` or `JSON.parse`.
- **stderr** carries progress, the human summary, warnings and errors.
- **In text mode the human result is on stderr, and stdout is empty.** That holds for every
  command: `report`, `explain`, `diff` and `validate` print their answer — tables, verdicts,
  drift lines — to stderr, and `generate` prints its summary there too. Redirecting
  `command > file.txt` therefore writes an empty file in text mode; use `--format json` when
  you want the output on stdout.

A failing invocation still writes one JSON document to stdout, so an agent never has to parse an
empty string:

```json
{ "error": { "message": "Manifest not found at /repo/snapshot/manifest.json. Run generate first.", "exitCode": 1 } }
```

The human line stays on stderr and the exit code is unchanged — `{ error: … }` is an addition, not a
replacement. A successful run never carries an `error` key.

So `codebase-snapshot describe --format json > contract.json`,
`codebase-snapshot validate --format json | jq .drift` and
`codebase-snapshot report --format json || jq -r .error.message` all work.

## Examples

```bash
# The common path
npx codebase-snapshot generate

# A tighter budget for a small model context, in a separate directory
npx codebase-snapshot generate --out-dir .context --max-part-bytes 120k

# Just the code parts, no reports
npx codebase-snapshot generate --only-artifacts parts,manifest

# One file per part, with everything else left alone
npx codebase-snapshot generate --only-artifacts parts

# Why is this file missing?
npx codebase-snapshot explain src/generated/schema.ts

# What changed between two snapshots?
npx codebase-snapshot diff old-snapshot snapshot

# Non-interactive setup, then a JSON dry run to inspect the result
npx codebase-snapshot init --yes
npx codebase-snapshot generate --dry-run --format json | jq .config

# Keep the snapshot fresh while editing
npx codebase-snapshot generate --watch

# Give an agent everything it needs
npx codebase-snapshot skill --install
```
