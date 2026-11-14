# Fresh-state cutover rehearsal

This contributor verification creates synthetic old state, archives it, runs a separate fresh Rust
installation, and restores the archive into a separate legacy copy. It accepts no existing runtime
state directory. It does not migrate history, retire the TypeScript runtime, switch a deployment,
or contact a model or work-tool provider.

The legacy fixture runs the real TypeScript Control Plane, store, and durable Worklet from an exact
archived source commit. This checkout no longer contains the TypeScript runtime: pass a legacy
commit at or before `6c934be8`, the last commit that contained it. `legacy.ts` is copied into that
source snapshot and runs there; its imports do not resolve in this checkout. It completes one Task, closes all writers, and preserves its Session,
permission snapshot, journal, a synthetic opaque native Session checkpoint, and a Git workspace
with committed and uncommitted files. SQLite is copied after closure. PostgreSQL is dumped after
closure with `pg_dump`, then restored into another uniquely named test database. Every test database
has an ownership marker and is removed when the rehearsal finishes.

The old-state archive includes a checksum manifest identifying the legacy source archive, release
version, lockfile, configuration, and quiescence evidence. The archive and output directory have
restricted permissions. The report contains hashes, not credential-file contents. Verification
rejects tampering, unlisted paths, links, and special files before restoration. This deliberately
limited fixture format is **not a general production backup tool**; real state is archived with
`rust/scripts/legacy_archive.py`, following `rust/docs/cutover-runbook.md`.

The fresh runtime comes from a verified complete native release archive. Both SQLite and PostgreSQL
must start with an empty Tag roster and no old Task. The rehearsal recreates the reviewed synthetic
configuration, enrolls fresh execution capacity, and completes new work. It stops the new services
before restoring old state. The restored legacy runtime must recover history, permissions, journal,
checkpoint, and workspace, and return the original Task on an idempotent retry without executing it
again. The preserved archive must remain unchanged.

## Run

Use a local disposable PostgreSQL server and a `pg_dump`/`pg_restore` version that supports it.
The URL file is read privately; credentials are passed to PostgreSQL tools through their environment.
The script creates new databases and never queries application tables in the supplied base database.
Node must be 22.13 or later in the Node 22 line, and pnpm must match the chosen legacy source pin.
The fixture adapter must be a matching test-only build; it is not included in a production archive.

```sh
python3 -m unittest discover -s tests/rust-port-cutover -p 'test_*.py'

uv run tests/rust-port-cutover/rehearse.py \
  --legacy-commit FULL_LEGACY_SOURCE_COMMIT \
  --rust-archive /absolute/path/supertag-VERSION-darwin-arm64-complete.tar.gz \
  --fixture-adapter /absolute/path/supertag-fixture-adapter \
  --postgres-url-file /absolute/path/test-postgres-url \
  --pg-bin /absolute/path/postgres-client/bin \
  --node /absolute/path/node \
  --pnpm /absolute/path/pnpm \
  --output /absolute/path/new-private-rehearsal-directory
```

The legacy dependencies are installed from its frozen lockfile into the disposable source copy.
Registry downloads may be needed; provider credentials are never inherited. The script selects
explicit Node and pnpm executables so a Python launcher cannot silently substitute its own versions.
The output retains `receipt.json`, both database archives and their checksums, the matching legacy
source archive, and fixture logs. Successful runs remove `scratch/`, which contains only generated
state and dependencies. Failed runs keep it for diagnosis; the original archives stay separate.

This rehearsal does not verify stopping real ingress or connector consumers, interrupted provider
cleanup, compatibility with real native Session archives, or accounting for new external effects
before a production rollback. Those remain explicit deployment cutover gates.
