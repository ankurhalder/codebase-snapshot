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
- These are **our** modes. The head-to-head is below, with both tools' own accounting.

## Head-to-head against repomix

```bash
node scripts/compare.mjs --repomix      # add --json for machine-readable output
```

repomix is fetched through `npx` at run time; it is never a dependency of this package. Measured on
this repository at 0.12.65, repomix 1.19.0, same machine:

| Tool / mode | Files | Content bytes | Tokens | vs full | Time |
| :-- | --: | --: | --: | --: | --: |
| codebase-snapshot (full) | 330 | 3,197,091 | 1,027,911 | 100% | 2.14 s |
| codebase-snapshot (slice) | 4 | 239,395 | 66,653 | 6.5% | 2.13 s |
| codebase-snapshot (budget 30,000) | 24 | 119,701 | 36,261 | 3.5% | 2.07 s |
| repomix 1.19.0 | 329 | 3,386,284 | 854,178 | 83.1% | n/a |

Read that honestly:

- **repomix reports fewer tokens for a similar pack** (854k against our 1.03M, 83%). The cause is
  the estimator, not the content: we count one token per four bytes, repomix uses a tokenizer.
  Our number is conservative, which is the right direction for a budget — a plan that fits
  1,027,911 tokens fits a tokenizer count of 854,178 far more often than the reverse.
- **Our pack is smaller in bytes** (3.20 MB of file content against repomix's 3.39 MB of output,
  which includes its own wrappers), and the file sets differ slightly: 330 against 329.
- **The modes are what the other tool does not have.** repomix packs the repository; a slice and a
  budget are the same snapshot narrowed after scanning, at 6.5% and 3.5% of the tokens.
- **gitingest is not installed here** (`python -m gitingest` is missing). The harness supports it —
  `--gitingest` — and reports its digest size, not a token count, because it does not publish one.

The same caveats apply to any comparison: different ignore rules, different wrappers, different
tokenizers. What is comparable is the shape — full packs are too large for a context window, and a
selection is one to two orders of magnitude smaller.
