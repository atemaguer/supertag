---
name: docs-conventions
description: Documentation structure, CLI command form, and the controlled capitalized vocabulary. Read before editing README.md or anything under docs/.
---

# Docs conventions

## Three layers, distinct jobs

| Layer | Answers | Altitude |
| --- | --- | --- |
| `docs/concepts/` | What is this and how does it behave? | No interfaces, no code |
| `docs/guides/`, `docs/connectors/`, `docs/operations/` | How do I accomplish a task? | Commands and procedures |
| `docs/reference/` | What is the exact contract? | Interfaces, schemas, invariants |

`README.md` gets one Tag replying and nothing more. `docs/README.md` is the index and must
link every doc — a page reachable only from a sibling is invisible.

`docs/reference/resource-model.md` is the vocabulary authority, and
`docs/reference/glossary.md` its reader-facing index — a new public term belongs in both.
`docs/reference/api-stability.md` is the compatibility authority.

## CLI form

Write `supertag`, never `pnpm supertag`. Alpha readers clone the repository and run
`pnpm install:cli` to install the CLI; `pnpm supertag` resolves to
`pnpm --filter @supertag/cli dev` and fails outside a checkout with
`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`.

Repository installation commands (`pnpm install`, `pnpm install:cli`, and
`pnpm uninstall:cli`) belong in the install guide.

Two intentional exceptions to the CLI form:

- `CONTRIBUTING.md` documents the `pnpm supertag` shortcut for running uncommitted changes.
- `docs/operations/control-plane.md` deliberately contrasts installed CLI / from a checkout / built
  checkout / container.

Before documenting a command, confirm it exists in `helpText()` in `apps/cli/src/index.ts`, and
that any resource kind exists in the map in `apps/cli/src/resources.ts`. Do not copy commands
out of the internal architecture record — some were never implemented.

## Capitalized vocabulary

Capitalize a term only if it is something a user **creates, configures, inspects, or
implements**. Everything else is lowercase prose.

Configuration resources: **Tag, Presence, Permission Set, Context Set, Worker Profile,
Surface Account**.

Operational resources: **Session, Task, Task Attempt, Worker Host**.

Extension contracts (as named in `api-stability.md`): **Worker, Worker Host, Worker Runtime,
Connector**, and the provider/resolver contracts. The harness contract is the exception: write
*harness* in lowercase, like other industry terms. Keep multi-word SPI names such as **Harness
Plan** and **Harness Runtime Provider** capitalized, and keep code identifiers such as `Harness`
as written.

Plus **Gateway**, the service itself.

Lowercase, even though they are domain concepts: *collaboration surface*, *multiplayer*,
*resource*, *thread*, *channel*, *repository*, *workspace*, *harness*.

Rules:

- Write **Task Attempt**, not bare *Attempt*.
- Write *collaboration surface*, not *Surface* — `resource-model.md` already does.
- Do not introduce a new capitalized noun without adding it to `resource-model.md` or
  `api-stability.md`. If it does not belong in either, it does not deserve capitals.

## Style

- Short declarative sentences. The corpus averages 10–19 words per sentence; keep it there.
- Active voice. Avoid *is admitted*, *is resolved*, *is bounded* where a subject will do.
- Tables for comparison, `text` fenced blocks for small diagrams and routing examples.
- Prefer one concrete worked example over abstract description. The Alice/Bob walkthrough in
  `docs/concepts/multiplayer.md` is the model.
- Relative links between docs, so they resolve on GitHub and in the repo.
- Do not link to `docs/**/*architecture*.md` or `docs/**/*product-brief*.md`. They are
  gitignored internal design records and will 404 for everyone else.

## Before finishing

- For a user-facing change, the integrator adds one bullet under `## [Unreleased]` in
  `CHANGELOG.md`. Task branches don't edit it.
- Every SuperTag term is defined, in plain words or by a link to its definition, at its first use
  on the page (headings don't count). Readers land on pages directly.
- Every relative link resolves.
- New pages are linked from `docs/README.md`.
- No `pnpm supertag` outside the two exceptions.
- Every command and resource kind exists in the CLI.
