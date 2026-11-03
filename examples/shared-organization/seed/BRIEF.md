# Shared CSV summary objective

Produce a dependency-free JavaScript ES module `csv-summary.mjs` in this shared workspace.
Export `summarizeCsv(text)`, returning `{ rowCount, headers, numeric }`.

- The first CSV record contains column names. `headers` preserves their order. `rowCount` counts subsequent records.
- Parse comma-separated fields, quoted fields containing commas/newlines, doubled quote escapes, and LF or CRLF record endings. Ignore one trailing record separator; header-only input has zero rows.
- Empty cells do not contribute numeric values. A column is numeric only if every nonempty cell is a finite decimal number (including negative and fractional values). Exclude columns without numeric values. A decimal that overflows JavaScript's finite number range, such as 400 consecutive nines, makes its column nonnumeric.
- `numeric` maps each numeric column name to `{ count, sum, min, max, mean }` computed over its nonempty values. Do not treat whitespace-only cells as zero.
- Reject malformed quoting, inconsistent row lengths, empty/duplicate headers, and empty input with an Error. All other header names are data, including `__proto__`; preserve their numeric summaries as own properties when applicable.
- Use Node built-ins only. No network access or package installation is needed.

An independent manager must inspect the actual file, run their own tests, and write `review.md` with their verdict, exact file SHA-256, and commands/results. Include exactly one verdict line: `Verdict: approved` or `Verdict: changes requested`. Approval must apply to the current source digest. Exchange work and review evidence through SuperTag Mailboxes. Use Task acceptance and Objective completion to record the outcome honestly. Shared files are mutable; a path alone is not immutable artifact provenance. Include the digest you reviewed.

You decide how to divide and schedule the work using the available coordination tools. There are two managers and two execution profiles, `shared-claude` and `shared-codex`, both revision `1`, each with capacity one. Keep the organization bounded: use the existing Tags and Teams, at most eight Tasks, and no new Tags. Use the other manager for independent review. Do not recursively delegate or create replacement Tasks for work with unknown delivery/execution state. Check current durable state before deciding what remains.

A SuperTag Task runs separately and needs a free Worker slot. Native subagents work inside your current Task. Choose the appropriate mechanism for the work; do not both queue a separate Task and perform that same assignment inside your current run. If you change that plan, reconcile the queued assignment first. When waiting for a separate Task, including one using your current Worker Profile, register `wait_for` and finish the turn so the Worker can execute it.
