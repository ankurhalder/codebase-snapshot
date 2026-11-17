# Task slices

```bash
codebase-snapshot generate --slice "how does checkout retry a failed payment" --slice-tokens 20000
```

A slice is a snapshot built for a question. The retrieval planner that powers
[`snapshot_plan_for`](mcp.md) runs at generate time, and only the files it chooses are written. The
result is a snapshot small enough to paste, with the selection and the omissions recorded.

## What it keeps

The planner ranks every scanned file by:

1. path terms — `checkout` matches `src/checkout.ts` and `checkout.test.ts`;
2. symbol names from the parsed summary — `charge` matches `chargeCard`, `authenticated` matches `auth`;
3. layer and kind names named in the question;
4. how many files import it (centrality);
5. the imports of the strongest matches, pulled in as context.

Tests are excluded unless the question names them. Then files are packed in rank order until the
budget is reached; a file too large for what remains is offered as a head read, and a file that
still does not fit is skipped with a reason.

## What it records

```json
"slice": {
  "question": "how does checkout retry a failed payment",
  "budgetTokens": 20000,
  "usedTokens": 18422,
  "files": ["src/checkout.ts", "src/payments/retry.ts", "..."],
  "dropped": 1431
}
```

Every path that was scanned and not chosen is in `skipped[]` with reason `not-selected` — not
`unchanged`, which would be a different and untrue statement. The brief says at the top that the
snapshot is a slice, quotes the question, and warns that unselected paths are not in the parts.

## What it does not do

- It does not read files that were excluded: sensitive files stay out, so a question about them
  cannot make them selected.
- It does not promise the answer is complete. A slice is a budgeted guess at what a reader needs,
  and the brief says so.
- It does not combine with `--delta` or `--budget-tokens`; all three narrow the selection and the
  CLI refuses a pair rather than guessing which should win. Use `--slice-tokens` for the slice's own
  budget.

## When to use it

| Situation | Use |
| :--- | :--- |
| A focused question about one subsystem | `--slice` |
| A review of a change set | `--delta` |
| The whole repository for an audit | neither |
