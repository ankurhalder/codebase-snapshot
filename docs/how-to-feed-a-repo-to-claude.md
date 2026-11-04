# How to feed a whole codebase to ChatGPT, Claude or Cursor

A model cannot clone your repository. Everything it knows about your code has to arrive as text, and
the text has to fit. This is the practical, repeated recipe — including the parts most guides skip,
which are the ones that decide whether the answer is any good.

## The problem, stated properly

There are three separate failures, and they need different fixes:

1. **It does not fit.** A real repository is far larger than any context window once you include
   node_modules, lockfiles and build output. Naively concatenating files produces something that is
   rejected, truncated by an unknown amount, or billed at a size you did not expect.
2. **It does not fit *predictably*.** If the boundary moves between runs, you cannot tell whether a
   changed answer came from changed code or a different cut of the same code.
3. **It is not current.** The document you pasted was generated yesterday. Nobody notices until the
   model confidently describes a function you deleted.

Most "paste your repo into an LLM" tooling solves only the first.

## The recipe

### 1. Generate from the checkout, not from a website

If the code is private, it should not be uploaded to a third-party service to be turned into text.
Everything below runs locally.

```bash
cd /path/to/your/project
npx codebase-snapshot setup
```

`setup` detects the project type from the repository, writes a commented `snapshot.config.mjs`, adds
the npm scripts and the devDependency, installs it, and generates. It does not overwrite a config you
already have. Use `--no-install` if you would rather not touch the lockfile.

If you prefer to see each stage:

```bash
npx codebase-snapshot init --yes    # config + scripts + dependency + .gitignore
npm install
npm run snapshot                    # generate
npm run snapshot:validate           # exit 0 = still matches the disk
```

### 2. Choose the budget, not the file list

The setting that matters is `maxPartBytes` — the hard ceiling for one part. Pick it from the
destination, not from taste:

| Destination | Practical budget |
| :--- | :--- |
| A chat window | 40–120 KB per part; paste one or two |
| A RAG index | 120–300 KB per part, chunked by heading |
| An agent's context | 60–150 KB; smaller parts leave room to reason |

```js
// snapshot.config.mjs
const config = {
  maxPartBytes: "120k",
  // Per-layer ceilings, when docs and code deserve different treatment.
  budgets: { default: "120k", byLayer: { docs: 40_000 } },
};
export default config;
```

A file larger than the budget is not silently dropped: it is truncated with an explicit marker
naming the budget, and files above `largeFileBytes` become a head/tail excerpt instead of a body.

### 3. Tell the model what it is looking at

The snapshot is self-describing, and saying so up front measurably improves answers:

> The context below is a generated snapshot of a repository. `manifest.json` lists every included
> file with its language, part and hash, and every excluded file with the reason. Reads start with
> `parts/part-001.md`. If something you need is missing, ask me to check `explain <path>` rather than
> assuming it does not exist.

That last sentence matters more than it looks: models fill gaps by invention, and telling them the
gap is documented turns a hallucination into a question.

### 4. Include the index, always

Paste `manifest.json` alongside the parts, or at least `reports/navigation.md`. Without the index the
model sees text with no map and guesses at structure. With it, it can say "this file is in part 3,
which I have not been given" instead of inventing the file.

### 5. Re-validate before every session that matters

```bash
npm run snapshot:validate || npm run snapshot
```

`validate` compares each file's hash *and* a digest of the settings used to generate the snapshot. A
changed budget, layer rule or secret pattern is drift, not silence — so the check catches both code
changes and configuration changes.

## What to exclude

The defaults already skip binaries, credential files (`.env`, `*.pem`, `.ssh/`, `.npmrc`) and
anything gitignored. Beyond that, the highest-value exclusions are usually:

```js
excludePatterns: ["**/*.test.ts", "**/__snapshots__/**", "public/**", "*.min.js", "vendor/**"],
```

Tests and fixtures are often 40% of a repository and rarely part of the question. Removing them buys
context for the code that is being asked about.

## What this does not solve

- **The model still has a fixed window.** If the code genuinely exceeds it, you are choosing what to
  omit — this tool makes that choice explicit and recorded rather than accidental.
- **Understanding beats volume.** A smaller snapshot with the right 20 files outperforms a large one
  containing everything. Use `include` when you know the area.
- **Drift is only detected when you run the check.** It is not a watcher, unless you use `--watch`.

## Next

- [Configuration](configuration.md) — every setting and its default
- [Snapshot output](output.md) — what each artifact contains
- [Comparing with other tools](vs-repomix.md)
