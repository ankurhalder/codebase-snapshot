# Troubleshooting

Every message below is the real text the tool prints. Find your symptom, then the cause and
the fix.

## The command does nothing

**Symptom** — `npx @ankurhalder/codebase-snapshot generate` exits `0` and prints nothing. No
`snapshot/` directory appears.

**Cause** — a **stale global install** is shadowing `npx`. When a global copy exists, npm
runs it instead of the published package, and a leftover `npm link` (pointing at a
development checkout) resolves to a binary that is not there.

**Fix**

```bash
npm ls -g --depth=0 | grep codebase-snapshot
npm rm -g @ankurhalder/codebase-snapshot
npx @ankurhalder/codebase-snapshot generate
```

If nothing is installed globally, clear the npx cache (`npm cache clean --force`) and retry.
This is a local environment problem, not a package problem: on a machine without a global
copy the same command works.

## `command not found`

**Cause** — when the package is installed as a project dependency, its binary lives in
`node_modules/.bin` and is only on `PATH` inside a client runner or a package script.

**Fix** — use `npx codebase-snapshot`, `pnpm exec codebase-snapshot`,
`yarn codebase-snapshot`, `bun run codebase-snapshot`, or `./node_modules/.bin/codebase-snapshot`
in scripts.

## Exit code 2 — the command itself was wrong

Exit `2` always means "retrying this unchanged will fail the same way". The message names the
problem, and for an option the command does not take it also names the commands that do:

```
❌ --watch does not apply to `report` and was not applied. It is accepted by: `generate`.
❌ --cwd does not apply to `describe` and was not applied. It is accepted by: `generate`, `validate`, `report`, `init`, `explain`, `skill`.
```

Nothing is silently ignored — that is the point of the message. The per-option `Applies to`
column is in the [CLI reference](cli.md#options).

| Message | Fix |
| :--- | :--- |
| `Unknown command "frobnicate". Expected one of: …` | Use one of the commands in the [CLI reference](cli.md). |
| `--preset does not apply to \`generate\` and was not applied. It is accepted by: \`init\`. To scope a run, set include/excludePatterns/preset in snapshot.config.ts (or run \`codebase-snapshot init\` to generate one).` | `--preset`, `--include`, `--exclude`, `--yes` and `--force` configure `init`, which writes them into the config. Set them at generation time in `snapshot.config.ts` instead. |
| `--install does not apply to \`generate\` and was not applied. It is accepted by: \`skill\`.` | `--install` and `--target` configure `skill` only. |
| `--cwd directory does not exist: …` / `--cwd is not a directory: …` | Point `--cwd` at an existing repository directory. |
| `--out-dir requires a value (received an empty string).` | An unset shell variable expanded to nothing. Quote it or drop the flag. Every string option rejects `""` rather than silently using the default. |
| `--max-part-bytes received a value that looks like another flag (for example a negative number). Use the "--option=value" form, and note that sizes must be positive.` | A negative number reads as a flag. Use `--max-part-bytes=-5`, and note that sizes must be positive. |
| `Unknown preset "nope". Expected one of: …` | The message lists all 25 valid names. |
| `--target must be one of: claude, cursor, all (received "bogus").` | Fix the value. |
| `diff expects exactly two arguments …` / `explain expects exactly one path.` | Fix the arity. |

The `agents` target was removed in 4.1.1: `skill --install` writes only into the two registries
agent tools read by name (`.claude/skills/` and `.cursor/rules/`) and never writes `AGENTS.md`,
which is your repository's own agent contract. To put the skill there, print it and paste it
yourself: `codebase-snapshot skill >> AGENTS.md`.

## Exit code 1 — the state was wrong

### `Refusing to replace outDir …`

```
❌ Failed to generate snapshot: Refusing to replace outDir /repo/src: it holds no .codebase-snapshot marker (found app.ts). Remove the directory yourself, or point outDir at a new or empty directory.
```

**Cause** — the output directory contains files this tool did not write, and it cannot prove
it wrote them. This guard exists because a mistyped `outDir` used to replace the directory:
`outDir: "src"` deleted source code while reporting success.

Ownership is proved by a `.codebase-snapshot` marker that parses as ours — a JSON object
naming this generator, carrying a schema version this build understands, a per-snapshot `id`
and the digest of the manifest it shipped. A file with the right name is not enough:

| The directory | What the tool says |
| :--- | :--- |
| has files, no marker | `it holds no .codebase-snapshot marker (found app.ts)` |
| has a zero-byte marker | `its .codebase-snapshot marker is empty (found .codebase-snapshot, app.ts)` |
| has a marker that is not JSON | `its .codebase-snapshot marker is not valid JSON (found .codebase-snapshot, app.ts)` |
| was written by 3.0.0 | `its .codebase-snapshot marker carries no snapshot id (found .codebase-snapshot, manifest.json)` |
| carries our marker but you added files | `it carries this generator's ownership marker, but these entries are not part of the snapshot it recorded: custom.txt. Remove them yourself, or point outDir at a new or empty directory.` |

**Fix** — point `--out-dir` somewhere new, or delete the directory yourself. Do not delete
your source. Accepted without complaint: a missing directory, an empty directory, one holding
nothing but `.DS_Store`, and a complete snapshot this build wrote.

`.gitkeep` and `.gitignore` are **not** accepted, even in a directory that holds nothing else.
Both are files you create — the generator never writes either into an output directory — so a
directory holding one is somebody's data and is refused rather than replaced. Move the file out,
or point `--out-dir` somewhere new.

A snapshot written by 3.0.0 or earlier is **not** upgraded in place: its marker has three keys
and no `id`, so the new build cannot prove it wrote the directory and refuses. Delete the old
snapshot directory and generate again.

### `Refusing to write into outDir …: it exists but is not a directory.`

```
❌ Failed to generate snapshot: Refusing to write into outDir /repo/notes.txt: it exists but is not a directory.
```

A regular file has the same name as the output directory. Rename or remove it.

### `The config file could not be read`

```
⚠ Config: Could not parse /repo/snapshot.config.json: Expected property name or '}' …
❌ The config file could not be read. Fix it, or delete it to use the defaults.
```

**Cause** — a config file exists but does not parse, or a `.ts` config cannot be loaded. This
is fatal on purpose: skipping a broken config would generate a snapshot with none of your
settings and still report success.

**Fix** — fix the syntax, or delete the file to run on defaults. Check that the config is
loadable on your Node version: a `.ts` config needs Node ≥ 22.6 **and** an ES-module project.
`codebase-snapshot init` picks the right filename for the project automatically.

### `This directory is a git repository, but git could not list its files.`

```
❌ Failed to generate snapshot: This directory is a git repository, but git could not list its files. A plain walk honours .gitignore files, but git also applies .git/info/exclude and your global excludes file, includes files that are tracked although a .gitignore now matches them, and treats a submodule as a single entry. Fix the repository (git status should work), run outside git, or pass --discovery walk to accept those differences.
```

`git` is present and a `.git` directory exists, but it cannot list the files — an empty or
half-initialised `.git`, a permissions problem, or a damaged index. The tool refuses rather
than silently choosing between two discovery methods: which files are in the snapshot would
otherwise depend on whether git happened to work.

**Fix** — make `git status` work in that directory (repair or re-clone the repository), generate
from a copy that has no `.git` directory, or pass `--discovery walk` to scan the tree anyway.
The walk reads every `.gitignore` it meets, nested ones included, and still skips credential
files; what it cannot reproduce is git's own ignore sources (`.git/info/exclude` and your global
`core.excludesFile`), git's inclusion of files that are tracked although a `.gitignore` now
matches them, and its treatment of a submodule as one entry instead of a tree.

`--discovery git` says the opposite — require git — so it refuses in a directory that has no
usable repository:

```
❌ Failed to generate snapshot: Discovery mode is `git`, but git could not list this directory's files. Run inside a working repository, or pass --discovery walk (or auto) to scan the tree directly.
```

### `Another generate run is already using the staging directory …`

```
❌ Failed to generate snapshot: Another generate run is already using the staging directory /repo/snapshot.tmp. Wait for it to finish, or delete /repo/codebase-snapshot-1a2b3c4d5e6f7890.lock if no other run is active.
```

A second `generate` against the same repository started while the first still held the staging
directory — two terminals, or a CI job and a developer at once. The lock is advisory and on
disk, so a run that was killed cannot release it.

**Fix** — wait for the other run, then retry. If no other run is active, the named lock file is
stale: delete it, and the next run proceeds.

### `Refusing to generate: …`

```
❌ Failed to generate snapshot: Refusing to generate: outDir is the working directory or one of its ancestors. outDir=/repo tmpDir=/repo/snapshot.tmp cwd=/repo
```

The output paths are unsafe: `outDir` or `tmpDir` is the working directory, an ancestor, the
filesystem root, or they contain one another. The message prints the resolved paths so you
can see why. Use a subdirectory.

### Budget errors

A budget set in a **config file** exits `1`, and names the setting as you wrote it:

| Message | Fix |
| :--- | :--- |
| `maxPartBytes must be a positive byte count (received 0).` | Zero and negative values are errors, not "use the default". |
| `maxPartBytes must be at least 4096 bytes (received 1000).` | Raise it to 4096 or more (`"120k"` is 122880). |
| `maxPartBytes must be a byte count such as 120000, "120k" or "1.5mb" (received "abc").` | The value is not a number or a supported size string. |

The same mistake on the **command line** is a usage error, exits `2`, names the flag, and is
followed by the usage text:

| Message | Fix |
| :--- | :--- |
| `--max-part-bytes must be at least 4096, received "1000".` | Raise it to 4096 or more. `--max-part-bytes 0` and `--max-part-bytes 1000` both produce this form. |
| `--max-part-bytes expects a byte count such as 120000 or "120k", received "abc".` | The value is not a number or a supported size string. `--max-part-bytes=-5` produces this form too. |

`--large-file-bytes` and `--max-monolith-bytes` share the second message, with their own flag
name, and their minimum is 1 rather than 4096:
`--large-file-bytes must be at least 1, received "0".`

### `Cannot write the snapshot: permission denied under …`

The output directory is not writable (or a parent is not readable). The previous snapshot is
left intact. Fix the permissions, or choose another `--out-dir`.

### `Snapshot validation failed` (from `validate`)

Exit `1` with one line per class of drift:

| Line | Meaning |
| :--- | :--- |
| `- modified: path` | The file changed since the snapshot. |
| `- deleted: path` | The file is in the snapshot but no longer on disk. |
| `- new file: path` | The file exists on disk and is not in the snapshot. |
| `- part: part-001.md (missing from snapshot/parts)` | The part file was deleted or renamed. |
| `- part: … (size mismatch …)` | The part was edited by hand. |
| `- config: …` | A setting differs from the one recorded in the manifest. |
| `- counts: …` | The manifest's own bookkeeping disagrees with its contents. |

**Fix** — re-run `generate`. If it persists, the snapshot directory is being modified by
something else.

### `report` exits 1 (only when it cannot read the snapshot)

- `Manifest not found at … Run generate first.` — nothing has been generated yet.
- `… is not a snapshot manifest: missing \`counts\`` — the file parsed as JSON but is not a
  manifest this tool wrote. Wrong `--out-dir`, or a foreign file named `manifest.json`.

### `diff` exits 1

- `No snapshot found at X: the path does not exist.`
- `Could not read a manifest at X.`
- `… is not a snapshot manifest (no "counts" object).`

Point it at a snapshot directory or a `manifest.json` written by this tool.

## A file is missing from the snapshot

Run `explain` on it — it names the exact reason and the rule responsible:

```bash
npx codebase-snapshot explain src/generated/schema.ts
```

`manifest.json` records the same for every file in `skipped[]`:

| `reason` | Meaning | Fix |
| :--- | :--- | :--- |
| `sensitive-file` | `.env`, `*.pem`, `.npmrc`, `.ssh/`, `.tfstate`, … | `--include-sensitive-files` if you really want it. |
| `sensitive-path` | The path itself matched a secret rule, so the file is skipped and its path is masked in every artifact. | Rename the file; a path that looks like a key is treated as one. |
| `binary` | Not text: it contains a NUL byte outside a UTF-16 stream, or is more than 1% control characters. The `detail` names the file size and the reason — including the offset of the first NUL when that byte sits past the 8 MB head scan. | Nothing to do. A UTF-16 file is *not* binary — it is transcoded and reported with `encoding`, not skipped. |
| `default-ignore` | A built-in rule, the preset's ecosystem ignores (`node_modules`, `__pycache__`, `target`, `vendor`, …), or the output directory. | A preset's ignores are not configurable; a custom `excludePatterns` can only remove more. |
| `excluded` | Your own `excludePatterns`, or a path outside a non-empty `include` allow-list. | Remove the pattern, or widen `include`. |
| `symlink` | Links are not followed (a directory link names its target in `detail`). | Snapshot the target. |
| `outside-root` | A link whose target resolves outside the scanned root. | Keep the target inside the repository, or snapshot it directly. |
| `gitignore` | A `.gitignore` excluded it, in a scan that is not reading git's index. | Remove the entry, or add the path to `include`. |
| `read-error` | Unreadable file. | Check permissions. |
| `not-file` | A directory, socket, FIFO. | Expected. |
| `nested-repository` | A nested checkout or submodule — a directory tracked by a different repository. | Expected; snapshot that repository separately if you need its code. |

Inside a git repository the candidate list comes from git, which applies `.gitignore` before
the scanner runs; those ignored paths are listed separately and recorded too, so a `.gitignore`d
file or directory appears here with reason `gitignore` in either mode.

A skipped directory is recorded, but the files inside it are never descended to and so have no
record of their own. For those, `explain` reports the **nearest skipped ancestor** and names it
in `detail`, whatever the reason — including built-in ignores:

```
node_modules/dep/index.js
  included   no
  reason     default-ignore
  detail     built-in ignore: directory "node_modules" (not descended) — inherited from the skipped directory `node_modules`
```

The same applies to a `.gitignore`d tree, where `detail` reads
``ignored by .gitignore — inherited from the skipped directory `ignored` ``.

`explain` can report two more, which never appear in `skipped[]` because they are about the
path rather than about a candidate file:

| `reason` | Meaning | Fix |
| :--- | :--- | :--- |
| `missing` | `no such file or directory, relative to the configured cwd` — nothing is at that path. | Check the path and `--cwd`. |
| `not-discovered` | `exists but is not tracked or is otherwise not a candidate` — the path exists but nothing accounts for it: no rule, glob or skipped ancestor explains it. The tool's own output directory is pruned this way, so a file under `snapshot/` reports it. | If it sits in a skipped directory you will normally get that directory's reason instead; otherwise copy it into the repository, since `include` cannot rescue a pruned directory. |

Also check `include`: if it is non-empty it acts as an allow-list, and everything else is
excluded.

## The snapshot is too big

- Lower the budget: `--max-part-bytes 120k`.
- Exclude whole trees: `excludePatterns: ["vendor/**", "**/*.min.js"]` in the config.
- Per-layer budgets: `budgets: { default: "120k", byLayer: { docs: 40000 } }`.
- Skip artifacts you do not read: `--skip-artifacts navigation,projectTree,audit`.
- Large files are already previewed rather than inlined; tune with `--large-file-bytes`.

## Warnings that are working as intended

These come from `generate`. They are recorded in `manifest.warnings` and repeated on stderr
under a `- Warnings: N` line in the summary, and none of them stops a run:

- `manifest.json is disabled: \`validate\` and \`report\` cannot inspect this snapshot.` — you
  used `--skip-artifacts manifest`.
- `parts are disabled but navigation.md is enabled: its links point at part files that were not written.`
- `every artifact is disabled: only the .codebase-snapshot ownership marker will be written.`
- A `hooks.afterGenerate` error is downgraded to a warning: the snapshot it was called for is
  already written and is not lost.
- `N file(s) exceed 2 MB and were not parsed for a structural summary: …` — the named files are
  emitted as head/tail previews without an `imports`/`exports` summary. Parsing them costs several
  times their own size in memory, which is how a single 50 MB source file used to reach 3.3 GB of
  resident memory. Nothing to fix; raise the part budget if the preview is too small.
- `N file(s) are UTF-16LE and were transcoded to UTF-8: …` — those files were UTF-16 and are
  now ordinary text in the snapshot. They are listed in `manifest.files[]` with
  `encoding: "utf-16le"`, or `"utf-16be"`. Nothing to fix; the warning exists because the bytes
  in the artifact are not the bytes on disk.
- `N file(s) are not valid UTF-8; M undecodable byte(s) became U+FFFD: …` — the named files are
  not UTF-8 at all (Latin-1 is the usual cause). They are kept, with `encoding: "utf-8-lossy"`,
  but the undecodable spans are substituted, so **do not hand the emitted body to a model as if
  it were the source**. Convert the file to UTF-8 (`iconv -f WINDOWS-1252 -t UTF-8 file > file.tmp`)
  and regenerate. The snapshot still validates as current, because the hash covers the raw bytes.

## Redactions in the summary are not warnings

If your run printed something like

```
   - Warnings:      0
   - Redacted:      78 line(s) — values masked; see snapshot/reports/audit.md
```

then nothing is wrong. That line counts **lines whose values were masked**, once per line even
when two rules matched the same line, and the per-line detail — file, line, every rule that
fired — is the table in `reports/audit.md` (section 1). The same number is
`manifest.totals.redactedLines`.

Three things surprise people about it, and all three are the intended trade-off:

- **`.env.example` and docs templates are masked too.** A placeholder such as
  `JWT_SECRET=replace-with-base64url-48-bytes` is masked exactly like a live key, because the
  rule cannot tell them apart — guessing which values are throwaway is how a real key escapes.
  The template is therefore less readable in the snapshot than on disk. Narrow it with
  `customPatterns` and `disableDefaultPatterns` (see
  [Configuration](configuration.md#secrets-redaction)).
- **Test fixtures count.** `process.env.DB_SECRET = "test-value"` is a credential assignment by
  shape, so it is masked and counted.
- **A long list is not a truncated list.** The `Warnings:` preview stops at ten rows and prints
  `… and N more in manifest.warnings[]`; redactions are never previewed in the summary at all —
  the count is stated and the table is the list.

If `reports/audit.md` was disabled with `--skip-artifacts audit`, the manifest keeps the count and
warns that the per-line detail was not written, rather than dropping it silently.

`validate` produces its own warnings, printed with a `⚠ ` prefix and never written to the
manifest, because they describe the state of the repository rather than the snapshot:

- `⚠ Working tree has uncommitted changes.`
- `⚠ Snapshot was generated on branch "zeta" but the configured branch is "main".` — the
  branch moved since the snapshot was written.

## Detached HEAD

On a detached HEAD (normal in CI) `manifest.git.branch` records the configured branch —
`main` by default — because a detached HEAD cannot name one. Set `branch` in the config if
your CI convention differs. This is not a warning condition.

## Not a git repository

Outside a repository the tool does not fail; it records what it can:

```json
{ "branch": "main", "commit": "unknown", "isDirty": false }
```

`branch` is the configured branch, `commit` is `"unknown"`, and `isDirty` is `false` because
there is no tree to compare — not because the tree is clean. Read `commit` when you need to
tell "no repository" from "clean repository", and do not treat `isDirty: false` alone as
evidence that the snapshot was taken from committed state.

## Still stuck

```bash
npx @ankurhalder/codebase-snapshot describe --format json > contract.json
npx @ankurhalder/codebase-snapshot generate --dry-run --format json > dry-run.json
```

The first is the machine-readable contract, including a troubleshooting table. The second
computes a full snapshot without writing anything, so you can inspect
`config`, `counts`, `skipped` and `warnings` before committing to a run.
