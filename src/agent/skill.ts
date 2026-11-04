import { GENERATOR_VERSION } from "../version.js";

const PACKAGE_NAME = "codebase-snapshot";

/**
 * Major version of the build that ships this skill.
 *
 * The verify step probes the floating `@latest` tag, so it may only compare the
 * major: the tag can lag or lead the release, and an exact patch would make the
 * skill's first instruction impossible to satisfy.
 */
const MAJOR_VERSION = GENERATOR_VERSION.split(".")[0];

/** Name of the skill as agents see it (directory name, frontmatter `name`). */
export const SKILL_NAME = "codebase-snapshot";

/**
 * The agent skill shipped with the package.
 *
 * Written for an agent that has never heard of this tool: it says what the tool
 * is for, gives the exact commands, and tells the agent to read the
 * machine-readable contract before acting. It is generated from a template rather
 * than shipped as a file so that `codebase-snapshot skill`, `codebase-snapshot skill --install` and the
 * bundled CLI can never drift from each other or from the package version.
 */
export function renderSkill(): string {
  return `---
name: ${SKILL_NAME}
description: Create an LLM-ready snapshot of a repository (size-budgeted markdown parts, a JSON manifest, project tree, navigation and a secret audit) when a whole codebase has to be read, summarized or handed to a model that cannot clone it. Use when asked to snapshot a codebase, prepare repository context, or analyze a project's structure.
version: ${GENERATOR_VERSION}
---

# codebase-snapshot

Turns a repository into an LLM-ready snapshot under \`./snapshot/\`: code packed into
size-budgeted markdown parts, plus a manifest that indexes every file, a project tree, a
navigation index and a secret audit.

Use it when you need to understand a whole repository, or produce repository context for
another model, and reading files one by one would not fit in context.

## Before you start

This tool is a Node CLI. It needs **Node.js 18 or newer**. You do not need to install it
globally, and you do not need to clone anything.

**Pin a version** — \`npx ${PACKAGE_NAME}@${GENERATOR_VERSION} <command>\` — when you
need the same version on every machine. The bare package name works too: this package ships
one executable file, published under two names (\`codebase-snapshot\` and \`snap\`), which is what
lets npm pick it. If a command exits 0 printing nothing,
the executable was not resolved — clear the npm cache and retry; do not assume the repository
is broken.

## Step by step

1. **Verify the tool.** Run \`npx ${PACKAGE_NAME}@latest --version\`. Expect \`v${MAJOR_VERSION}\` or
   newer on stdout — compare the major version, not the patch, because the
   \`@latest\` tag can lag this release. If what it prints is older, pin the exact
   release (\`@${GENERATOR_VERSION}\`) instead of retrying. Empty output means you hit the
   bare-spec problem above.

2. **Read the contract, not the prose.** Run
   \`npx ${PACKAGE_NAME}@latest describe --format json\`. It returns the full machine
   contract: every command, every option with its default, the exit-code meanings, the
   25 project presets, the artifact list, the config settings and a troubleshooting
   table. Read it before you make decisions; do not guess option names.

3. **Look before you leap (optional but cheap).** To see how a specific file or directory
   would be treated, run \`npx ${PACKAGE_NAME}@latest explain <path>\`. It reports the
   layer, kind, language, target part, and the exact reason a path would be skipped.
   \`--format json\` if you want to parse it.

3b. **One command, if the user just wants it working.** \`npx ${PACKAGE_NAME}@latest setup\`
   does steps 4–6 in one go with defaults: it writes the config (an existing one is kept),
   adds the npm scripts and the devDependency, installs with the project's package manager,
   and generates. Use \`--no-install\` when the machine is offline or the user does not want
   their lockfile touched. Prefer the explicit steps below when you need to control any of
   those, or when something fails and you want to see which part.

4. **Configure (recommended).** Run \`npx ${PACKAGE_NAME}@latest init --yes\`. It detects
   the project shape, then writes a commented config file listing **every** setting at its
   current value. The filename depends on the project: \`snapshot.config.ts\` only when
   the running Node can strip types (Node >= 22.6) **and** the project is an ES module
   (\`"type": "module"\` in package.json); otherwise \`snapshot.config.mjs\`. Pass
   \`--preset <name>\` only if detection is wrong; the preset names are in the contract.
   This step is optional: without a config the tool runs on the same defaults.

5. **Generate.** Run \`npx ${PACKAGE_NAME}@latest generate\`. Expect exit 0 and a
   \`./snapshot/\` directory. If you need a different location use \`--out-dir <path>\`; if
   you need smaller or larger parts use \`--max-part-bytes 120k\`.

6. **Verify.** Run \`npx ${PACKAGE_NAME}@latest validate\`. Exit 0 means the snapshot
   matches the files on disk. Exit 1 means drift — re-run step 5.

7. **Read the output in this order:**
   - \`snapshot/parts/part-*.md\` — the code itself, each file tagged with its layer, kind,
     language and, when it fits the budget, a structural summary (imports, exports,
     classes, functions). A dropped summary appears as a \`Summary: (omitted …)\` line.
   - \`snapshot/manifest.json\` — the index. \`files[]\` has \`relativePath\`, \`layer\`,
     \`kind\`, \`language\`, \`part\`, \`inclusionMode\` and \`hashSha256\`, plus \`encoding\`
     when the file was not plain UTF-8. \`summary\` is **optional**: it is absent for
     languages with no structural summary, and \`summaryOmitted: true\` marks one dropped
     to fit the part budget — never assume it exists.
     \`skipped[]\` records every excluded file **and why**. Prefer querying this over
     re-reading the parts.
   - \`snapshot/reports/audit.md\` — secrets found, large files, parse diagnostics, git
     state. Read this before you quote code back to a user.
   - \`snapshot/reports/project-tree.md\` and \`navigation.md\` — structure and cross-links.

## Project types

Detection is automatic and covers Next.js, Nuxt, SvelteKit, Remix, Astro, Angular, Solid,
Vue+React with Vite, Nest, Express/Fastify/Koa, any Node library, monorepos, Django,
FastAPI/Flask, plain Python, Go, Rust, Java/Spring, .NET, PHP/Laravel, Ruby/Rails,
Terraform/Docker infra, docs-only repositories, and a generic fallback. It sets sensible
layers, kinds, ecosystem ignore patterns and a recommended part budget. For non-TypeScript
languages it extracts imports, exports, classes and functions structurally; Vue, Svelte and
Astro script blocks go through the real TypeScript compiler. You do not need to configure
any of this to get a good first snapshot.

## Things that will surprise you

- **Sensitive files are excluded by default** (\`.env\`, \`*.pem\`, \`.npmrc\`, \`.ssh/\`,
  \`.tfstate\`) and are listed in \`manifest.skipped[]\`. Add \`--include-sensitive-files\` only
  if the user asks for them explicitly.
- **Secret-shaped strings inside normal source files are redacted** in the emitted parts.
  If the user needs the raw value, say so rather than working around it.
- **The output directory is owned by the tool.** It is replaced atomically, and the tool
  refuses to replace a directory it did not create. Never point \`--out-dir\` at source
  code; if you see \`Refusing to replace outDir\`, choose a new directory rather than
  deleting anything.
- **Exit 2 is a usage error**, not a failure of the repository. Re-read the contract
  before retrying.
- **\`--format json\` keeps stdout pure.** Progress goes to stderr, so \`stdout\` is safe to
  pipe into a JSON parser.

## Making this available to other agents

Run \`npx ${PACKAGE_NAME}@latest skill --install\`. It writes this skill into the two
registries agent tools read by name — \`.claude/skills/${SKILL_NAME}/SKILL.md\` and
\`.cursor/rules/${SKILL_NAME}.mdc\` — and appends exactly those files to \`.gitignore\`, so the
install leaves nothing untracked. It is idempotent, and it refuses a target that resolves
outside the repository, so a linked \`.claude/\` cannot be used to write elsewhere.

It never writes \`AGENTS.md\`. That file is the repository's own agent contract — build
commands, conventions, house rules — and this tool has no business editing it. If you want
this skill in there, run \`npx ${PACKAGE_NAME}@latest skill\` and paste the text yourself: the
diff, and the commit, are then yours.
`;
}
