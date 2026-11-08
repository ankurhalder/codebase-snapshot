# AGENTS.md

Guidance for AI agents working **in this repository**, and for agents that consume the
published package.

## Consuming the package

The package ships its own agent skill and a machine-readable contract. Do not guess commands:

```bash
npx codebase-snapshot describe --format json   # the full contract
npx codebase-snapshot skill                   # the skill, on stdout
npx codebase-snapshot skill --install         # into .claude/skills + .cursor/rules
```

Read [docs/agent.md](docs/agent.md) first. In short: `setup` — config, scripts, dependency, install
and generate in one command — or step by step: `init --yes` → `generate` → `validate`.
`generate --autopilot` is the same one-command path from the default command.
Pin an exact version — `npx codebase-snapshot --version` prints the current one — when the same version must run everywhere.

**The bare command is not the safe default for a machine.** In a project with no configuration,
`npx codebase-snapshot` with no command word asks one question, and with no terminal it exits `2`
instead of generating with defaults nobody chose. That is deliberate (see rule 1 below): name what
you want — `generate`, `--autopilot`, or `init --yes` — rather than retrying the same command.

`skill --install` deliberately does **not** write `AGENTS.md`. That file is a repository's own
agent contract, and this tool has no business editing one — it installs into the two registries
keyed by skill name, and gitignores what it creates. An agent file that wants the skill in it
should paste the output of `skill`, so the commit belongs to that repository.

The installable skill's canonical text lives in `src/agent/skill.ts` and is rendered by
`codebase-snapshot skill` — do not hand-edit a generated copy.

If the agent runs inside an MCP client, `npx codebase-snapshot mcp` serves the repository as eight
tools over stdio instead of shelling out. Reads come from the snapshot rather than the working
tree, so excluded and redacted content stays out of context. See [docs/mcp.md](docs/mcp.md).

## Working in this repository

**Stack.** TypeScript (strict, `noUnusedLocals`, `noUnusedParameters`, ES2022, NodeNext),
bundled with tsup to ESM + CJS + type definitions. Tests use `node --test`. The only runtime
dependency is `typescript`; keep it that way — the zero-dependency property is a feature.

**Layout.**

| Path | Contains |
| :--- | :--- |
| `src/index.ts` | `generateSnapshot`, the public surface, output-directory guards |
| `src/cli.ts` | argument parsing, every command, exit codes |
| `src/config.ts` | config discovery, validation, `resolveConfig` |
| `src/scanner/` | file collection, git info, ignores |
| `src/ast/` | TypeScript parsing and the language profiles |
| `src/presets/` | the 25 presets and detection |
| `src/partitioner/` | budgeting and part rendering |
| `src/wizard/` | interactive setup and the config template |
| `src/agent/` | the machine contract and the bundled skill |
| `src/mcp/` | the MCP server: protocol, transport, tools, resources, prompts |
| `src/validator/` | drift detection |
| `tests/` | unit and integration suites |

**Rules that are load-bearing — do not break them:**

1. **No silent fallbacks.** An unknown preset, an unparseable config, an invalid budget and an
   unrecognised flag are all hard errors. If a setting cannot be applied, say so.
2. **Never destroy user data.** The output directory is only replaceable when this tool wrote
   it, and the proof is evidence rather than a filename: `.codebase-snapshot` is a JSON record
   (generator, schema version, run id, state, manifest digest, inventory of every file written)
   and the directory may contain nothing outside that inventory. A hand-written marker whose
   recorded digests do not match the directory is not evidence.
3. **Never leak secrets.** Sensitive files stay out unless explicitly requested; redaction masks
   only the matched span and no excerpt of a matched line reaches an artifact.
4. **Progress to stderr, payload to stdout.** `--format json` must keep stdout parseable.
5. **The contract must not lie.** `describe` is generated from code, and a test compares its
   defaults against a real `generate --dry-run` manifest. Update both together.

**Before you commit.**

```bash
npm run check     # lint + typecheck + tests
npm run build
```

`scripts/lint.mjs` enforces LF endings, no `any` in `src`, console usage only in
`src/cli.ts`/`src/bin.ts`/`scripts/`, and comment/formatting rules. `npm run verify` is
lint + typecheck + tests + a tarball check, and is exactly what the publish workflow runs
before it uploads — there is no separate CI matrix to wait for.

**Windows note.** The repository ships `.gitattributes` with `eol=lf`; a checkout with
`core.autocrlf=true` will otherwise fail the lint rule on untouched files.

## Conventions

- Commits: `type: summary` (`feat`, `fix`, `docs`, `ci`, `chore`), with a body explaining the
  *why* and what was verified. Breaking changes get a `!`.
- Documentation changes belong with the behaviour change, in the same commit.
- Prefer a narrow fix with a test over a broad refactor without one.
