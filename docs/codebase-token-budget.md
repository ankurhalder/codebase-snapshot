# How many tokens is a codebase?

Before choosing a part budget, know the order of magnitude. A token is roughly 3.5–4 bytes of
English prose; source code is denser, usually **3.3–3.7 bytes per token** because identifiers,
punctuation and indentation tokenise less efficiently than words.

The rule that survives contact with real repositories:

```text
tokens ≈ bytes / 3.5        ≈ lines × 11
```

## A measured example

This repository, measured rather than estimated:

| | |
| :--- | ---: |
| TypeScript files under `src/` | 57 |
| Lines | 14,626 |
| Bytes | 603,420 |
| **Estimated tokens** | **≈ 165,000** |

That single number decides the whole conversation. 165k tokens does not fit in an 8k window, it
almost exactly fills a 200k window leaving nothing for the question or the answer, and it fits
in a 1M window without effort.

## What the default part budget means

`maxPartBytes` defaults to **307,200 bytes (300 KB)** per part, which is roughly **84,000
tokens**. If your model's window is 128k, one part plus a prompt and a reply fits, and the second
part has to go in a separate conversation — which is exactly what the parts are for.

| `maxPartBytes` | ≈ tokens per part | Fits comfortably in |
| :--- | ---: | :--- |
| `60k` | ≈ 16k | 32k windows, small chat prompts |
| `120k` | ≈ 33k | 128k windows with room for a long answer |
| `300k` (default) | ≈ 84k | 200k windows, one part per session |
| `1mb` | ≈ 280k | 1M windows, or a summarising pass first |

Set it from the destination, not from taste:

```bash
codebase-snapshot generate --max-part-bytes 120k
```

## Sizing the window, not just the code

A window has to hold three things, and only the middle one is your snapshot:

```text
[ system prompt + instructions ] + [ snapshot parts ] + [ the answer ]
```

A rough allocation that works: **never spend more than 70% of the window on the snapshot**, and
leave at least 8k tokens for the reply. On a 128k window that caps you at ~82k tokens of
context — about one 300k-byte part.

If you are re-reading several parts in one conversation, the sum is what matters, not the
budget of any single part.

## When the repository does not fit

It usually does not. 165k tokens is a small library; a real application is five to twenty times
that. In order of preference:

1. **Scope the run, not the budget.** `include`/`exclude` patterns, or the wizard's "only
   specific folders" option, cut more than any budget change. Packing the thing you are asking
   about beats packing the repository.
2. **Let the layers do the work.** The detected preset groups files into layers, and
   `reports/navigation.md` maps every file to the part it landed in — read the index, open one
   part, instead of feeding everything.
3. **Raise the budget and lower the count.** One 300k part is easier to reason about than six
   60k parts, and cheaper in prompt overhead.
4. **Summarise once, in a separate session.** Ask the model for a map of the parts, then use that
   map to choose which parts to read in detail.

What not to do: silently truncate. A snapshot never exceeds its budget — a file too large for
the remaining space is cut with an explicit omission marker that names the budget, and above
`largeFileBytes` it becomes a head/tail excerpt rather than a full body.

## Checking your own number

The manifest records what was actually written, so you never have to guess:

```bash
codebase-snapshot report --format json \
  | jq '{files: .manifest.counts.totalFiles, bytes: .manifest.counts.totalSizeBytes, parts: .manifest.counts.partsCount}'
```

`totalSizeBytes / 3.5` is your token estimate for the run. If it is far from the window you
intended to fill, the budget was not the problem — the selection was.

## Related

- [Budgeting LLM context](how-to-context-budget.md) — choosing ceilings per layer
- [Feeding a repo to an LLM](how-to-feed-a-repo-to-claude.md) — the end-to-end recipe
- [Configuration](configuration.md) — `maxPartBytes`, `largeFileBytes`, `maxMonolithBytes`
