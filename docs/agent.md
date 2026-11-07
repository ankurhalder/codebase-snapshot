# Using this with an AI agent

The package ships two things that make it usable by an agent that has never heard of it: a
**machine-readable contract** and a **bundled skill**.

Nothing needs to be installed globally and no prior knowledge of the tool is required.

## The three commands an agent needs

```bash
# 1. Read the contract. This is the machine-readable replacement for --help.
npx codebase-snapshot describe --format json

# 2. Write a commented config that lists every setting (non-interactive).
npx codebase-snapshot init --yes

# 3. Generate and verify.
npx codebase-snapshot generate
npx codebase-snapshot validate
```

The bare package name works; pin an exact version (`npx codebase-snapshot --version` prints the current one) when the same version must run on every
machine.

### One command instead of three

```bash
npx codebase-snapshot --autopilot
```

Sets the project up — config, npm scripts, devDependency, `.gitignore`, install — and generates,
with no prompts. It keeps an existing config, and `--no-install` avoids touching the lockfile.
`setup` is the same operation as a command word.

### Do not rely on the bare command

```bash
npx codebase-snapshot          # ❌ in an unconfigured project this exits 2
```

An agent has no terminal, so the guided first run cannot ask its question and refuses instead of
generating with settings nobody chose. That exit `2` is the tool being honest, not broken: say
which setup you want — `--autopilot`, `init --yes`, or `generate` on the documented defaults.

## The contract

`describe --format json` returns the whole tool as data on stdout:

| Field | Contents |
| :--- | :--- |
| `invocation` | The supported one-shot and installed commands, and the bin names. |
| `workflow` | An ordered six-step procedure: verify → understand → configure → generate → verify output → consume. |
| `commands` | Every command with what it does, its positionals and its exit codes. |
| `options` | Every option with its type, default, which commands it applies to, and a summary. |
| `exitCodes` | `0` success, `1` drift or refused generation, `2` usage error. |
| `presets` | All 25, with priority, recommended budget and ecosystem ignores. |
| `artifacts` | Each artifact with its on/off default and what it contains. |
| `config` | Every config filename and every setting with its default. |
| `output` | The directory layout and how to read `manifest.json`. |
| `safety` | What is excluded or redacted, and which directories are refused. |
| `troubleshooting` | Symptom → cause → fix. |

It is generated from the same code the CLI runs — presets, artifact names and versions are
read directly — and a test compares its documented defaults against a real
`generate --dry-run` manifest. If a default changes, the test fails rather than the contract
silently misleading an agent.

`describe` with no `--format` renders the same content for a human.

## The skill

```bash
npx codebase-snapshot skill            # print it (stdout)
npx codebase-snapshot skill --install  # write it into the repository
```

Printing goes to stdout deliberately, so it can be redirected:

```bash
npx codebase-snapshot skill > SKILL.md
```

`--install` writes the same skill into the registries agent tools read by name:

| Target | Path | Read by |
| :--- | :--- | :--- |
| `claude` | `.claude/skills/codebase-snapshot/SKILL.md` | Claude Code auto-discovery |
| `cursor` | `.cursor/rules/codebase-snapshot.mdc` | Cursor rules |

```bash
npx codebase-snapshot skill --install --target claude   # one registry
npx codebase-snapshot skill --install                   # both (default)
```

Both are **registries keyed by skill name**: the path carries `codebase-snapshot`, so the file
cannot be mistaken for your project's own documentation, and two skills cannot collide.

**It never writes `AGENTS.md`.** That file is the repository's own agent contract — build
commands, conventions, house rules — and an install that creates or edits it puts a tool's
marketing where the project's rules belong. If you want the skill in there, print it and paste
it, so the diff and the commit are yours:

```bash
npx codebase-snapshot skill >> AGENTS.md
```

The install is **idempotent**, and whatever it *creates* is appended to `.gitignore` in the
same run — these are a tool's files written into your repository, and `git status` should not
turn that into a decision about what to commit. A file that already existed is never ignored.
`--format json` reports what was created, updated or unchanged, and which ignore entries were
added.

`codebase-snapshot init` does none of this: it writes the config, the npm scripts, the
devDependency and the `.gitignore` entries for the snapshot directory, and nothing else.

## When the client speaks MCP

`codebase-snapshot mcp` serves the repository to a Model Context Protocol client over stdio: eight
tools, `snapshot://` resources and two prompts. Prefer it over shelling out when the agent already
has an MCP connection, for two reasons that are properties of the design rather than of the wiring:

- **Reads come from the snapshot, not the working tree.** `snapshot_read` extracts a file's section
  from the emitted part, so a file the snapshot excluded cannot be read back and a redacted value
  stays redacted.
- **Staleness is a first-class question.** `snapshot_validate` answers "has the code moved since
  this was built", which an agent with only a filesystem tool has no way to ask.

The tools are listed in [the MCP guide](mcp.md) and in the `mcp` block of
`describe --format json`. A `root` argument may name a sub-directory of the directory the server was
started for, and nothing outside it.

## Why both a contract and a skill

The contract is for **doing** — the data an agent needs to pick correct commands and options.
The skill is for **knowing when to act** — it carries the trigger conditions, the ordered
workflow, and the surprises an agent cannot infer from a schema: sensitive files excluded by
default, secrets redacted, the output directory being tool-owned.

## What an agent should avoid

- **Do not point `--out-dir` at source code.** It is refused, and the refusal is deliberate.
- **Do not add `--include-sensitive-files`** unless the user explicitly asked for credential
  files; by default they are excluded and recorded as `sensitive-file` in `manifest.skipped[]`.
- **Do not work around redaction.** If a value is masked, ask the user rather than reading the
  original file.
- **Do not assume exit 2 means the repository is broken.** It means the command was wrong.
  Re-read the contract.
- **Do not treat a bare `npx` that prints nothing as a repository problem.** A stale global
  install shadows `npx`; see [Troubleshooting](troubleshooting.md#the-command-does-nothing).

## Verifying an agent can drive it

`tests/agent-simulation.test.js` runs the published instructions as an agent would: read
`--help`, discover `describe`, then execute the six workflow steps in order against an 8-file
Django fixture.

It asserts what the contract promises at each step: `--version` prints a version, every
published option states where it applies, `init --yes` writes a config naming **every**
setting the contract lists, `generate --format json` exits `0` with
`validation.status: "passed"` and the preset `python-django`, every fixture file is either in
`manifest.files[]` or explained in `manifest.skipped[]`, each `files[]` entry carries its
classification and hash, and `validate` then exits `0`. If an agent following the published
words would fail, that test fails.

When you parse the manifest, remember what is conditional: `manifest.files[]` carries
`relativePath`, `layer`, `kind`, `language`, `part`, `inclusionMode` and `hashSha256` for
every included file, but `summary` and `summaryQuality` only for a language the tool can
analyse. A `.gitignore` or plain-text entry has neither key, and a file whose summary was too
large for its part carries `summaryOmitted: true` instead of a `summary`. `encoding` appears only
when a file was not plain UTF-8: `utf-16le`/`utf-16be` were transcoded, and `utf-8-lossy` means
the body you are reading contains `U+FFFD` where undecodable bytes were.
