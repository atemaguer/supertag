# Cutover runbook: TypeScript to Rust

Operator procedure for moving one SuperTag installation from the TypeScript runtime to the Rust
runtime. The Rust runtime starts with fresh state. Old data is archived and verified separately.
Nothing imports it: Tags, Objectives, Tasks, Sessions, and history stay in the archive. The old
state directory stays untouched for 30 days as the rollback snapshot, then you delete it.

Both CLIs are named `supertag`. Each step says which one it uses. Commands in `rust/scripts/`
run from a SuperTag checkout.

## Before you start

| Need | Why |
| --- | --- |
| Python 3.11 or later and `zstd` | `rust/scripts/legacy_archive.py` writes and checks the archive |
| [`age`](https://age-encryption.org) and an age key pair | Encrypts the secrets bundle. `create` needs the public key, `verify` the identity file |
| Git | `create` checks the Task checkouts it leaves out for unsaved work |
| PyYAML (`uv run --with PyYAML==6.0.3`) | For translating `supertag.yaml` and manifests, and for archiving a state directory whose `supertag.yaml` names secret files |
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

Use the date of the cutover. With `SUPERTAG_STATE_DIR` set, rename that directory instead. Keep
the snapshot for 30 days; [Delete the snapshot](#8-delete-the-snapshot-after-30-days) gives the
procedure and how to record the date.

With PostgreSQL, leave the old database as it is. Rust needs a different, empty database. Put
the old URL in a private file for the next step:

```sh
umask 077; printf '%s\n' 'postgresql://USER:PASSWORD@HOST:5432/supertag' > ~/legacy-db-url
```

## 3. Archive

Make an age key pair for the secrets bundle, unless you already have one. Keep the identity file
private, and store a copy in a password manager: without it the secrets cannot be restored.

```sh
age-keygen -o ~/supertag-legacy-age.key
age-keygen -y ~/supertag-legacy-age.key      # prints the recipient, age1...
```

```sh
python3 rust/scripts/legacy_archive.py create \
  --from ~/.supertag-legacy-20261113 \
  --to ~/supertag-legacy-20261113.tar.zst \
  --age-recipient age1... \
  --age-identity ~/supertag-legacy-age.key
```

Repeat `--age-recipient` for each key that should decrypt the bundle, such as a second key kept
offline, or name a file of recipients, one per line, with `--age-recipients-file`. SSH public keys
work too. `--age-identity` makes `create` check that the bundle decrypts; leave it out when the
identity is not on this machine, and run `verify` with it before you rely on the bundle.

Add `--database-url-file ~/legacy-db-url` for PostgreSQL, and `--pg-bin DIR` to choose its client
tools. The URL may carry `host` (a socket directory), `sslmode`, `sslrootcert`, `sslcert`, and
`sslkey`. `create` refuses to run while a pid file names a live process, or while the SQLite
database has a non-empty `-wal` or `-journal` file. Without `--database-url-file` it archives
`supertag.db`, and warns when `supertag.yaml`, `.env`, or the shell names a PostgreSQL
database. Heed that warning: it means `supertag.db` may be stale.

`create` writes `FILE`, `FILE.sha256`, and `FILE.secrets.tar.age`, all readable only by you,
and verifies them before returning. It refuses to run when the state directory holds secret files
and no recipient is named, or when `age` is not installed. It prints sizes, row counts, the secret
files it encrypted, the Task checkouts with unsaved work, timings, and `snapshotDeleteAfter`, the
first day you may delete the snapshot.

What the archive holds:

| Path | Contents |
| --- | --- |
| `state/` | Every file of the state directory, byte for byte, except secrets and Task checkouts. Symlinks stay symlinks |
| `database/supertag.pgdump` | `pg_dump --format=custom` of the old database, for PostgreSQL |
| `tables/TABLE.jsonl` | Every row of every table as one JSON object per line |
| `records/tags.json` | Tags with their Role assignments |
| `records/objectives.json` | Objectives with their Mailbox messages, their Team and its Workstream posts, and Task IDs |
| `records/tasks.json` | Tasks with request, response, result, and every Task Attempt |
| `records/conversations.json` | Sessions as request and response turns with delivered replies, and messages between Tags |
| `manifest.json` | Size, mode, and SHA-256 of every entry; the row count of every table; each secret's path, size, and SHA-256; the secrets bundle's SHA-256 and recipients; the snapshot's deletion date |

`FILE.secrets.tar.age`, next to the archive, is a tar of the secret files, with their paths
relative to the state directory and their modes, encrypted with age to the recipients. Plaintext
secrets never touch disk while `create` or `verify` runs.

The `records/` files and `tables/` export make the data usable without the TypeScript runtime.
Read them with `zstd -dc FILE | tar -xOf - records/tasks.json`.

### Secrets

Secrets are kept out of the archive and encrypted into the secrets bundle. These file names count
as secrets anywhere in the state directory:

- `credentials.json`, the file credential store, and any name ending in `credentials.json`, such
  as Claude Code's `.credentials.json`
- `credential.json` and any name ending in `credential.json`: `hosts/SERVICE/credential.json`
  and `worker-hosts/ID.credential.json` hold Worker Host credentials
- `auth.json`, the Codex and OpenCode sign-in
- `.env`, `.env.*`, `*.pem`, `*.key`, and SSH private keys

Names ending in `.example`, `.sample`, or `.template` do not count. Any file, whatever its name,
also counts when the state directory's `supertag.yaml` reads a secret from it: a `secrets:` entry
of the form `{ file: PATH }`, each `env_file`, a Control Plane's `tls.key` and `operators.file`,
and a host's `volume-credentials` files and directories. So does the `--database-url-file` when
it is in the state directory. Paths resolve as TypeScript resolved them: relative to
`supertag.yaml`, with `~` as your home and `${VAR}` from your shell. A path under the old state
directory location (`SUPERTAG_STATE_DIR`, or `~/.supertag`) names the same file in the renamed
snapshot. When `supertag.yaml` uses any of those keys, `create` reads it with PyYAML, and refuses
to run without it:

```sh
uv run --with PyYAML==6.0.3 rust/scripts/legacy_archive.py create --from ... --to ...
```
 The manifest lists each
secret by path, size, and SHA-256 only. Task checkouts are not archived, so a repository file with
one of these names in a checkout is in neither the archive nor the bundle.

The database stores only digests of Auth Keys and Operator Tokens, and references to other
secrets, so it goes into the archive whole. The archive still holds conversation text, Task
output, and harness transcripts that may quote secrets. Keep it private, as you would the state
directory.

Rust needs none of the old secrets. Old Worker Host credentials, Auth Keys, and Operator Tokens
do not work against the new Control Plane. Old provider sign-ins and collaboration surface
tokens are set up again in step 6. The secrets bundle is what lets you roll back from the
archive without issuing every host and surface credential again.

### Task checkouts

`create` always leaves out Task checkouts, `workspaces/*/worktrees`. They can dominate a state
directory: in the rehearsal they were 5.0 of 5.2 GB. They point at the Workspace's repository
outside the state directory, which holds their commits. Add `--exclude GLOB` to leave out more
paths. The manifest records each pattern.

Before it archives, `create` checks each checkout with Git, without writing to it, and warns about
any that has uncommitted changes, whose commit is on no branch of the repository, or that Git
cannot read. The manifest lists them under `unsavedCheckouts`. Their work lives only in the
snapshot: commit and push it, or copy the checkout somewhere else, before you delete the
snapshot. The checkouts' registration lives in the repository's `.git/worktrees`, outside the
archive.

## 4. Verify

`create` already verified the archive. Verify again after you copy it anywhere, and once more
before you delete the snapshot:

```sh
python3 rust/scripts/legacy_archive.py verify ~/supertag-legacy-20261113.tar.zst \
  --from ~/.supertag-legacy-20261113 \
  --age-identity ~/supertag-legacy-age.key
```

`verify` checks the outer SHA-256 against `FILE.sha256`, then every entry against the manifest,
every `tables/` export against its row count, and the readable records against their tables. It
opens the archived SQLite database and counts every table again. A PostgreSQL dump must be
readable by `pg_restore --list`. It checks the secrets bundle's SHA-256 against the manifest,
decrypts it with the identity, and matches every secret's size and SHA-256 with the manifest.
`verify` refuses an archive with a secrets bundle unless you pass `--age-identity`.

With `--from`, `verify` also compares the snapshot: every file's SHA-256, every secret, and every
table's row count. It counts SQLite rows from a private copy of the database. For
PostgreSQL, add `--database-url-file` and it counts rows in the old database.

Copy the archive, its `.sha256` file, and its `.secrets.tar.age` bundle to backup storage that
encrypts at rest, keeping the three names together. The `.sha256` file catches damage, not
tampering, so keep a second copy of it apart from the archive. Keep the age identity file apart
from all three, such as in a password manager.

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
| Control Plane `credentials: vault://...` | Removed. The local supervisor keeps credentials in files. A deployed Control Plane chooses Vault with `supertag setup deployment` |
| `x-` keys | Kept only at the top level. Rust refuses them inside services, and `x-` entries under `services` are removed. YAML anchors are expanded first |
| Host `labels` | Unchanged. The host reports them with its presence, so a Tag's `runsOn` still selects it |
| Host `environment` | Removed. Put harness variables in `env_file` |
| Host `mcp` | Removed. Write the servers to a JSON MCP catalog for `supertag worker-host --mcp-catalog`, and check it with `supertag mcp list --mcp-catalog PATH` |
| Host `volume-credentials`, `artifact-volume`, `local-mount-root` | Removed. Register Volumes with `supertag volume put` |
| Host `allow-unsandboxed-commands` | Only `claude-code`, `opencode`, and `cursor` remain; Rust refuses other harnesses here |
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
| Tag `locations` | Removed. Bind each location with a `SurfaceLocation` document or `supertag surface-location`, after its account is connected |
| Every `Workspace` | Removed. A local repository is a host's `workspaces` entry in `supertag.yaml`; move `delivery` and `setup` there. Recreate a GitHub `source` with `supertag workspace put --account ACCOUNT --repository-id ID --repository OWNER/REPO NAME` |
| `Workspace` `ref`, `skills` | No Rust counterpart. A Tag binds a local repository at a commit with `workspace: {id: NAME, baseCommit: SHA}`. Skills come from the host's `skills` catalog |
| `SurfaceAccount` | Removed. Connect the account again with `supertag setup surface PROVIDER` (step 6) |
| Volume `credential` | Removed. The Control Plane supplies storage credentials |
| PermissionSet `surfaceAccountId`, `approval: required` | `surface_account_id`, `approval_required: true` |
| Objective `owner`, `budget: {minor, currency}` | `ownerTagId`, `budgetLimitMinor`, `budgetCurrency`. `workspaces` and an inline `team` are removed; declare the Team as a `Team` document |
| Any other field Rust does not accept, such as extra `metadata` | Removed and listed |

`manifests` prints each change and what replaces a removed field. It checks every field name
against the Rust manifest, not the values. `supertag diff` reports the first document it cannot
read by number, without naming the field. Fix that document and run `diff` again.

Check the result with `supertag status`, then submit one Task to each Tag. Recreate open
Objectives from `records/objectives.json` with `supertag objective create`.

## 8. Delete the snapshot after 30 days

Keep the snapshot for 30 days after the cutover, so a problem found in the first weeks can still
roll back. `create` prints the first day you may delete it as `snapshotDeleteAfter`, and the
manifest records it under `snapshot.deleteAfter`. Record that date where you will see it, such
as a calendar reminder, when you archive. To read it again later:

```sh
zstd -dc ~/supertag-legacy-20261113.tar.zst | tar -xOf - manifest.json \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["snapshot"]["deleteAfter"])'
```

On or after that date:

1. Confirm the Rust installation has run your work for those 30 days and you do not intend to
   roll back.
2. Save the work of every checkout `create` listed under `unsavedCheckouts`, if you still want it.
3. Verify the backup copy, not only the local one, against the snapshot and with the identity:
   `python3 rust/scripts/legacy_archive.py verify BACKUP_COPY --from ~/.supertag-legacy-20261113
   --age-identity ~/supertag-legacy-age.key`.
4. Delete the snapshot: `rm -rf ~/.supertag-legacy-20261113`. With PostgreSQL, drop the old
   database at the same time; the archive holds its dump.

After this, rolling back means restoring from the archive and its secrets bundle, as the
[Rollback](#rollback) section describes.

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
then decrypt the secrets bundle into it:

```sh
mkdir -m 700 ~/.supertag && cd ~/.supertag
zstd -dc ~/supertag-legacy-20261113.tar.zst | tar -xf - --strip-components 1 state
age -d -i ~/supertag-legacy-age.key ~/supertag-legacy-20261113.tar.zst.secrets.tar.age | tar -xf -
```

With PostgreSQL, `pg_restore` the dump into an empty database. Run `verify --from` against the
restored directory before you start the old services. Task checkouts are not in the archive; the
old runtime creates new ones for new Tasks.

## Rehearsal

Recorded November 13, 2026, macOS ARM64, on copies. The live directories were read only by
`cp -R`, or by `rsync` for the copy without Task checkouts, with no SQLite connection to them,
while no old Control Plane ran.

| Source copy | State | Entries | Tables, rows | Archive | `create` | `verify --from` |
| --- | --- | --- | --- | --- | --- | --- |
| A barely used `~/.supertag` | 66.7 MB | 17,400 | 56 tables, 23 rows | 4.0 MB | 3.9 s | 1.2 s |
| A dogfood state directory | 5.17 GB | 159,355 | 54 tables, 5,327 rows | 1.54 GB | 104 s | 59 s |
| The same, without `workspaces/*/worktrees` | 147 MB | 593 | 54 tables, 5,327 rows | 11 MB | 2.1 s | 0.6 s |

`create` now always leaves out `workspaces/*/worktrees`, so the last row is what the dogfood state
directory produces today. The dogfood archive holds 12 Tags, 3 Objectives, 140 Tasks, and 31
Sessions in `records/`. Each Objective carries its Team. It left out 4 secret files: `.env`,
`credentials.json`, and two host `credential.json` files. The `~/.supertag` copy had a planted
`worker-hosts/ID.credential.json` and a Codex `auth.json`. Both were left out, and the archive
held no byte of either.

That rehearsal predates the secrets bundle, the fixed Task checkout exclusion, and the snapshot
date. They were rehearsed on November 14, 2026 against synthetic state in a disposable directory,
with a stand-in for `age`, because `age` was not installed on that machine. The real `age` round
trip is covered by `RealAgeSecretsBundleTests`, which skips with a message when `age` and
`age-keygen` are not installed.

The translated dogfood `supertag.yaml` passed `supertag config` after `config` dropped
`claude-code` from two `allow-unsandboxed-commands` lists. Rust has since accepted that consent
for Claude Code and host `labels`, so `config` now keeps both. So did a file with `x-` keys inside
services, an `x-` service entry, and `credentials: vault://...`. The translated dogfood
manifests, plus a GitHub Workspace, a Tag with `locations`, a Volume with `credential`, and a
Permission Set with `approval: required`, applied cleanly to a fresh Rust Control Plane. A
second `supertag diff` reported no changes. A translated Objective and surface grant passed
`supertag diff`.

`python3 -m unittest discover -s rust/scripts -p 'test_legacy_archive.py'` covers the archive
format, the secrets bundle (recipients, decryption with the right and a wrong identity, a changed
or missing bundle, secrets that differ from the manifest, and the files `supertag.yaml` names as
secrets), Task checkout exclusion and the
unsaved-work warnings, the snapshot date, tampering, row-count checks, damaged archives,
PostgreSQL URL options, and translation. The bundle tests use a stand-in for `age` everywhere,
and the real `age` with throwaway keys when it is installed. Set
`SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE` to a disposable server's URL file to include
the PostgreSQL round trip.
