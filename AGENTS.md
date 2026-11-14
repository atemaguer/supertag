# Working on SuperTag

Brief for coding agents **changing this codebase**. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md) first; this file records the conventions an agent cannot
infer from the code alone.

Helping someone *use, develop against, or deploy* SuperTag is a different job — read
[`skills/SKILLS.md`](skills/SKILLS.md) for that.

## What SuperTag is

Open infrastructure for building and running autonomous engineering teams or organizations made of
AI actors, on any model, harness, and environment. People set outcomes and direct the team from
Slack, GitHub, Lark/Feishu, Linear, Microsoft Teams, the CLI, or an API. A **Tag** is a stable
non-human AI actor and identity. A **Session** is one Tag's thread of work and a **Task** is one
turn of it. **Context Sets** select reusable knowledge, and **Permission Sets** select allowed
actions. Each Task keeps the
policy recorded when SuperTag accepted it.

The **Control Plane** stores the organization, accepts and schedules work, recovers interrupted
work, and preserves audit history. It is the public API for operator clients (the CLI, the
terminal UI, the desktop app, and SDKs) and for Worker Hosts. A **Gateway** runs collaboration
surfaces only, as a client of the Control Plane. A **Worker Host** is a machine or sandbox that
provides execution capacity: it connects outbound to the Control Plane and runs each Task through a
**harness** adapter such as Codex, Claude Code, Cursor, or OpenCode.

The services and CLI are Rust (`rust/`). The TypeScript that remains is the Node harness bridges
and Workspace providers that Worker Hosts start (`packages/runtime`), the shared code they use
(`packages/core`), and the desktop app's frontend (`apps/desktop`). The terminal UI is Go
(`apps/tui`). [`rust/docs/typescript-removal-inventory.md`](rust/docs/typescript-removal-inventory.md)
records why each remaining TypeScript package stays.

## Rules that are easy to violate

**No public npm package from this checkout.** The `@supertag/*` workspace packages are private
and carry no compatibility promise; never tell users to depend on them.

**Two databases, always.** Every schema change adds a migration to both
`rust/crates/control-plane/migrations/sqlite` and `rust/crates/control-plane/migrations/postgresql`,
and its tests run on both databases (`::sqlite` and `::postgres` cases).

**`docs/` is for users and integrators.** Explain how to use SuperTag and how it works.
Put contributor workflows, repository layout, testing, and simulation instructions in
`CONTRIBUTING.md`; do not add internal progress or validation reports to public docs.

**Record user-facing changes in `CHANGELOG.md` at integration.** Whoever integrates a change onto
`main` adds one concise bullet under `## [Unreleased]` in `Added`, `Changed`, `Fixed`, or `Removed`.
Task and feature branches don't edit `CHANGELOG.md`, so parallel work doesn't conflict on it.

**Use progressive disclosure and accessible language.** Begin with a plain definition, a familiar
example, and when the concept is useful. Put commands after the concept and protocol or schema
details in reference sections or reference pages. Define controlled terms before using them. Prefer
"accept," "store," "allowed actions," and "source" until exact terms such as admission,
reconciliation, authorization snapshot, and origin are needed. Define every SuperTag term (Tag,
Objective, Task, Worker Host, and so on) at its first use on each page, in plain words or with a
link to its definition, because readers often land on a page directly.
Do not assume a reader followed links in a particular order. A landing page must briefly define a
controlled term before using it in navigation or explanation, and a page that can be opened directly
must define its subject and any neighboring SuperTag concepts used in its introduction.

**Docs use `supertag`, not `pnpm supertag`.** Documentation is written for a reader who installed
the release CLI. The `pnpm supertag` form runs the checkout's Rust CLI through `cargo run`, and
belongs in `CONTRIBUTING.md`. The one exception is
`docs/operations/control-plane.md`, which deliberately contrasts installed / checkout / built /
container invocations.

**Capitalized terms are a controlled vocabulary.** `docs/reference/resource-model.md` is the
authority. Do not capitalize a noun just because it is a domain concept.

**Lasting credentials never pass through flags.** They come from masked prompts or provider
environment variables. Preserve this when touching setup or worker credential paths. One-time
bootstrap secrets, such as Auth Keys, may also be flags, following Tailscale's `--auth-key`; always
offer an environment variable and a `file:PATH` form beside the flag.

**Harness adapters run behind a Worker Host.** `supertag worker-host` supervises execution and
starts a harness adapter for each Task. TypeScript and Python implement harness adapters and
clients, not Worker runtimes.

**Docs describe SuperTag as it is now.** Design notes, experiment records, and planning stay in
the gitignored `contributing/`, `docs/**/*architecture*.md`, and `docs/**/*product-brief*.md`.
Never link to them from tracked files, and don't treat their commands or fields as shipped:
`supertag worker pair`, for example, appears there but is not implemented.

**`rust/docs/cli-reference.md` is the command inventory.** It records the help of every visible
command, and `pnpm docs:check` checks documented commands and flags against it. After changing a
command, rerun `cli_help.rs` with `SUPERTAG_UPDATE_CLI_REFERENCE=1` and review the diff. Pages listed
in `scripts/docs-pending-cli.txt` still describe the removed TypeScript CLI and are not checked
until they are rewritten.

## Verify before reporting done

```sh
pnpm check   # biome + protobuf generation + typecheck + docs
pnpm test    # vitest
pnpm build   # tsc --build
cargo test --manifest-path rust/Cargo.toml --locked --workspace --all-features
```

Run `go test ./...` in `apps/tui` after terminal UI changes. PostgreSQL and fixture-dependent Rust
tests are ignored by default; CONTRIBUTING.md describes how to include them.
