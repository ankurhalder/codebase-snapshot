# codebase-snapshot vs gitingest

`gitingest` is the fastest path from *a GitHub URL* to *text in your clipboard*: paste a link on a
web page and get a digest back, with no install at all. This page says where that is better than
this tool, and where it is not.

> Written by the author of `codebase-snapshot`. gitingest is a separate project; the summary below
> reflects how it is commonly used at the time of writing rather than a benchmark of it.

## The short version

**gitingest** is a web service plus a Python package that turns a repository into a single digest
you can paste into a prompt. Its great strength is that it needs nothing installed and no thought.

**codebase-snapshot** runs locally, writes partitioned output under a hard byte budget, and can tell
you later whether the snapshot still matches the code.

If you want to paste a repo into a chat right now: **use gitingest.**

## Side by side

| | codebase-snapshot | gitingest |
| :--- | :--- | :--- |
| Getting started | `npx codebase-snapshot setup` (Node.js ≥ 18) | Open a website and paste a URL |
| Install required | Yes | **No**, for the hosted version |
| Works offline | **Yes** — local filesystem only | The hosted flow needs the network |
| Output shape | Parts under a hard byte budget, plus a JSON manifest | One digest |
| Hard size ceiling | **Yes** — `maxPartBytes` | Not to this project's knowledge |
| Staleness check | `validate` exits non-zero on drift | Not a feature |
| Reproducible output | Byte-identical parts across runs, with a fingerprint | Not a published guarantee |
| Excluded-file accounting | Every skipped path recorded with a reason | Ignore rules applied |
| Secret redaction | 30 default rules, value-span masking, audit table | Relies on ignore rules |
| Runtime | Node.js | Python |
| Repo URL input | No — needs a checkout | **Yes** |

## Where gitingest is the better choice

- **You have not installed anything and do not want to.** Nothing here competes with a URL box.
- **You want one digest, not parts.** If the destination is a chat window, one blob is the right
  shape.
- **You are in Python.** `pip install gitingest` fits an existing pipeline without adding a Node
  runtime.
- **You are exploring.** Pointing at a repository you have never seen is what it is for.

## Where this is the better choice

- **The repository must not leave your machine.** This tool never makes a network request; it reads
  the local tree. If the code is private enough that a hosted digest is not allowed, that settles it.
- **You need a size guarantee.** A part either fits the budget or carries an explicit truncation
  marker naming the budget. A digest that grows with the repository eventually stops fitting, and
  discovering that at ingestion time is too late.
- **You need to prove the context is current.** `validate` re-hashes the tree and compares a digest
  of the generation settings, so a stale snapshot fails instead of quietly misleading a model.
- **You need the exclusions explained.** Every skipped path carries a reason — `binary`, `gitignore`,
  `sensitive-file`, `nested-repository`, `read-error` and so on — and `explain <path>` answers for
  any single file.
- **You need automation.** Exit codes, a machine-readable contract and a manifest make this
  gate-able; a copy-paste digest is not.

## Both at once

They compose naturally: use gitingest to look at an unfamiliar repository quickly, and this tool
once the repository is one you maintain and want context generated reproducibly.

## Honest summary

For a one-off look at someone else's repository, gitingest is better and always will be — it wins
on friction, and friction is what most people are short of. This tool is for codebases you own and
pipelines you maintain, where a ceiling, a drift check and an audit trail are the point.
