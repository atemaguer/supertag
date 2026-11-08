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
work, and preserves audit history. Its **Gateway** carries traffic to and from external work tools.
Its **API Server** handles management requests and execution connections. A **Worker Host** is a
machine or sandbox that provides execution capacity. A **Worklet** connects a Worker Host to the
API Server and supervises its **Workers**. A Worker completes a Task and may use a **harness** such
as Codex or Claude Code. The API Server and Gateway are code boundaries inside the same Control
Plane process and deployment.

## Rules that are easy to violate

**One public package.** `packages/supertag-ai` is the only package published to npm. It
re-exports internal workspace packages behind deliberate entry points. Never tell users to depend
on `@supertag/*` — those are private and carry no compatibility promise.

**Two databases, always.** Every schema change touches both `src/schema/sqlite.ts` and
`src/schema/postgresql.ts` and generates migrations for both. Validate both Drizzle
configurations before reporting the change complete.

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
the self-contained release CLI or the `supertag-ai` npm package. The `pnpm supertag` form only
works inside a checkout after `pnpm install`, and belongs in `CONTRIBUTING.md`. The one exception is
`docs/operations/control-plane.md`, which deliberately contrasts installed / checkout / built /
container invocations.

**Capitalized terms are a controlled vocabulary.** `docs/reference/resource-model.md` is the
authority. Do not capitalize a noun just because it is a domain concept.

**Lasting credentials never pass through flags.** They come from masked prompts or provider
environment variables. Preserve this when touching setup or worker credential paths. One-time
bootstrap secrets, such as Auth Keys, may also be flags, following Tailscale's `--auth-key`; always
offer an environment variable and a `file:PATH` form beside the flag.

**Custom Workers are applications, not CLI commands.** `supertag worklet connect` composes and
launches only SuperTag's built-in TypeScript Workers. SDK users run custom JavaScript, TypeScript,
Python, or other Workers through their normal language runtime or deployment process. Do not add
language-specific Worker executables to an SDK package.

**Docs describe SuperTag as it is now.** Design notes, experiment records, and planning stay in
the gitignored `contributing/`, `docs/**/*architecture*.md`, and `docs/**/*product-brief*.md`.
Never link to them from tracked files, and don't treat their commands or fields as shipped:
`supertag worker pair`, for example, appears there but is not implemented.

**`supertag --help` is the command inventory.** `helpText()` in `apps/cli/src/index.ts` is the
only complete list, and docs are written against it. Update it when adding a command.

## Verify before reporting done

```sh
pnpm check   # biome + drizzle schema check + typecheck
pnpm test    # vitest
pnpm build   # tsc --build, then the supertag-ai bundle
```

Also run `pnpm --filter supertag-ai test:package` when changing the published SDK. PostgreSQL
suites require their documented test database and may otherwise skip.
