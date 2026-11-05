# Stale LLM context is a bug

A snapshot is a copy. The code keeps moving. Nothing in the copy says so, and nothing in the
model can notice.

That is the whole failure mode: you hand a model a faithful description of your repository on
Monday, change four files on Wednesday, and on Thursday ask about a function you have already
deleted. The answer is confident, plausible and about a repository that no longer exists.

```text
you ──▶ snapshot (Monday) ──▶ model ──▶ answer about Monday's code
             code moves (Wednesday) ────┘
```

There is no error message, because nothing failed. The model did exactly what it was given.

## Why "just regenerate it" is not a control

Regenerating is cheap — it takes a second. The problem is that you have to *know* to do it, and
nobody notices a stale snapshot until an answer is wrong. A habit is not a guard, and a README
line that says "re-run this before asking" is a habit.

What you need is not more discipline. It is a comparison that can fail.

## Three things that make drift visible

### 1. An identity for the copy

Every run writes `manifest.fingerprint`, a hash of what was included, derived from the content
of every file. Two repositories that differ by one byte have different fingerprints; two runs
over the same tree on different machines have the same one.

```bash
codebase-snapshot report --format json | jq -r .manifest.fingerprint
```

Quote that value wherever the snapshot is used — in the prompt, in the PR description, in the
ticket. It turns "the snapshot we sent" into a value that can be compared later.

### 2. A comparison you can run

`validate` re-scans the repository, re-hashes each file the snapshot claims to contain, and
compares. It exits `1` when the code has moved, and `0` when the snapshot still describes what
is on disk.

```bash
codebase-snapshot validate
```

```text
✖ Snapshot does not match the repository:
   - modified: src/parser/partition.ts
   - added:    src/presets/evidence.ts
   - removed:  src/legacy/old-partitioner.ts
```

That is the difference between a copy and an artefact. A copy is trusted; an artefact is
checked.

### 3. A record of what was left out

`manifest.skipped[]` names every path the snapshot did not include, with a reason for each:

| Reason | Meaning |
| :--- | :--- |
| `gitignore` | the repository's own rules excluded it |
| `default-ignore` | `node_modules`, build output, VCS metadata |
| `sensitive-file` | `.env`, `*.pem`, `.npmrc` — excluded unless explicitly requested |
| `binary` | not text, so not useful as context |
| `outside-root` | a symlink pointing out of the repository |
| `nested-repository` | a submodule or nested checkout |
| `read-error` | it could not be read, and the run says so instead of dropping it quietly |

When an answer is wrong because the model never saw a file, this is the list that tells you
whether the file was excluded on purpose or by accident.

## Gate it

The comparison is only a guard if something runs it. In CI, after whatever changes the tree:

```yaml
- name: Snapshot is still current
  run: npx codebase-snapshot validate
```

A failure means the context you are about to rely on describes a different repository. Whether
that blocks the pipeline or just warns is a policy question; having it at all is not.

The same gate works for a long-running agent: run `validate` before a session that will read
the snapshot, and regenerate when it fails.

## What this does not tell you

Worth being precise about the limits, because "validate" sounds like more than it is:

- **It compares files, not meaning.** A refactor that preserves every byte proves nothing is
  wrong — correctly, because nothing is.
- **It cannot see what the model did with the text.** A current snapshot can still be
  misunderstood, summarised badly, or ignored.
- **It says nothing about whether the snapshot was a good selection.** Use `explain <path>` to
  see why one path was included or skipped, and `report` for the shape of the whole run.
- **It does not follow history.** If you keep three snapshots from three branches, each one
  validates against the branch it was generated from.

## When this is overkill

If you generate a snapshot, paste it into a chat, and throw it away in the same hour, you do not
need any of this — `snapshot` alone is the right amount of ceremony.

The controls start to pay for themselves the moment a snapshot outlives the session that made
it: a checked-in context directory, a scheduled job, a review bot, an agent that runs for days,
or a team where the person who generated the snapshot is not the person who reads it.

## Related

- [Budgeting LLM context](how-to-context-budget.md) — choosing a part size that fits the window
- [Snapshot output](output.md) — the manifest fields this page refers to
- [CLI reference](cli.md#validate--check) — `validate` in full
