---
name: verify-changes
description: The check, test, build, and packaging gates for this repository. Read before reporting any change complete.
---

# Verify changes

Run from the repository root. `corepack enable` and `pnpm install` first if you have not.

## The three gates

```sh
pnpm check   # biome check . && pnpm db:check && pnpm typecheck
pnpm test    # vitest run
pnpm build   # tsc --build && pnpm build:sdk
```

`pnpm check` is three things, and the middle one surprises people: `db:check` runs
`drizzle-kit check` against **both** the SQLite and PostgreSQL configs. A schema edit without
regenerated migrations fails here, not in `pnpm test`. See
[add-a-migration](../add-a-migration/SKILL.md).

`pnpm build` compiles the workspace with project references, then builds the publishable
bundle via `pnpm --filter supertag-ai build` (tsup, plus a script that copies migrations and
wire schemas into the package).

## If you touched packages/supertag-ai

Also run the packaging gate:

```sh
pnpm --filter supertag-ai test:package
```

That builds, then runs `publint`, `attw --pack . --profile esm-only`, and
`scripts/verify-external-worker.mjs`, which verifies a real external consumer against the
packed tarball. Broken `exports` maps and type-resolution problems only surface here.

## Autofix

```sh
pnpm check:fix   # biome check --write .
```

## Notes

- `postinstall` runs `pnpm db:generate`, so a fresh install regenerates migration artifacts. If
  `git status` shows unexpected changes under `packages/store/drizzle/`, that is why — inspect
  before committing.
- Vitest config is at the root; tests live in top-level `tests/`.
- PostgreSQL suites are gated on `SUPERTAG_POSTGRES_URL` with `describe.runIf`, so they skip
  silently when it is unset. A green local `pnpm test` therefore does **not** mean the
  PostgreSQL paths passed. Set that variable (`compose.yaml` can provide the database) when
  touching `packages/store` or anything schema-related; CI always runs them.
- If a gate cannot run in your environment, say so explicitly and state what you verified
  instead. Do not report a change complete on the strength of the gates you skipped.
