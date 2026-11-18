# Ask once, get cited context

An agent with a question and a token budget has three ways to spend it: guess which files to read,
run a tool that returns a plan, or run a tool that returns the context itself. `snapshot_answer` is
the third, and it is the one that answers the question rather than describing how to answer it.

## One call

```json
{ "name": "snapshot_answer", "arguments": { "question": "how does redaction decide what to mask?", "maxTokens": 20000 } }
```

The reply is a block: each planned file as a head window with line numbers, the planner reason it
was chosen, and, under "Not included", every planned file that did not fit with the reason. The
`usedTokens` figure is measured with the same estimator the manifest uses, so it is comparable with
every other number this tool prints.

## Why not `plan_for` plus `read`?

You can do that, and for a large investigation you may want to: the plan is cheaper and lets you
decide. `snapshot_answer` exists because the common case is one question and a budget, and in that
case the arithmetic (which file fits, how many lines of it, what to say about the rest) belongs in
the server, not in every client.

| Tool | Returns | Cost |
| :--- | :--- | :--- |
| `snapshot_plan_for` | paths, tokens, reasons, no content | cheap |
| `snapshot_read` | one file window by path and line | medium |
| `snapshot_answer` | planned windows within one budget, with reasons | medium |
| `snapshot_budget` | what several budgets would each select | medium |

## What it will not do

- **It will not invent a path.** Every window comes from a section in `parts/`.
- **It will not silently truncate.** A file that did not fit is named under "Not included"; a file
  that was cut says `first lines of N`.
- **It will not read the working tree.** Redaction and exclusions therefore still apply, and a file
  the snapshot excluded cannot be selected by asking nicely.
- **It will not exceed the budget silently.** If the first planned file alone is larger than the
  budget it is still returned, and the block says `first lines of N`; an empty answer would be
  worse than an oversized one that admits it.

## The CLI version of the same question

```bash
npx codebase-snapshot generate --slice "how does redaction decide what to mask?" --slice-tokens 20000
```

That writes a whole snapshot narrowed to the question, with `reports/selection.md` explaining every
choice. The tool is for an agent that needs the text now; the command is for a reader who wants the
selection on disk, auditable and reusable.
