# Shared CSV summary objective

Produce a dependency-free JavaScript ES module `csv-summary.mjs` in this shared workspace.
Export `summarizeCsv(text)`, returning `{ rowCount, headers, numeric }`.

- The first CSV record contains column names. `headers` preserves their order. `rowCount` counts subsequent records.
- Parse comma-separated fields, quoted fields containing commas/newlines, doubled quote escapes, and LF or CRLF record endings. Ignore one trailing record separator; header-only input has zero rows.
- Empty cells do not contribute numeric values. A column is numeric only if every nonempty cell is a finite decimal number (including negative and fractional values). Exclude columns without numeric values. A decimal that overflows JavaScript's finite number range, such as 400 consecutive nines, makes its column nonnumeric.
- `numeric` maps each numeric column name to `{ count, sum, min, max, mean }` computed over its nonempty values. Do not treat whitespace-only cells as zero.
- Reject malformed quoting, inconsistent row lengths, empty/duplicate headers, and empty input with an Error. All other header names are data, including `__proto__`; preserve their numeric summaries as own properties when applicable.
- Use Node built-ins only. No network access or package installation is needed.

An independent manager must inspect the actual file, run their own tests, and write `review.md` with their verdict, exact file SHA-256, and commands/results. Include exactly one verdict line: `Verdict: approved` or `Verdict: changes requested`. Approval must apply to the current source digest. The review manager's work Session returns its findings to the Objective that started it; reach the other manager directly with `send_message` and share progress with the Team using `post`. Complete the Objective with `update_objective` and record the outcome honestly. Shared files are mutable; a path alone is not immutable artifact provenance. Include the digest you reviewed.

The Objective's owner decides how to divide the work. There are two managers and two execution profiles, `shared-claude` and `shared-codex`, both revision `1`, each with capacity one. Keep the organization bounded: use the existing Tags and the existing Team, at most eight work Sessions, and no new Tags. Give the review work to the other manager with `start_session {title, instruction, tag}`. Do not start a replacement Session for work whose execution state is unknown. Read the Objective with `read_objective` before deciding what remains.

A work Session runs separately and needs a free Worker slot; its result arrives as a later turn of the Objective's conversation. Native subagents work inside your current turn. Choose the appropriate mechanism; do not both start a work Session and do that same work inside your current turn. End your turn once the work you started is running: you are woken when it reports.
