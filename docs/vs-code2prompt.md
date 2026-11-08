# codebase-snapshot vs code2prompt

`code2prompt` is a Rust CLI that renders a codebase through a Handlebars template into a prompt. The
templating is the feature — it decides the shape of what you get. This tool decides the *size and
the freshness* of what you get, and leaves the shape to a manifest. They are close to opposites,
which makes choosing between them straightforward.

> Written by the author of `codebase-snapshot`. code2prompt is a separate project; the summary
> reflects its commonly documented behaviour at the time of writing rather than a benchmark.

## The short version

**code2prompt** — you write a template, it renders your repository into it. Output shape is entirely
yours.

**codebase-snapshot** — output shape is fixed and predictable: budgeted Markdown parts, plus a JSON
manifest with hashes. You tune what goes in, not what the page looks like.

If the prompt format is the thing you care about: **use code2prompt.**

## Side by side

| | codebase-snapshot | code2prompt |
| :--- | :--- | :--- |
| Output shape | Fixed: parts + `manifest.json` + reports | **Yours** — Handlebars template |
| Custom prompt scaffolding | No — that is out of scope | **Yes**, the core feature |
| Hard size ceiling | **Yes** — `maxPartBytes` | Not to this project's knowledge |
| Staleness check | `validate` exits non-zero on drift | Not a feature |
| Reproducible output | Byte-identical parts, with a fingerprint | Template-driven; no determinism guarantee |
| Distribution | Node.js, npm | Single Rust binary, no runtime |
| Machine index | `manifest.json` with hashes and skip reasons | Template output only |
| Language awareness | 25 presets, AST/structural/heuristic summaries | Template access to file contents |
| Secret handling | 31 defaults, value-span masking, audit table | Ignore rules |

## Where code2prompt is the better choice

- **You need a specific prompt structure** — a system preamble, per-file headers, a task framing.
  Templates are the right abstraction and this tool has no answer to them.
- **You want a single binary with no runtime.** Rust means no Node install on the target machine.
- **You are generating prompts, not context artifacts.** If the output is a prompt, you want a
  templating engine.

## Where this is the better choice

- **You need the output to fit a budget.** `maxPartBytes` is a ceiling: an oversized file is
  truncated with an omission marker naming the budget rather than silently blowing the limit.
- **You need to detect staleness.** `validate` compares every file hash plus a digest of the
  generation settings, so a changed budget counts as drift. Prompt generators generally have no
  concept of a snapshot that can expire.
- **You need reproducibility.** Frozen output means the artifact can be diffed in review or cached by
  hash — not just regenerated and hoped over.
- **You need to explain exclusions.** `manifest.skipped[]` names a reason for every path left out;
  `explain <path>` answers for one.
- **You need an agent to run it unaided.** `describe --format json` is the whole contract as data.

## Both at once

Legitimate and common: generate the parts with this tool, then reference those parts from a template
you render yourself. The two are not competing for the same slot — one produces a payload, the other
produces a prompt that might contain it.

## Honest summary

If your problem is *"my prompt is not structured the way I want"*, code2prompt solves it and this
tool does not. If your problem is *"my context does not fit, and I cannot tell whether it is still
accurate"*, that is this tool's entire reason to exist.
