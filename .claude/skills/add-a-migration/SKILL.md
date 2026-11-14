---
name: add-a-migration
description: Change the database schema across both SQLite and PostgreSQL with matching migrations. Read before editing rust/crates/control-plane/migrations or the store.
---

# Add a migration

The Control Plane supports two databases: SQLite for local and single-process use, PostgreSQL for
production and replicas. **Both are first-class.** Every schema change touches both.

## Files that must stay in sync

| File | Purpose |
| --- | --- |
| `rust/crates/control-plane/migrations/sqlite/NNNN_name.sql` | SQLite migration |
| `rust/crates/control-plane/migrations/postgresql/NNNN_name.sql` | PostgreSQL migration with the same number and name |
| `rust/crates/control-plane/src/store.rs` | The ordered `include_str!` lists, one per dialect |

## Procedure

1. Add the next-numbered migration to **both** directories. Keep column names, nullability, and
   defaults semantically equivalent; the types and locking differ per dialect by design.
2. Append both files to the matching `include_str!` lists in `store.rs`, in order.
3. Update the store code for both dialects where queries differ.
4. Run the store contracts on both databases:

   ```sh
   export SUPERTAG_RUST_TEST_POSTGRES_URL_FILE=/path/to/private-url-file
   SUPERTAG_RUST_TEST_REQUIRE=postgres cargo test --manifest-path rust/Cargo.toml --locked \
     -p supertag-control-plane -- --include-ignored
   ```

   PostgreSQL cases are ignored without the URL file. With `SUPERTAG_RUST_TEST_REQUIRE=postgres`
   a missing database fails the run instead of skipping. Do not trust a run that skipped them.

## Footguns

**Never edit a migration that has merged.** Add a new one.

**No persistence-schema compatibility promise before release.** Tables are internal; you may
restructure them, but not break documented resource shapes.
