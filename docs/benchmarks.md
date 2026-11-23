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
- **Tokens** — `manifest.totals.estimatedTokens`, the structural estimate the product reports.
  `estimateTokens` counts word runs, punctuation and newline runs; it is neither bytes/4 nor a
  tokenizer count, and every model tokenizes differently.
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

## Ten public repositories

```bash
node scripts/benchmark-suite.mjs              # the ten default repositories
node scripts/benchmark-suite.mjs --json       # the same run, as data
node scripts/benchmark-suite.mjs <url> ...    # your own list
```

Each repository is cloned shallow into a scratch directory, packed by all three tools, and the
clone is deleted. A repository that cannot be cloned is reported as skipped with the reason, never
dropped from the table. Measured at 0.14.5, repomix 1.19.0, gitingest from PyPI, and
re-run on 2026-11-18 at 0.17.55: all ten repositories packed by all three tools, every number
identical, which is what a deterministic scanner should do.

| Repository | Ours files | Ours tokens | repomix tokens | repomix / ours | gitingest bytes |
| :-- | --: | --: | --: | --: | --: |
| jonschlinkert/is-odd | 11 | 5,450 | 4,291 | 0.79 | 29,392 |
| chalk/chalk | 32 | 77,684 | 79,006 | 1.02 | 238,864 |
| tj/co | 19 | 12,996 | 9,189 | 0.71 | 74,613 |
| isaacs/minimatch | 85 | 319,879 | 64,846,987 | 202.72 | 1,800,672 |
| moment/luxon | 151 | 303,032 | 250,093 | 0.83 | 806,740 |
| psf/requests | 117 | 382,695 | 687,333 | 1.80 | 524,712 |
| pallets/click | 177 | 470,265 | 335,153 | 0.71 | 1,413,342 |
| expressjs/express | 215 | 261,829 | 198,639 | 0.76 | 792,177 |
| colinhacks/zod | 686 | 1,762,835 | 1,748,187 | 0.99 | 4,468,877 |
| anuraghazra/github-readme-stats | 131 | 205,009 | 169,079 | 0.82 | 553,367 |

Read it carefully:

- **The ratio is not a contest.** Our manifest estimate weighs word runs, punctuation and
  newlines; the byte-based budget planner uses one token per four bytes; repomix uses a tokenizer.
  Across nine repositories the two land within about plus or minus 30%, which is what two
  reasonable estimates of the same text do.
- **minimatch is the exception, and it is a policy difference, not an estimate.** That repository
  carries five benchmark fixtures of 20 to 25 MB of JSON. repomix emits them (64.8M tokens); our
  large-file rule emits a bounded preview and records the omission, so the pack stays 319,879 tokens.
  A pack that will not fit in a context window has not helped the reader, however complete it is.
- **gitingest publishes no token count**, so its column is the size of its one-document digest.
- **File counts agree within one or two** everywhere except minimatch, where our preview keeps the
  files and repomix keeps their bytes.

The point of ten repositories is not a leaderboard; it is that the shape holds outside the
repository the tool was written in.

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

repomix is fetched through `npx` at run time and gitingest through `python -m gitingest`;
neither is a dependency of this package. Measured on this repository at 0.14.2, repomix 1.19.0,
gitingest from PyPI, same machine:

| Tool / mode | Files | Content bytes | Tokens | vs full | Time |
| :-- | --: | --: | --: | --: | --: |
| codebase-snapshot (full) | 336 | 3,301,883 | 1,060,727 | 100% | 2.22 s |
| codebase-snapshot (slice) | 4 | 239,837 | 66,903 | 6.3% | 2.14 s |
| codebase-snapshot (budget 30,000) | 22 | 119,915 | 36,107 | 3.4% | 2.09 s |
| repomix 1.19.0 | 335 | 3,519,653 | 888,168 | 83.7% | n/a |
| gitingest | ? | 3,123,817 | n/a | n/a | n/a |

Read that honestly:

- **repomix reports fewer tokens for a similar pack** (854k against our 1.03M, 83%). The cause is
  the estimator, not the content: our manifest counts word runs, punctuation and newlines (the
  budget planner uses bytes/4), while repomix uses a tokenizer.
  Our number is conservative, which is the right direction for a budget — a plan that fits
  1,027,911 tokens fits a tokenizer count of 854,178 far more often than the reverse.
- **Our pack is smaller in bytes** (3.20 MB of file content against repomix's 3.39 MB of output,
  which includes its own wrappers), and the file sets differ slightly: 330 against 329.
- **The modes are what the other tool does not have.** repomix packs the repository; a slice and a
  budget are the same snapshot narrowed after scanning, at 6.5% and 3.5% of the tokens.
- **gitingest's digest is smaller in bytes** (3.12 MB against our 3.30 MB of file content), and it
  publishes no token count at all; the harness reports its digest size and says so. Its output is
  one flat document with a tree and a separator per file, which is why a byte comparison is the
  only honest one.

The same caveats apply to any comparison: different ignore rules, different wrappers, different
tokenizers. What is comparable is the shape — full packs are too large for a context window, and a
selection is one to two orders of magnitude smaller.