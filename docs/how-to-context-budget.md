# How to budget LLM context files for a codebase

Context is a budget, not a bin. Every token spent on a lockfile is a token not spent on the function
being asked about, and the failure is silent — the model simply gets vaguer. This page is about
choosing the numbers and knowing what they cost.

## Start from the destination, not the repository

Work backwards. The constraint is whatever consumes the output:

| Consumer | What actually limits you |
| :--- | :--- |
| A chat window | The window, minus room for the conversation and the answer |
| A RAG pipeline | Embedding chunk size, and how many chunks get retrieved per query |
| An agent loop | The window, minus tool schemas and minus the reasoning it has left to do |
| A review artifact | Human attention — usually far smaller than any window |

An agent needs room to *think*, so it wants the smallest context that answers the question. A chat
window can take the largest.

## The numbers that matter

- **`maxPartBytes`** — the hard ceiling for one part. This is a promise, not an average: no part
  exceeds it. Set it to the destination's limit and stop worrying about the largest file.
- **`largeFileBytes`** — above this, a file becomes a head/tail excerpt rather than its full body.
  This is what stops one generated 40 MB file from consuming an entire snapshot.
- **`budgets.byLayer`** — different ceilings per layer. Documentation is usually worth less per byte
  than source; `{ docs: 40_000 }` is a common shape.
- **`maxMonolithBytes`** — the single-file artifact roughly doubles output, so it is off by default
  and capped when on.

```js
const config = {
  maxPartBytes: "120k",
  largeFileBytes: "200k",
  budgets: { default: "120k", byLayer: { docs: 40_000, config: 20_000 } },
  artifacts: { monolith: false },
};
export default config;
```

## What each byte buys

Measured on this repository's own snapshot, as a rough guide:

| Layer | Share of bytes | Worth it? |
| :--- | :--- | :--- |
| Source | largest | yes — this is the question |
| Docs and comments | large | partly; often the best value per byte, but not when duplicated |
| Config | small | yes — it explains how the source runs |
| Tests | often 30–40% | rarely, for a code question |
| Generated and vendored | varies | almost never |

The cheapest large win in most repositories is excluding tests and build output. The second cheapest
is excluding duplicated documentation (the same content in a wiki, a `docs/` tree and a README).

## Do not trust a size estimate you have not measured

A snapshot is auditable: `manifest.json` records `includedBytes` and `includedLines` **measured from
the block actually emitted**, not from the file on disk. That distinction matters — a truncated file
does not report its on-disk size.

```bash
npx codebase-snapshot report
```

`report` prints totals, per-layer metrics and the secret audit, so you can see where the budget went
before you spend it on a model call.

## Tuning loop

1. Generate with a ceiling that matches the destination.
2. Run `report`; look at the per-layer breakdown.
3. Cut the largest layer that does not answer your question.
4. Re-generate and compare `manifest.totals.events` and the part count.
5. Keep the settings that produced a snapshot you actually used — the config is the durable artifact,
   not the output.

## The failure this prevents

Without a ceiling, the boundary is wherever the tool stopped. Two runs can cut differently, so a
worse answer is indistinguishable from a different cut. With `maxPartBytes` fixed and output
deterministic, a changed answer means changed code — which is the only interpretation that lets you
debug it.

## Next

- [Configuration](configuration.md) — every setting, all 25 presets
- [Snapshot output](output.md) — the full `manifest.json` schema
- [How to feed a codebase to an LLM](how-to-feed-a-repo-to-claude.md)
