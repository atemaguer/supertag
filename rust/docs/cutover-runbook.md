# Cutover runbook: TypeScript to Rust

Operator procedure for moving one SuperTag installation from the TypeScript runtime to the Rust
runtime. The Rust runtime starts with fresh state. Old data is archived and verified separately.
Nothing imports it: Tags, Objectives, Tasks, Sessions, and history stay in the archive. The old
state directory stays untouched so you can roll back.

Both CLIs are named `supertag`. Each step says which one it uses. Commands in `rust/scripts/`
run from a SuperTag checkout.

## Before you start

| Need | Why |
| --- | --- |
| Python 3.11 or later and `zstd` | `rust/scripts/legacy_archive.py` writes and checks the archive |
| PyYAML (`uv run --with PyYAML==6.0.3`) | Only for translating `supertag.yaml` and manifests |
| `psql`, `pg_dump`, and `pg_restore` | Only when the old Control Plane used PostgreSQL |
| Free disk of about one third of the state directory | The rehearsal compressed 5.2 GB to 1.5 GB |
| The Rust native release archive | Installs the Rust `supertag` |
| A list of in-flight work | Running Tasks and open Objectives do not carry over |

Let running Tasks finish, or cancel them, before you stop anything. Unfinished Objectives stay in
the archive. Restart them in Rust as new Objectives.

## 1. Stop the TypeScript services

With the TypeScript CLI:

```sh
supertag ps
supertag down --remove-services
supertag ps            # every service reports stopped
```

Stop every remote Worker Host and Gateway that connects to this Control Plane too. If the old
Control Plane runs elsewhere, such as Docker Compose or a VM, stop that deployment. Writes made
after this point are not in the archive.

## 2. Take the snapshot

Rename the state directory. The renamed directory is the snapshot and the rollback source, so
never edit it.

```sh
mv ~/.supertag ~/.supertag-legacy-20261113
chmod 700 ~/.supertag-legacy-20261113
```

Use the date of the cutover. With `SUPERTAG_STATE_DIR` set, rename that directory instead.

With PostgreSQL, leave the old database as it is. Rust needs a different, empty database. Put
the old URL in a private file for the next step:

```sh
umask 077; printf '%s\n' 'postgresql://USER:PASSWORD@HOST:5432/supertag' > ~/legacy-db-url
```

## 3. Archive

```sh
python3 rust/scripts/legacy_archive.py create \
  --from ~/.supertag-legacy-20261113 \
  --to ~/supertag-legacy-20261113.tar.zst
```

Add `--database-url-file ~/legacy-db-url` for PostgreSQL, and `--pg-bin DIR` to choose its client
tools. `create` refuses to run while a pid file names a live process, or while the SQLite
database has a non-empty `-wal` or `-journal` file.

`create` writes `FILE` and `FILE.sha256`, both readable only by you, and verifies them before
returning. It prints sizes, row counts, the secret files it left out, and timings.

What the archive holds:

| Path | Contents |
| --- | --- |
| `state/` | Every file of the state directory, byte for byte, except secrets. Symlinks stay symlinks |
| `database/supertag.pgdump` | `pg_dump --format=custom` of the old database, for PostgreSQL |
| `tables/TABLE.jsonl` | Every row of every table as one JSON object per line |
| `records/tags.json` | Tags with their Role assignments |
| `records/objectives.json` | Objectives with messages, Workstream posts, and Task IDs |
| `records/tasks.json` | Tasks with request, response, result, and every Task Attempt |
| `records/conversations.json` | Sessions as request and response turns with delivered replies, and messages between Tags |
| `manifest.json` | Size, mode, and SHA-256 of every entry; the row count of every table; the secrets left out |

The `records/` files and `tables/` export make the data usable without the TypeScript runtime.
Read them with `zstd -dc FILE | tar -xOf - records/tasks.json`.

### Secrets

Secrets are left out of the archive, not encrypted inside it. These file names count as secrets
anywhere in the state directory: `credentials.json`, `credential.json`, `.env`, `.env.*`,
`*.pem`, `*.key`, and SSH private keys. Names ending in `.example`, `.sample`, or `.template` do
not. The manifest lists each left-out file by path, size, and SHA-256 only.

The database stores only digests of Auth Keys and Operator Tokens, and references to other
secrets, so it goes into the archive whole. The archive still holds conversation text, Task
output, and harness transcripts that may quote secrets. Keep it private, as you would the state
directory.

Rust needs none of the old secrets. Old Worker Host credentials, Auth Keys, and Operator Tokens
do not work against the new Control Plane. Old provider sign-ins and collaboration surface
tokens are set up again in step 6. The snapshot keeps the secret files until you delete it.

### Large state directories

Task checkouts can dominate a state directory. In the rehearsal, `workspaces/*/worktrees`
was 5.0 of 5.2 GB, and those checkouts point at the Workspace's repository outside the state
directory. Leave them out with `--exclude 'workspaces/*/worktrees'` when their commits already
live in that repository. Repeat `--exclude` for more paths. The manifest records each pattern.

## 4. Verify

`create` already verified the archive. Verify again after you copy it anywhere, and once more
before you delete the snapshot:

```sh
python3 rust/scripts/legacy_archive.py verify ~/supertag-legacy-20261113.tar.zst \
  --from ~/.supertag-legacy-20261113
```

`verify` checks the outer SHA-256 against `FILE.sha256`, then every entry against the manifest,
every `tables/` export against its row count, and the readable records against their tables. It
opens the archived SQLite database and counts every table again. A PostgreSQL dump must be
readable by `pg_restore --list`.

With `--from`, `verify` also compares the snapshot: every file's SHA-256, every left-out secret,
and every table's row count. It counts SQLite rows from a private copy of the database. For
PostgreSQL, add `--database-url-file` and it counts rows in the old database.

Copy the archive and its `.sha256` file to backup storage that encrypts at rest.

## 5. Start fresh Rust state

Install the Rust CLI from the native release archive:

```sh
uv run rust/scripts/install_native_release.py supertag-VERSION-PLATFORM-complete.tar.gz
supertag version
```

Translate the old `supertag.yaml`:

```sh
uv run --with PyYAML==6.0.3 rust/scripts/legacy_archive.py config \
  ~/.supertag-legacy-20261113/supertag.yaml --to ~/supertag-rust.yaml
mkdir -m 700 ~/.supertag
mv ~/supertag-rust.yaml ~/.supertag/supertag.yaml
supertag config        # the Rust CLI prints the resolved file, or why it is invalid
```

`config` lists every key it removed and what replaces it. YAML comments do not survive. Rust
reports an invalid file without naming the key, so translate with the tool rather than by hand.
For a new setup instead, run `supertag init` in the repository.

| TypeScript `supertag.yaml` | Rust |
| --- | --- |
| `env_file`, `secrets`, `name`, `version` | Unchanged. Copy the old state directory's `.env` into the new one if you used it |
| Control Plane `tls`, `hosts` | Removed. The local Control Plane listens on loopback; use `supertag setup deployment` for a deployed one |
| Control Plane `operators` | Removed. Issue named Operator Tokens with `supertag operator-token create` |
| Control Plane `logging.level`, `logging.format` | Removed. Only `logging.audit` remains |
| Control Plane `database` | Unchanged form. Point `url` at a new, empty database, never the old one |
| Host `labels` | Removed. Grant labels with `supertag auth-key create --role host --label LABEL` |
| Host `environment` | Removed. Put harness variables in `env_file` |
| Host `mcp` | Removed. `supertag mcp list` shows the host's catalog MCP servers |
| Host `volume-credentials`, `artifact-volume`, `local-mount-root` | Removed. Register Volumes with `supertag volume put` |
| Host `allow-unsandboxed-commands` | Only `opencode` and `cursor` remain; Rust refuses other harnesses here |
| Host `workspaces` | Unchanged. An entry may also be `{path, delivery, setup}` |
| Top-level `surfaces` | New in Rust. See `supertag setup surface` |

Start the services and check them:

```sh
supertag up
supertag ps
supertag status        # Worker Hosts from supertag.yaml, no Tags yet
```

Local hosts in `supertag.yaml` enroll with the local operator credential and serve every Tag.
Check each harness's sign-in with `supertag sign-in HARNESS`.

## 6. Enroll hosts, Gateways, and clients again

Every principal enrolls again with a new Auth Key. With the Rust CLI on the Control Plane's
machine:

```sh
supertag auth-key create laptop-hosts --role host --reusable --label verify
supertag auth-key create gateway --role gateway --all-tags
supertag auth-key create phone --role client --tag lead
```

On each remote Worker Host, start from an empty state directory. Then run
`supertag host enroll --control-plane URL --state-directory DIR --auth-key file:PATH HOST_ID`,
followed by `supertag worker-host`. Or give the host service `control-plane` and `auth-key` in
its `supertag.yaml` and run `supertag up`. Enroll Gateways with `supertag gateway enroll`, and
operator devices with `supertag connect`.

Connect collaboration surface accounts again with `supertag setup surface slack` (or `github`,
`linear`, `lark`, `teams`). Log in to OAuth MCP servers again with `supertag mcp login`.

## 7. Apply manifests again

Translate the resource manifests you applied to the old Control Plane, then preview and apply:

```sh
uv run --with PyYAML==6.0.3 rust/scripts/legacy_archive.py manifests org.yaml --to org-rust.yaml
supertag diff -f org-rust.yaml
supertag apply -f org-rust.yaml
supertag get tag
```

| TypeScript manifest | Rust |
| --- | --- |
| `execution: {model, effort}` on Tags and Roles | `execution: {models: [...], efforts: [...]}` |
| Tag `workerHosts` | Removed. Local Worker Hosts serve every Tag. Route remote hosts with Auth Key labels and the Tag's `runsOn` |
| `Workspace` without `github` | Removed. A local repository is a host's `workspaces` entry in `supertag.yaml`. Move `delivery` and `setup` there |
| `Workspace` `ref`, `skills` | No Rust counterpart. A Tag binds a local repository at a commit with `workspace: {id: NAME, baseCommit: SHA}`. Skills come from the host's `skills` catalog |

`manifests` prints each change. `supertag diff` reports the first document it cannot read by
number, without naming the field. Fix that document and run `diff` again.

Check the result with `supertag status`, then submit one Task to each Tag. Recreate open
Objectives from `records/objectives.json` with `supertag objective create`.

## Rollback

Roll back until you delete the snapshot. Work done in Rust does not move back. External effects
stay where they happened, such as delivered replies, pushed branches, and pull requests.

1. With the Rust CLI: `supertag down --remove-services`. Stop remote Rust Worker Hosts and
   Gateways too.
2. Move the Rust state aside: `mv ~/.supertag ~/.supertag-rust-20261113`.
3. Restore the snapshot: `mv ~/.supertag-legacy-20261113 ~/.supertag`.
4. Install the TypeScript CLI version that last ran this state.
5. With the TypeScript CLI: `supertag up`. PostgreSQL users point it at the old database, which
   Rust never opened.
6. Start the old remote Worker Hosts and Gateways. Their old credentials still work.

If the snapshot is gone, restore one from the archive. Extract `state/` into a new directory,
then copy the left-out secret files back from your own backup. With PostgreSQL, `pg_restore`
the dump into an empty database. Run `verify --from` against the restored directory before you
start the old services.

## Rehearsal

Recorded November 13, 2026, macOS ARM64, on copies. The live directories were read only by
`cp -R`, with no SQLite connection to them, while no old Control Plane ran.

| Source copy | State | Entries | Tables, rows | Archive | `create` | `verify --from` |
| --- | --- | --- | --- | --- | --- | --- |
| A barely used `~/.supertag` | 66.7 MB | 17,396 | 56 tables, 23 rows | 4.0 MB | 4.5 s | 4.4 s |
| A dogfood state directory | 5.17 GB | 159,355 | 54 tables, 5,327 rows | 1.54 GB | 104 s | 59 s |
| The same, without `workspaces/*/worktrees` | 147 MB | 593 | 54 tables, 5,327 rows | 11 MB | 2.5 s | included |

The dogfood archive holds 12 Tags, 3 Objectives, 140 Tasks, and 31 Sessions in `records/`. It
left out 4 secret files: `.env`, `credentials.json`, and two host `credential.json` files.

The translated dogfood `supertag.yaml` passed `supertag config` after `config` dropped
`claude-code` from two `allow-unsandboxed-commands` lists. Its translated manifests applied
cleanly to a fresh Rust Control Plane: 1 Permission Set, 5 Roles, 12 Tags, and 12 Role
assignments. A second `supertag diff` reported no changes.

`python3 -m unittest discover -s rust/scripts -p 'test_legacy_archive.py'` covers the archive
format, secret exclusion, tampering, row-count checks, and translation. Set
`SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE` to a disposable server's URL file to include
the PostgreSQL round trip.
