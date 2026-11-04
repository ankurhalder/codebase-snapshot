# CLI reference

```bash
npx @ankurhalder/codebase-snapshot <command> [options]
```

The package installs one executable, **`codebase-snapshot`**, with a short alias **`snap`**.
Both are the same file. After `npx @ankurhalder/codebase-snapshot generate` the command
becomes available as `npx codebase-snapshot` for the rest of that session; after
`npm install -D` use `npx codebase-snapshot` or `npx snap` from the project.

Running with no command is the same as `generate`.

## Contents

- [Commands](#commands)
  - [`generate`](#generate)
  - [`validate` / `check`](#validate--check)
  - [`report`](#report)
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

Scans the repository and writes the snapshot to `outDir` (default `./snapshot`). This is the
default command, so `codebase-snapshot` alone does the same thing.

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
```

The fingerprint is printed in full — all 64 hex characters, never elided — and it matches
`manifest.fingerprint`.

The summary only lists artifacts that were actually written, so a run with
`--only-artifacts parts` does not claim a manifest exists.

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
   Added devDependency: @ankurhalder/codebase-snapshot ^4.1.1
   Added to .gitignore: snapshot/, snapshot.tmp/
```

- `scripts.snapshot` and `scripts.snapshot:validate` are added to `package.json` if those keys
  are absent. Existing values are left alone, and the rewrite keeps the file's own indentation
  and line endings. Without a `package.json` it notes that scripts were not added.
- `@ankurhalder/codebase-snapshot` is added to `devDependencies` when no dependency field
  declares it yet. That is what puts a real copy in `node_modules` and stops `npm run
  snapshot` from resolving `@latest` out of the registry on every run. A range you already
  declared — including a pin to an older version — is never overwritten.
- `snapshot/` and `snapshot.tmp/` are appended to `.gitignore` if they are not already listed;
  the file is created if missing, and entries already present are not duplicated.

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
| `--format <text\|json>` | enum | `text` | generate, validate, report, explain, init, diff, describe, skill | `json` writes a pure JSON payload to stdout. Every command honours it, and `describe` reports the same eight-command list. |
| `--dry-run` | flag | off | generate, init | Compute everything, print it, write nothing. |
| `--watch` | flag | off | generate | Regenerate on every change until interrupted. |
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
| `-v`, `--version` | flag | — | every command | Print the version on stdout: a bare `v`-prefixed semver such as `v4.0.0`, with no package name. |

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
| `2` | Usage error: unknown flag or command, an option the command does not accept, bad value, wrong argument count. |

`1` covers the cases where the tool did the right thing but the state is not what you wanted
— drift, a refused output directory, an unparseable config. `2` means the command itself was
wrong and retrying it unchanged will fail the same way.

## Output streams

- **stdout** carries the payload. With `--format json` it is pure JSON, safe to pipe into
  `jq` or `JSON.parse`.
- **stderr** carries progress, the human summary, warnings and errors.

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
npx @ankurhalder/codebase-snapshot generate

# A tighter budget for a small model context, in a separate directory
npx @ankurhalder/codebase-snapshot generate --out-dir .context --max-part-bytes 120k

# Just the code parts, no reports
npx @ankurhalder/codebase-snapshot generate --only-artifacts parts,manifest

# One file per part, with everything else left alone
npx @ankurhalder/codebase-snapshot generate --only-artifacts parts

# Why is this file missing?
npx @ankurhalder/codebase-snapshot explain src/generated/schema.ts

# What changed between two snapshots?
npx @ankurhalder/codebase-snapshot diff old-snapshot snapshot

# Non-interactive setup, then a JSON dry run to inspect the result
npx @ankurhalder/codebase-snapshot init --yes
npx @ankurhalder/codebase-snapshot generate --dry-run --format json | jq .config

# Keep the snapshot fresh while editing
npx @ankurhalder/codebase-snapshot generate --watch

# Give an agent everything it needs
npx @ankurhalder/codebase-snapshot skill --install
```
