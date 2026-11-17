# Benchmarks

Three ways to pack the same repository, measured on this repository itself. The numbers are generated
by [`scripts/benchmark.mjs`](https://github.com/ankurhalder/codebase-snapshot/blob/main/scripts/benchmark.mjs), which
anyone can run:

```bash
node scripts/benchmark.mjs /path/to/repo "the question to slice for"
```

The run below used the default question, on the repository at 0.12.34: 313 files, 987,750 estimated
tokens in full.

| Mode | Files | Parts | Tokens | vs full | Time |
| :-- | --: | --: | --: | --: | --: |
| full | 313 | 11 | 987,750 | 100% | 1.66 s |
| slice | 4 | 1 | 66,430 | 6.7% | 1.57 s |
| budget (30,000) | 21 | 1 | 36,315 | 3.7% | 1.55 s |

## What the columns mean

- **Files** — entries in `manifest.files`, i.e. what the parts actually carry.
- **Parts** — part files written. A budget/slice snapshot tends to be one part because it fits.
- **Tokens** — `manifest.totals.estimatedTokens`, the same estimate the product reports. It is one
  token per four bytes of emitted body, not a tokenizer count; every model tokenizes differently.
- **vs full** — token share of the full snapshot.
- **Time** — wall clock for the whole `generate` process, including scan, parse, partition and write.

## What to take from it

1. **The full snapshot is usually too large to paste.** Under a million tokens for this repository is
   typical for a mature codebase; a 200k-token window cannot hold it.
2. **A slice is two orders of magnitude smaller and still coherent**: four files that the planner
   judged relevant, with their bodies intact.
3. **A budget is the "fit the window" answer**: 21 whole files at 3.7% of the tokens, chosen by entry
   point, importer count and layer rather than by alphabetical order.
4. **Generation is not the bottleneck.** All three modes take about the same time; the saving is in
   what gets written, not in what gets read.

## Honest limits

- Self-benchmark. This repository is TypeScript with a clean import graph; a vendored monorepo with
  a thousand dependencies will score differently, and a repository with no imports at all gives the
  planner little to rank.
- One machine, one run. The times are indicative, not a controlled benchmark; the token counts are
  deterministic for a fixed repository and configuration.
- These are **our** modes, not a head-to-head against other tools. A comparison needs the same
  repository, the same budget and both tools' own token accounting, and that is a separate exercise.
