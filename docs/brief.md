# The brief: the half only you can write

`PROMPT.md` is generated, and part of it cannot be. The manifest can prove which files are here,
which were skipped and why, what the system map is and what the standard requires. It cannot know
what the software is *for*, what has already gone wrong, or which failures this team would
recognise. That is judgement, so it is supplied as a file and merged into the brief.

```bash
# init writes BRIEF.md next to the config, with the five headings and guidance in comments
npx codebase-snapshot init --yes

# then enable it with one edit, or name your own file on the command line
npx codebase-snapshot generate --brief docs/brief.md
```

```js
// snapshot.config.mjs
export default {
  brief: "BRIEF.md",        // relative to the project root; a missing file is an error
  promptTask: "audit",      // audit | review | explain
};
```

## The five headings

| Heading | What happens |
| :--- | :--- |
| `## Stakes` | rendered as its own section, right after the job |
| `## The system` | replaces the generated narrative; the measured facts still follow under "What the index records" |
| `## What came before` | rendered above the generated commit ledger |
| `## The bar` | replaces the standard |
| `## Calibration` | replaces the example failures |

Any other `##` heading is kept, verbatim, under **Owner notes**. Nothing is dropped because the
merge did not recognise it — a brief is your text, and silently discarding a section is the one
thing this tool does not do.

Every owner section is marked in `PROMPT.md` as written by the project owner, so a reader can tell
an assertion from a measurement.

## A worked example

```markdown
<!-- BRIEF.md: fill in what you know; an empty section is simply not rendered -->

## Stakes

Runs live production for one owner. A wrong cleanup deletes their data, and the backup is taken by
the same process it is protecting.

## What came before

Four rounds, 23 defects. The recurring shapes: a guard at the route but not the timer, and an `ok`
flag that means only that the call returned.

## Calibration

- a grant signed for one recipe executing another recipe's deletions
- a recipe that never worked, because its test supplied a number where the daemon sends a string
```

## What is refused, and why

Three things are errors rather than overrides, because each would make the document lie:

- **a measured heading.** `Coverage`, `This snapshot`, `Attaching this`, `The job`, `What you have`
  and the rest are rendered from the manifest. Redefining one would let prose overwrite a
  measurement.
- **a file that cannot be read.** A snapshot must not quietly ship without the half you wrote.
- **an edited brief after generating.** Its digest is recorded, so `validate` reports
  `brief: docs/brief.md changed since this snapshot was generated`.

A brief must also stay inside the repository and must not be a credential-bearing file; a path
that escapes the repository is refused, because an untrusted `snapshot.config.json` must not turn
the brief into a host-file read. Its prose is redacted with the full content scanner, so a PEM
private key pasted into the text is masked as a block.

Two smaller ones: a heading defined twice is ambiguous and refused, and a file over 64 KiB is
refused with its size — past that it is a second codebase rather than instruction.

## How the file is parsed

| Input | Result |
| :--- | :--- |
| `## stakes`, `## STAKES` | the stakes section; headings match case-insensitively |
| `## Stakes:` | the stakes section; a trailing colon is a typo, not a different heading |
| `<!-- ... -->` | removed before parsing — the `init` scaffold is all comments and renders nothing |
| a section with no text | not rendered at all |
| a fenced block containing `## Coverage` | content, not a heading |
| CRLF, or a UTF-8 byte-order mark | read like the plain case |
| a control character | escaped, as everywhere else this tool reproduces text |

## The job changes, the standard does not

`promptTask` changes only the opening section:

- `audit` (the default) — find what is still wrong or will break;
- `review` — say what a change breaks, and what it claims but does not do;
- `explain` — explain how a subsystem works, and cite the lines.

The standard, the coverage duty and the answer shape are the same in all three. An unknown value
is a usage error, never a silent fall back to the default.

## Relationship to the rest of the snapshot

`brief` is instruction, not payload: changing it does not change the files that are copied, but it
does change the config digest, so a stale brief is flagged exactly like a stale snapshot. The
writer’s prose is masked like every other reproduced string, and the brief file itself is an
ordinary file in the repository — it may be snapshotted, or excluded with `excludePatterns`.
