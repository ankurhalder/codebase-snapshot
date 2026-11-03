## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The problem this solves. Link an issue with "Closes #123" when there is one. -->

## How it was verified

<!-- Commands you ran, fixtures you used, what you saw. -->

```bash
npm run check
```

- [ ] `npm run check` passes (lint + typecheck + tests)
- [ ] New behaviour is covered by a test
- [ ] Documentation updated in the same commit (`docs/cli.md`, `docs/configuration.md`,
      `docs/output.md`, or `CHANGELOG.md` as appropriate)

## Checklist

- [ ] No silent fallbacks added — an ignored setting is a bug, not a convenience
- [ ] Nothing that could delete a directory this tool did not create
- [ ] No code path can emit a credential file or an unredacted secret
- [ ] `--format json` output is still pure JSON on stdout
- [ ] The agent contract (`codebase-snapshot describe`) still matches the code
