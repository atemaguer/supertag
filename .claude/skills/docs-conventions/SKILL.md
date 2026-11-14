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

Write `supertag`, never `pnpm supertag`. Readers install the CLI with the installer script from a
GitHub Release (`docs/operations/install.md`). `pnpm supertag` runs the checkout's Rust CLI through
`cargo run` and works only in a checkout; repository build commands belong in `CONTRIBUTING.md`.
User installation instructions use the installer script for the CLI, and PyPI and npm for the
SDKs; Python prereleases need an explicit version pin.

Two intentional exceptions to the CLI form:

- `CONTRIBUTING.md` documents the `pnpm supertag` shortcut for running uncommitted changes.
- `docs/operations/control-plane.md` may contrast invocation forms.

`docs/reference/cli.md` is the command inventory. It is generated from the Rust CLI's help and
checked by `rust/crates/cli/tests/cli_help.rs`; regenerate it with
`SUPERTAG_UPDATE_CLI_REFERENCE=1`. Before documenting a command or flag, confirm it there.
`pnpm docs:check` validates every documented `supertag` command and flag against it. Operator
commands find the local services on their own, so examples for a local setup name no Control
Plane; examples for a shared one add `--control-plane NAME`. Do not copy commands out of the
internal architecture record — some were never implemented.

## Capitalized vocabulary

Capitalize a term only if it is something a user **creates, configures, inspects, or
implements**. Everything else is lowercase prose.

Configuration resources: **Tag, Role, Permission Set, Context Set, Team, Objective, Workspace,
Volume, Surface Account, Auth Key, Operator Token**.

Operational resources: **Session, Task, Task Attempt, Worker Host**.

Extension contracts (as named in `api-stability.md`): **Connector**. Write *harness* and *harness
adapter* in lowercase, like other industry terms, and keep code identifiers such as `Harness` as
written.

Plus **Control Plane** and **Gateway**, the services themselves.

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
