# Using this with an AI agent

The package ships two things that make it usable by an agent that has never heard of it:
a **machine-readable contract** and a **bundled skill**.

Nothing here needs to be installed globally, and no prior knowledge of the tool is
required.

## The three commands an agent needs

```bash
# 1. Read the contract. This is the machine-readable replacement for --help.
npx @ankurhalder/codebase-snapshot@latest describe --format json

# 2. Write a commented config that lists every setting (non-interactive).
npx @ankurhalder/codebase-snapshot@latest init --yes

# 3. Generate and verify.
npx @ankurhalder/codebase-snapshot@latest generate
npx @ankurhalder/codebase-snapshot@latest validate
```

`describe` returns the invocation that works, an ordered `workflow` array, every command,
every option with its default, the exit-code contract, all 25 presets, the artifact list,
the config file names, the output layout, safety rules and a troubleshooting table — all
as JSON on stdout.

**Always pin the tag** (`@latest` or `@2`). A bare scoped spec can resolve to a bin-less
placeholder manifest on some npm builds and exit 0 printing nothing; the pinned form
cannot.

## The skill

```bash
npx @ankurhalder/codebase-snapshot@latest skill            # print it (stdout)
npx @ankurhalder/codebase-snapshot@latest skill --install  # write it into the repo
```

Printing goes to stdout deliberately, so it can be redirected:

```bash
npx @ankurhalder/codebase-snapshot@latest skill > SKILL.md
```

`--install` writes the same skill to every location agents look at by default:

| Target | Path | Read by |
| :--- | :--- | :--- |
| `agents` | `AGENTS.md` (a marked section) | most tools, by convention |
| `claude` | `.claude/skills/codebase-snapshot/SKILL.md` | Claude Code auto-discovery |
| `cursor` | `.cursor/rules/codebase-snapshot.mdc` | Cursor rules |

```bash
skill --install --target claude    # one location
skill --install                    # all three (default)
```

The install is **idempotent and non-destructive**: re-running replaces only the block
between `<!-- codebase-snapshot:skill:start -->` and
`<!-- codebase-snapshot:skill:end -->`, so an `AGENTS.md` that already documents your
conventions keeps them. `--format json` reports what was created, updated or unchanged.

`codebase-snapshot init` prints a reminder about this; it never installs the skill on its own.

## Why both a contract and a skill

The contract is for **doing** — it is the data an agent needs to pick correct commands and
options, and it is asserted against the real defaults in the test suite so it cannot drift
into lying.

The skill is for **knowing when to act** — it carries the trigger conditions, the ordered
workflow, and the surprises (sensitive files excluded by default, secrets redacted, the
output directory being tool-owned) that an agent cannot infer from a schema.

## Keeping the contract honest

`describe` is generated from the same code the CLI runs — the preset list, artifact names,
schema version and generator version are read directly, and a test compares its documented
defaults against a real `generate --dry-run` manifest. If a default changes, the test fails
rather than the contract silently misleading an agent.
