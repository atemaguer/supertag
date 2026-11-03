---
name: add-a-migration
description: Change the database schema across both SQLite and PostgreSQL and generate matching migrations. Read before editing anything under packages/store.
---

# Add a migration

SuperTag supports two databases: SQLite for local development, PostgreSQL for production.
**Both are first-class.** Every schema change touches both, or `pnpm check` fails.

## Files that must stay in sync

| File | Purpose |
| --- | --- |
| `packages/store/src/schema/sqlite.ts` | SQLite table definitions |
| `packages/store/src/schema/postgresql.ts` | PostgreSQL table definitions |
| `packages/store/src/schema/index.ts` | Re-exports |
| `packages/store/drizzle/sqlite/` | Generated SQLite migrations + `meta/_journal.json` |
| `packages/store/drizzle/postgresql/` | Generated PostgreSQL migrations + `meta/_journal.json` |

## Procedure

1. Edit **both** schema files. Keep column names, nullability, and defaults semantically
   equivalent; the types differ per dialect by design.

2. Generate migrations for both dialects:

   ```sh
   pnpm db:generate
   ```

   This runs `drizzle-kit generate` twice, once per config
   (`drizzle.sqlite.config.ts`, `drizzle.postgresql.config.ts`). It writes a new `.sql` file
   and a `meta/NNNN_snapshot.json` per dialect, and appends to each `meta/_journal.json`.

3. Verify the generated state matches the schema:

   ```sh
   pnpm db:check
   ```

4. Apply locally:

   ```sh
   pnpm db:migrate                    # both, via scripts/migrate.mjs
   pnpm db:migrate:sqlite             # one dialect
   pnpm db:migrate:postgresql
   ```

5. Run the full gates, with PostgreSQL available:

   ```sh
   export SUPERTAG_POSTGRES_URL=postgresql://supertag:supertag@localhost:5432/supertag_test
   pnpm check && pnpm test
   ```

   PostgreSQL test suites use `describe.runIf(SUPERTAG_POSTGRES_URL)` and skip silently
   without it. Do not trust a green run that skipped them.

## Footguns

**`postinstall` runs `db:generate`.** A fresh `pnpm install` can produce diffs under
`packages/store/drizzle/`. Inspect them; do not blindly commit or discard.

**Commit both dialects together, including journals.** A migration present for one dialect and
absent for the other breaks `db:check` for everyone.

**Migrations ship to npm.** `packages/supertag-ai/scripts/copy-migrations.mjs` copies
`packages/store/drizzle` into `packages/supertag-ai/drizzle`, which is listed in that
package's `files`. `packages/supertag-ai/drizzle/` is gitignored because it is generated. A
migration that is not committed to `packages/store/drizzle` will not reach users, and
`supertag migrate` will not apply it.

**Never edit a generated `.sql` file or snapshot by hand.** Change the schema and regenerate.

**No persistence-schema compatibility promise.** Per `docs/reference/api-stability.md`, the
database and store APIs are Experimental. Tables are Internal — you may restructure them, but
you may not break the documented resource shapes in
`docs/reference/resource-model.md`, which are Beta.
