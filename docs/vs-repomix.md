# codebase-snapshot vs repomix

Both tools answer the same question — *how do I hand a whole repository to a model that cannot
clone it?* They disagree about almost everything else. This page states where each one is the
better choice, including where repomix clearly is.

> Written by the author of `codebase-snapshot`. Numbers are the maintained project's own claims at
> the time of writing, and the comparison is deliberately unkind to this project where it deserves
> it.

## The short version

**repomix** packs a repository into one AI-friendly file. It is the established tool in this space
by a wide margin — tens of thousands of stars, an MCP server, remote repository URLs, and an
ecosystem of integrations.

**codebase-snapshot** produces *size-budgeted parts* rather than one file, and treats the snapshot
as something that can go stale and be proven current. Its distinguishing features are a hard byte
ceiling per part, deterministic output, and `validate`.

If you want the most popular, most integrated tool: **use repomix.**

## Side by side

| | codebase-snapshot | repomix |
| :--- | :--- | :--- |
| Output shape | Multiple parts, each under a hard byte budget, plus a JSON manifest | A single packed file (XML, Markdown or JSON) |
| Hard size ceiling | **Yes** — `maxPartBytes` is a ceiling, not a target | Token counting and warnings; no per-artifact ceiling |
| Reproducible output | Parts are byte-identical across runs; a fingerprint covers them | Content is stable; no published determinism guarantee |
| Staleness check | `validate` re-hashes the repository and exits non-zero on drift | Not a feature |
| Remote repositories | No — operates on a local checkout | **Yes** — packs a GitHub URL directly |
| MCP server | No (planned) | **Yes** |
| Secret handling | 30 default rules, value-span masking, per-line audit table | Secretlint integration |
| Language awareness | 25 presets, AST or structural summaries labelled by confidence | Tree-sitter parsing with a compression mode |
| Adoption | New | **Mature** — large user base, many integrations |
| Runtime | Node.js ≥ 18, one dependency | Node.js, npm package |

## Where repomix is the better choice

- **You want one file.** Pasting a single artifact into a chat is simpler than assembling parts, and
  repomix is built around that workflow.
- **You need a remote URL.** `repomix --remote https://github.com/owner/repo` works without a clone.
  This project has no equivalent.
- **You want MCP.** repomix ships an MCP server today; this project does not, yet.
- **You want the ecosystem.** More stars, more tutorials, more people who have already hit your
  problem.
- **You are packing something enormous and prefer compression to budgets.** repomix's tree-sitter
  compression mode is a different bet — shrink the content — and on very large repositories it may
  suit you better than partitioning.

## Where this is the better choice

- **You need a guarantee, not a best effort.** `maxPartBytes` promises no part exceeds the ceiling;
  a file too large is truncated with an explicit marker naming the budget. If a downstream system
  rejects payloads above a size, a warning is not enough.
- **You need to know the snapshot still matches the code.** `validate` compares every file hash
  *and* a digest of the settings the snapshot was generated with, so a changed budget or secret
  pattern counts as drift. That makes "is my context current?" a CI-gateable question.
- **You need byte-identical output.** Two runs over unchanged input produce identical `parts/`, so a
  snapshot can live in review, be diffed, or be cached by hash.
- **You need a machine index.** `manifest.json` records every included file *and every excluded file
  with a reason*, which is what makes `explain <path>` able to answer "why is this not in here?".
- **You want the tool to be drivable by an agent without documentation.** `describe --format json`
  emits the whole contract, and `skill --install` writes a skill into the registries agent tools
  read.

## Both at once

There is no conflict. A common arrangement is to use this tool for the *budgeted, validated* case
(CI, RAG ingestion, anything automated) and repomix when a human wants one file to paste into a
chat. They read the same repository and write to different directories.

```bash
npx codebase-snapshot setup          # config, scripts, dependency, install, generate
npx codebase-snapshot validate       # exit 0 means the snapshot matches the disk
```

## Honest summary

repomix is the safer recommendation for most people today, because maturity and integrations matter
more than any single feature. This tool exists for the narrower case where a size ceiling, a drift
check and reproducibility are requirements rather than nice-to-haves — and for the case where an
agent has to operate it without a human reading the docs first.
