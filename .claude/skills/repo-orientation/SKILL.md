---
name: repo-orientation
description: Decide which package a change belongs in, and respect the public/private package boundary. Read before adding files or moving code between packages.
---

# Repo orientation

pnpm workspace, TypeScript, ESM only. Node.js 20.18.1 or newer (`.node-version` pins 20.18.1).

## Where code belongs

| Path | Owns |
| --- | --- |
| `apps/cli` | CLI entry point and runtime composition root |
| `packages/core` | Domain values and ports |
| `packages/store` | Drizzle schemas, SQLite/PostgreSQL adapters, migrations |
| `packages/control-plane` | Durable admission, dispatch, reply outbox, service lifecycle |
| `packages/connectors/sdk` | Connector contract |
| `packages/connectors/{slack,github,lark,linear,teams}` | Enrollment, ingress, normalization, surface rendering, replies |
| `packages/runtime/sdk` | Worker, Worker Runtime, Execution Context, Harness, environment, Runtime Input, checkpoint contracts |
| `packages/runtime/transport` | Authenticated Gateway-to-Worker transport |
| `packages/runtime/harnesses/{codex,claude-code}` | Harness implementations |
| `packages/runtime/resources/*` | Worker-side resources and hosted MCP Tool Providers |
| `packages/runtime/environments/e2b` | Remote sandbox environment |
| `packages/supertag-ai` | **The only published package.** Public entry points over the above |

Keep the abstraction surface narrow: domain and IAM declarations in `core`, collaboration
protocol behavior in connectors and `gateway`, harness-specific adaptation and credentials
under `runtime`. `docs/reference/repository-layout.md` is the canonical version of this table —
update it when the layout changes.

## The boundary that matters

`packages/supertag-ai` is the only package published to npm. Everything else is
`"private": true` and versioned `0.0.0`. `supertag-ai` bundles the internal packages into its
own output via tsup `noExternal: [/^@supertag\//]`, so consumers never resolve `@supertag/*`.

Consequences:

- Never document or suggest installing `@supertag/core`, `@supertag/control-plane`, or any other
  workspace package. They carry no compatibility promise.
- A new capability intended for external use needs a `supertag-ai` entry point. See
  [public-api-export](../public-api-export/SKILL.md).
- Internal packages may import each other with `workspace:*`.

## Composition root

`apps/cli/src/index.ts` is the dispatcher. Commands are matched positionally, not with a
framework:

- `migrate`, `gateway`, `setup <provider>`, `tag`, `task`, `worker connect`,
  `worker credential`
- Resource verbs `get | describe | apply | diff | watch` are routed through
  `apps/cli/src/resources.ts`, which holds the valid kind map (`tags`, `permission-sets`,
  `context-sets`, `connector-accounts`, `presences`, `worker-hosts`, `worker-profiles`,
  `tasks`, `sessions`, each with singular and unspaced aliases)
- A global `--gateway NAME` prefix is parsed before dispatch

When adding a command, update `helpText()` in the same file. The help text is the only
inventory of commands, and documentation is written against it.

## Conventions

- Biome for formatting and linting, configured in `biome.json`
- Vitest, with tests in top-level `tests/`, not colocated
- Credentials are read from masked prompts or provider environment variables, never from
  flags — preserve this in any setup or credential path
