# Fit a repository into a token budget

```bash
codebase-snapshot generate --budget-tokens 100000
```

A part budget truncates files to fit; a **token budget** selects whole files to fit. The difference
matters: a torn file gives a reader half a function, while a selected set gives them fewer
subsystems that are each complete.

## How it chooses

Every scanned file is scored once:

| Signal | Weight | Why |
| :--- | :--- | :--- |
| Entry point (`main`, `index`, `app`, `server`, `cli`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`) | +100 | Without it, nothing else makes sense. |
| Configuration layer | +40 | What the project is, before what it does. |
| Source layer | +20 | The code. |
| Test layer | −10 | Useful, but after the code it tests. |
| Importer count | up to +60, 6 per importer | A file many others import is load-bearing. |
| Cost | up to −40 | A cheap file that matters beats an expensive one that barely does. |

Files are taken in score order while the running token estimate fits; a file that would exceed the
budget is skipped whole, not cut. This planner uses one token per four bytes of emitted body. The
manifest's `estimatedTokens` is the structural `estimateTokens` result instead, so the two differ
by construction and neither is a tokenizer count.

## What it records

```json
"budget": {
  "maxTokens": 100000,
  "usedTokens": 96812,
  "files": ["package.json", "src/main.ts", "src/core.ts", "..."],
  "dropped": 418,
  "coverage": {
    "byLayer": { "config": { "kept": 3, "total": 3 }, "src": { "kept": 12, "total": 40 } },
    "entryPoints": { "kept": 2, "total": 2 },
    "symbols": { "kept": 18, "total": 61 }
  }
}
```

`coverage` is the honest half of the report: which layers kept what, how many entry points
survived, and how many exported symbols made it in. When an entry point is lost the run warns —
a snapshot without its entry point is a tour without a front door.

Every scanned path that did not fit is in `skipped[]` with reason `not-selected` and the detail
"did not fit the --budget-tokens budget". The brief states the budget, the selection size and the
drop count, so a reader knows what they are missing.

## When to use it

- "I have 128k of context and this repository is 2M tokens": this is the one-command answer.
- A first pass over an unfamiliar repository, before deciding what to read next.
- Pair it with `--delta` to spend the budget only on what changed.

It is not a replacement for `--slice`: a slice answers a question, a budget answers a limit, and
the CLI refuses both at once rather than guessing which narrowing you meant.
