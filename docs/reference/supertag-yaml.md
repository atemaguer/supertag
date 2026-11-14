# supertag.yaml and local state

`supertag.yaml` lists the services that run SuperTag on one machine, much like a compose file.
`supertag up` reads it and brings those services up. There are two service types:

- A **`control-plane` service** runs a local **Control Plane**, the SuperTag service that stores
  your [organization](glossary.md#autonomous-organization) and schedules its work. A file has at
  most one.
- A **`host` service** connects this machine as a **Worker Host**, a computer that runs
  [Tasks](glossary.md#task) for Tags, the persistent AI actors with their own responsibilities
  and permissions. A file can have any number.

Other terms on this page are defined in the glossary: [Role](glossary.md#role),
[Objective](glossary.md#objective), [Task Attempt](glossary.md#task-attempt),
[Skill](glossary.md#skill), [Context Set](glossary.md#context-set),
[Permission Set](glossary.md#permission-set), [Surface Account](glossary.md#surface-account),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token), [Worklet](glossary.md#worklet),
[Worker](glossary.md#worker), [Volume](glossary.md#volume), and [Workspace](glossary.md#workspace).

The file declares how SuperTag runs, not what your organization contains:

| To change | Use |
| --- | --- |
| How the local Control Plane runs, and what this machine serves | `supertag.yaml`, then `supertag up` |
| Tags, Roles, Permission Sets, Context Sets, Workspaces, Surface Accounts, and Objectives | Manifests and `supertag apply -f` ([Manage Control Plane resources](../operations/resources.md)) |
| Which Tags a Worker Host serves | A Tag manifest's `spec.workerHosts`, or `supertag update tag TAG --add-worker-host ID` |
| Operator access and joining keys | `supertag create operator-token NAME` and `supertag create auth-key NAME --tag TAG` |

The file lives at `~/.supertag/supertag.yaml`, or in the directory `SUPERTAG_STATE_DIR` names.
`supertag init` writes it. `-f PATH` reads another file instead. Without any file, `supertag up`
runs one `control-plane` service with the defaults. Nothing is written to your repositories.

Before writing the file, `supertag init` checks the selected harnesses through their bundled
Workers. The menu shows each harness's sign-in result and how to sign in when needed. Only signed-in
harnesses are selected by default, and at least one selected harness must pass. At the `Port`
prompt, an occupied port on `127.0.0.1` asks for another number. `supertag init --yes` chooses the
next free port. An occupied port set by an environment variable requires changing that variable.

## Examples

### On your own

`supertag init` writes this file. The host service is named after the machine:

```yaml
services:
  control-plane:
    type: control-plane
  studio:
    type: host
    harnesses: [claude-code]
    allow-unsandboxed-commands: [claude-code]
    workspaces:
      app: ~/code/app
```

`allow-unsandboxed-commands` lets Claude Code run commands on this machine without a sandbox; see
[Unsandboxed harnesses](#unsandboxed-harnesses). `supertag up` starts the Control Plane, then the host. The host joins the Control Plane in the same
file on its own. `supertag ps` shows both:

```text
SERVICE        TYPE           STATE    ADDRESS                PROCESS
control-plane  control-plane  running  http://127.0.0.1:3434  41822 in the background
studio         host           running  http://127.0.0.1:3434  41907 in the background
  Worker Host studio; connected; Tags lead; Task Attempts running: 0
```

### A teammate's laptop

A teammate joins a Control Plane the team shares. The file has no `control-plane` service. The
host names the shared Control Plane's URL and the secret that holds its Auth Key:

```yaml
services:
  laptop:
    type: host
    control-plane: https://supertag.acme.dev
    auth-key: laptop-key
    harnesses: [codex]
    workspaces: { app: ~/code/app }
secrets:
  laptop-key: { file: ~/laptop.key }
```

The first `supertag up` joins with the key and stores the host's own credential. Later runs use
that credential and ignore the key, so the key file can be deleted.

### A shared server

A team's Control Plane, on a server that teammates reach over HTTPS:

```yaml
name: acme-eng
services:
  control-plane:
    type: control-plane
    url: https://supertag.acme.dev
    ports: ["0.0.0.0:3434"]
    restart: unless-stopped
    database: { url: "postgresql://supertag@db/supertag", password: db-password }
    credentials: vault://secret/supertag
    notify: slack:C0123456789
    logging: { format: json, audit: /var/log/supertag/audit.jsonl }
    provision:
      - ~/acme/org.yaml
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec: { roles: [Lead] }
secrets:
  db-password: { environment: PGPASSWORD }
```

Put TLS in front of port 3434. Hosts connect over WebSocket at `url`, so the server needs no
second listener. The Control Plane stores no artifact bytes: each host keeps the artifacts its
Tasks capture. Containers and hosting platforms read this file too, but environment variables
remain their main configuration; see
[In containers and hosting platforms](#in-containers-and-hosting-platforms).

## Commands

| Command | Does |
| --- | --- |
| `supertag up` | Brings up every service, or the ones named, plus what they depend on |
| `supertag down` | Drains hosts and waits up to five minutes, listing running Task and Task Attempt IDs. If any remain, exits non-zero without stopping that host or subsequent services; `--force` stops without waiting. Naming a host service the file no longer names also removes its unit, Worker Host, and state |
| `supertag ps` | Lists services and their state |
| `supertag logs -f` | Follows service logs |
| `supertag config` | Prints the resolved file, or every problem in it |

See [Direct work with the CLI](../operations/cli.md#run-and-stop-supertag) for how they behave. A host service you delete from the file keeps running and stays bound to its Tags until `supertag down SERVICE` removes it.

For text output, a missing required flag reports its name and that command's one-line usage.
An unknown command points to `supertag --help`. Errors requested with `--output json` keep
their machine-readable form. `supertag list worker-host` and `supertag describe worker-host`
show built-in harness names such as `claude-code` and `codex` from Worker capabilities.

## File format

### Top level

| Key | Meaning |
| --- | --- |
| `version` | Optional. `1`, the only format. |
| `name` | Instance name, default `supertag`. Labels service units and `supertag ps`. |
| `services` | Service name to service. Names use lowercase letters, digits, `-`, and `_`, up to 63 characters. |
| `secrets` | Secret name to source. Services refer to secrets by name. |
| `env_file` | A file, or a list of files, of `KEY=value` lines for interpolation, `environment` secrets, and `SUPERTAG_*` overrides. The process environment wins over it. Paths are relative to this file. Default: `.env` beside this file, when present. |
| `x-*` | Ignored. Use these keys for YAML anchors. |

An unknown key is an error. `supertag up` and `supertag config` report every problem at once, each
with its file, line, column, and key path:

```text
supertag.yaml:4:5: services.control-plane.prots: unknown field; expected one of type, ports, url, ...
```

### control-plane service

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | required | `control-plane` |
| `ports` | `["127.0.0.1:3434"]` | One entry, `"PORT"` or `"IP:PORT"`. Use `0.0.0.0` only behind TLS. |
| `url` | `http://127.0.0.1:PORT` | The public base URL. Hosts connect to it, and coordination links use it. |
| `database.url` | SQLite at `~/.supertag/supertag.db` | `file:PATH`, relative to this file, or `postgresql://USER@HOST:PORT/DATABASE` without a password |
| `database.password` | none | A secret name. It becomes `PGPASSWORD` for the Control Plane, unless `PGPASSWORD` is already set. |
| `credentials` | `file` | Where the credential vault keeps secrets: `file`, or `vault://MOUNT/PREFIX` with `VAULT_ADDR` and `VAULT_TOKEN` in the environment |
| `notify` | `desktop` under local `supertag up`; otherwise off | One destination string or a list: `desktop`, `webhook:https://HOST/PATH[#secret-name]`, or `slack:CHANNEL_OR_USER` (optionally `slack:WORKSPACE/CHANNEL_OR_USER`). A webhook secret name must exist under `secrets:`. See [Set up operator notifications](../guides/notifications.md). |
| `logging.level` | `info` | `error`, `warn`, `info`, `debug`, or `trace`. Only `trace` changes the output today: it adds RPC lifecycle events. |
| `logging.format` | `text` | `text`, or `json` for one JSON object per line |
| `logging.audit` | `stderr` | Where audit entries go besides the database, which always keeps them: `stderr`, the service log, or a file path that receives one JSON line per entry. The file's directory must exist; a failed write never fails the change. See [Audit log](../operations/control-plane.md#audit-log). |
| `hosts.grpc` | none | `"PORT"` or `"IP:PORT"` for an extra gRPC listener for Worklets. Without it, hosts connect over WebSocket at `url`. |
| `tls.cert`, `tls.key` | none | Certificate and key files for the `hosts.grpc` listener. They need `hosts.grpc`. |
| `tls.ca` | none | A CA file that host services in the same file trust |
| `operators.file` | none | A JSON file of scoped coordination operator credentials. [Operator Tokens](resource-model.md#operator-tokens) cover most uses. |
| `provision` | none | Manifests to create when missing. See [Provision resources](#provision-resources). |
| `restart` | `no` | `unless-stopped` installs a service unit. See [Service units](#service-units). |
| `depends_on` | none | Service names to bring up first |

The admin token stays out of the file. The local Control Plane accepts this machine's local
operator credential, and a shared one reads `SUPERTAG_ADMIN_TOKEN` from its environment.

### host service

A Volume is a named storage source that a Workspace attaches beside its git checkout. A host
service maps the Volume's credential name to a secret source on this machine. For example,
`volume-credentials: { datasets: { environment: DATASET_TOKEN } }` lets the host use
`DATASET_TOKEN` when it copies a Volume whose credential is `datasets`.
The host advertises a mapping only when it can read the referenced secret. A `file://` Volume
needs a `{ path: /srv/datasets }` mapping instead. The path names the host directory the operator
consents to copy. SuperTag resolves links in both paths and refuses a Volume source outside that
directory. An object-store mapping cannot authorize a `file://` source. To expose a home directory
or a hidden directory below it, name that directory directly in the mapping. SuperTag always
refuses sources that contain its state, settings, or secret files. SuperTag keeps credentials on the
Worker Host and does not pass their values to a Task or provider. Tasks running under the same
operating-system account can still read credential files. See
[Credentials and local access](../concepts/persistence.md#credentials-and-local-access) for isolation
requirements.
`SUPERTAG_MCP_*` variables cannot be used as Volume credential references.

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | required | `host` |
| `control-plane` | the file's `control-plane` service | That service's name, or a shared Control Plane's `http(s)` URL |
| `auth-key` | none | A secret name holding an [Auth Key](resource-model.md#auth-keys). Only for a URL `control-plane`. |
| `harnesses` | required | One or more of `claude-code`, `codex`, `cursor`, and `opencode`; one Worker each |
| `environment` | none: this machine | Run Task Attempts in `e2b` or Modal sandboxes. See [Host environment](#host-environment). |
| `allow-unsandboxed-commands` | none | `claude-code`, `cursor`, or `opencode` from `harnesses`, to run commands without an enforced sandbox boundary. See [Unsandboxed harnesses](#unsandboxed-harnesses). |
| `models` | none | Models per harness: one model, or a list whose first is the default. See [Host models](#host-models). Cursor model IDs come from `Cursor.models.list`; OpenCode requires `provider/model`. |
| `workspaces` | none | Workspace name to an absolute or `~` checkout path |
| `local-mount-root` | none: refuse local mounts | Existing host directory containing every local mount destination. Resolved and verified at startup. |
| `volume-credentials` | none | Volume credential name to a host-only `{ environment: VAR }` or `{ file: PATH }` reference for S3/R2, `{ modal-secret: NAME }` or `{ modal-oidc-role: ARN }` for native bucket mounts, `{ modal-volume: NAME }` for Modal Volume consent, or `{ path: DIR }` for a `file://` source. Relative paths resolve from this settings file. Hosts need the mapping to serve a workspace that mounts the Volume. |
| `artifact-volume` | none: the host's state directory | The Volume this host stores the artifacts its Tasks capture on. Map its credential in `volume-credentials`. See [Artifact Volume](#artifact-volume). |
| `labels` | none | Extra [placement labels](resource-model.md#worker-host-labels), such as `gpu` |
| `mcp` | none | [MCP servers](#host-mcp-servers) this machine provides |
| `skills` | none | Local Skill directory or JSON catalog file selected by Context Sets. Relative paths resolve from this settings file. |
| `concurrency` | From this machine | Task Attempts each harness Worker runs at once, from 1 through 16. See [Host concurrency](#host-concurrency). |
| `depends_on` | the `control-plane` service, when the file has one | Service names to bring up first |
| `restart` | `no` | `unless-stopped` installs a service unit |

### Host enrollment

A host in the same file as its Control Plane joins on its own. SuperTag enrolls it with this
machine's local operator credential and stores the host's own Worker Host credential. The host
joins under its service name, or `NAME-2` when that name is taken.

A host of a shared Control Plane joins with its `auth-key` secret, a host Auth Key, on its first
`supertag up`.
A missing or rejected key fails on the terminal. After the first join, the host uses its stored
credential and ignores the key. Without `auth-key`, it uses `SUPERTAG_AUTH_KEY` from the
environment.

### Workspace mount strategies

Workspace manifests select `strategy: copy` (default) or `strategy: mount` under `spec.mounts`.
`access` defaults to `read-only`; set `read-write` to save changes to the source. Placement refuses unsupported strategies before
calling a provider and never changes `mount` to `copy`. Local and e2b support only copies.
Modal attaches S3, R2, and GCS buckets and Modal Volumes with the declared access at Task start, after setup.
Native mounts require a host credential mapping:

```yaml
volume-credentials:
  datasets: { modal-secret: dataset-access }
  team-data: { modal-volume: training }
  training: { modal-oidc-role: arn:aws:iam::123456789012:role/training-reader }
```

These references are Experimental. `modal-secret` names an existing Modal Secret in the provider's
Modal environment. `modal-oidc-role` names an IAM role and works only with `s3://` sources.
SuperTag passes references to Modal's mount service, never secret values to the sandbox.
Environment and file secret references cannot authorize `mount`; provider-held references cannot
authorize `copy`. A `modal-volume://training/models/` source must name `credential: team-data`.
The `{ modal-volume: training }` mapping consents to that exact, case-sensitive Volume name.
Hosts without the named credential mapping are excluded during placement. Before any provider call,
the selected host also checks that the mapped name matches the source exactly.
Modal Volumes always use the host's configured Modal environment; source queries are rejected.
See [Native source settings](resource-model.md#native-source-settings).
See [Workspace mount fields](resource-model.md#workspaces).

### Volume credential secrets

For an `s3://` or `r2://` Volume, the secret is a JSON object. It needs `accessKeyId` and
`secretAccessKey`, and may add only `sessionToken`:

```json
{ "accessKeyId": "AKIA...", "secretAccessKey": "...", "sessionToken": "..." }
```

Any other secret field is refused, and the refusal never repeats its name or value.
Set `region`, `endpoint`, and `forcePathStyle` in the [Volume's source URL](resource-model.md#volumes),
for example `s3://acme-data/datasets/?region=eu-west-2&forcePathStyle=true`.
An `r2://` source requires an `endpoint` query parameter. A host's `file://` Volume needs a
`{ path: DIR }` mapping. Its source may not overlap the host's state directory, any loaded settings
file, an env_file, or a `{ file }` secret from any service. This includes every host service's
`volume-credentials` files. The Control Plane's TLS private key, operators file, SQLite database
(including its WAL/SHM files), this machine's Worker Host artifact directory, and the host's
artifact Volume are also protected, even outside the state directory. Overlap includes a source inside a protected directory
or containing a protected path, after symbolic links resolve.

### Artifact Volume

A host stores the artifacts its Tasks capture under its state directory. `artifact-volume` stores
them on a Volume instead, so they outlive the host and other hosts mapped to the Volume can read
them. For example, a cloud host that keeps its artifacts in a bucket:

```yaml
services:
  cloud:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [codex]
    artifact-volume: team-artifacts
    volume-credentials:
      team-artifacts: { environment: TEAM_ARTIFACTS_KEY }
```

The value is a Volume name. The host reads that Volume's source and credential name from the
Control Plane's catalog, then maps the credential name through its own `volume-credentials`, as
for Workspace mounts. The credential value stays on this host. A `file://` artifact Volume needs a
`{ path: DIR }` mapping whose directory contains the Volume's source.
For a file source, existing directories below that source, including `attempts`, must be real
directories. SuperTag checks these ancestors before and after creating a Task Attempt's directory.
It also compares each open upload file's device and inode with its expected path before writing
and after linking the completed copy. A mismatch or redirected ancestor rejects the upload.
Cleanup removes matching files only when it can locate them; it preserves unrelated replacements.
A symbolic link swap can leave directories or empty upload files outside the Volume. Later swaps
can leave partial uploads or complete hard-linked copies containing artifact bytes, even when
SuperTag rejects the upload. These checks do not isolate the Volume from concurrent malicious
writers; restrict write access to trusted hosts. See [artifact storage limits](artifacts.md).

Each artifact file is its own object at `attempts/<attemptId>/sha256/HEX` beneath the Volume's source.
The key names the producing Task Attempt and the file's SHA-256 digest. The catalog verifies that
Task Attempt's host before recording a copy. Downloads use only that Task Attempt's key. No Workspace
may mount the artifact Volume, or a Volume whose location overlaps it; see
[Store artifacts on a Volume](../guides/workers.md#3-store-artifacts-on-a-volume). Changing
`artifact-volume` restarts the host. A Worklet connected with `supertag connect worklet` names its
artifact Volume with `--artifact-volume` and `--artifact-volume-credential file:PATH`.

### Host environment

`environment` places workspace files and commands in remote sandboxes. For example, a laptop
can run Codex while its tests run in Modal. For `claude-code`, `cursor`, and `codex`, the harness,
model credentials, and native Session state stay on the Worker Host. Only workspace tools run
in the sandbox. Claude Code and Cursor bridge read, write, edit, glob, grep, ls, and foreground
commands. Codex runs app-server on the Worker Host and its exec-server in the sandbox for native
file and command tools. Provider keys never enter the sandbox's files, environment, or processes.

Codex selects app-server mode automatically. Host services have no `codex-execution-mode`
setting in `supertag.yaml`. An application that supplies explicit `exec` mode alongside a host
environment is refused at startup; select `app-server` or omit the mode. A host service with
`environment` refuses OpenCode at startup because its provider key would have to enter the
sandbox. Use Claude Code, Codex, or Cursor, or remove `environment` to run OpenCode locally. See
[Tool routing](worker.md#tool-routing).

The setting names one provider and, optionally, its settings:

```yaml
environment: e2b
environment: { e2b: { image: acme-node } }
environment: { modal: { app: supertag-workers, image: node:22-bookworm } }
```

| Provider | Setting | Meaning |
| --- | --- | --- |
| `e2b` | `image` | The E2B template sandboxes start from. Default: E2B's `base` template. |
| `modal` | `app` | Required. The Modal app that owns the sandboxes and images. SuperTag creates it when missing. |
| `modal` | `image` | The registry image or Modal image ID sandboxes start from. Default: `python:3.13-slim`. |

- `image` applies when a repository has no devcontainer. For Claude Code and Cursor, it must
  contain `python3`, a POSIX shell, and POSIX shell tools, plus any tools your commands need.
  Neither harness needs its agent executable installed in the sandbox. Codex needs the matching
  Codex CLI binary in the image to run `codex exec-server`; it does not run the agent loop there
  or need model credentials. OpenCode is refused. Image names hold no credentials: a scheme or a user
  name fails validation.
- A service with `environment` refuses `allow-unsandboxed-commands` at startup. Remove that
  setting; workspace commands run in the provider's sandbox.
- A **Permission Set**, a reusable selection of allowed actions, enables write and edit with
  `files:write`, and commands with `commands:execute`. For split Claude Code and Cursor,
  commands also require `files:write`; commands can change workspace files.
- See the [Claude Code](worker.md#claude-code) and
  [Cursor](worker.md#cursor-split-execution) tool limits before choosing a harness. Split mode
  disables their native workspace tools.
- Providers sign in with their own variables: `E2B_API_KEY`, or `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` or `~/.modal.toml`. Set them in the environment or an `env_file`. They stay
  in the host process; sandboxes, harness processes, and Task output never receive them.
- A host with `environment` serves Workspaces by `source` only, so `workspaces` is an error.
- Each sandbox lives at most the Task Attempt time limit plus ten minutes. The provider ends it
  then, even if the host stops.
- `supertag ps` shows the provider in TYPE, such as `host (e2b)`. Changing `environment` restarts
  the host.

### Host models

`models` lists what each harness on this host serves. A Task that names a model runs only on a host
that lists it, and a Task without one uses the first model listed. One host can serve several
models and efforts:

```yaml
services:
  laptop:
    type: host
    harnesses: [claude-code, codex, cursor]
    models:
      claude-code: [claude-opus-5-5, claude-sonnet-5-5]
      codex: gpt-6-sol
      cursor: [composer-2.5]
```

A single string still works and means a list of one. Without `models` for a harness, the host
advertises no model names, so it runs only Tasks that name none and uses the harness's own default.
See [execution settings](resource-model.md#execution-settings) for how a Tag chooses among them.

When the host service starts, `supertag up` checks each configured model once. Codex asks its
app-server for the models this account may use, and Claude Code asks its SDK for its model list;
Cursor also lists models through its SDK without sending a prompt. An unknown Cursor model is
refused with available IDs. Neither Codex nor Claude Code sends a prompt. A Codex model the
account does not offer stops the host with the
available models, for example `Codex does not offer gpt-6.1-sol for this account. Available models:
...`. Claude Code accepts more model IDs than it lists, so an unlisted Claude Code model only prints
a note.
When a check cannot run, such as before you log in, or for OpenCode, which has no cheap model list,
`supertag up` prints a note and starts the host anyway.

### Host concurrency

`concurrency` sets how many Task Attempts each harness Worker on the host runs at once, per
harness. By default it is floor(min(CPU cores, memory GB / 3) / 2), kept from 2 through 8: 6 on a
14-core, 36 GB laptop. `supertag ps` shows its source. Each Task Attempt in a
Workspace gets its own git worktree. See [Changing concurrency](#changing-concurrency) and
[Waiting for capacity](scheduling-and-recovery.md#waiting-for-capacity).

Each Task Attempt on a host service may run for 60 minutes.

The file never decides which Tags a host serves. Tag manifests do, through `spec.workerHosts`, or
`supertag update tag TAG --add-worker-host ID`. `supertag init` binds its host to the lead Tag.

### Local mount root

`local-mount-root` confines mount destinations on this Worker Host. For example, create
`/srv/supertag-mounts` and configure it before a Workspace copies a Volume to
`/srv/supertag-mounts/datasets`:

```yaml
services:
  laptop:
    type: host
    control-plane: https://supertag.example.com
    harnesses: [codex]
    local-mount-root: /srv/supertag-mounts
    volume-credentials:
      datasets: { path: /srv/datasets }
```

The root must exist when the host starts. Relative paths resolve from this
settings file; `~` names the host user's home directory. SuperTag resolves the root's symlinks
at startup. It refuses `/`, the home directory, and any ancestor of home as the root.
Choose a dedicated data directory, separate from repositories and tool configuration.
SuperTag compares the root and each destination ancestor with the home directory and its
ancestors by device and inode, so an alias of home itself is refused. It doesn't recognize an
alias of a folder inside home, such as a bind mount of `~/.config` placed under the root, so
don't mount home folders into the root. Destinations below dot directories in the root, such as
`project/.vscode` or `tools/.cargo`, are refused.

Every local mount destination must resolve at or below that root. SuperTag checks existing
ancestors before resolving the Workspace and again when copying. It compares names with Unicode
NFC normalization and folds case on case-insensitive filesystems. Directory identity checks keep
distinct normalized names from granting access. Replacing the root requires restarting the host.
A destination cannot be inside, equal to, or contain the SuperTag state directory, even when
`SUPERTAG_STATE_DIR` places it below `local-mount-root`. The check follows existing path aliases
and protects state directories that have not been created yet. Existing restrictions on other
protected directories, temporary directories, and mount overlaps still apply. Without `local-mount-root`, the host refuses every local mount and names the missing setting.
Remote sandbox destinations do not use this host root. Volume source consent still comes from
`volume-credentials`.

### Changing concurrency

`supertag up` applies a changed `concurrency` to a running host without a restart or a drain,
when nothing else about the host changed. Running Task Attempts continue:

- A higher limit lets queued Tasks start at once.
- A lower limit stops nothing. A harness starts new Task Attempts only once fewer than the new
  limit run on it.

`supertag up --dry-run` shows which applies:

```text
  raise concurrency of laptop from 2 to 6 without a restart; new Task Attempts can start at once
  lower concurrency of laptop from 6 to 2 without a restart; running Task Attempts finish, and a harness starts new ones only once fewer than 2 run on it (4 running now)
```

`supertag ps` shows the new value and its source once the host applies it. When two
`supertag up` commands change it at once, the host applies both in the order they ran, and the
later value stays. When another setting changes too, the host drains and restarts as usual.

### Unsandboxed harnesses

This section applies to host services without `environment`. Services with `environment`
refuse `allow-unsandboxed-commands` at startup; see [Host environment](#host-environment).

A Task granted `commands:execute` asks its harness to run shell commands, such as a test suite.
Codex runs them inside its own operating-system sandbox, which limits what they can write and
reach. Claude Code and OpenCode have no such sandbox on a host service. Cursor enables its sandbox,
but a Task can change its policy by writing `.cursor/sandbox.json` during the run. Treat their
commands as running with everything your account can read, write, and reach.

So a host runs such Tasks on Claude Code, Cursor, or OpenCode only when its service opts in:

```yaml
services:
  laptop:
    type: host
    harnesses: [claude-code, codex]
    allow-unsandboxed-commands: [claude-code]
```

Give the Tags such a host serves only trusted work. Listing `codex` is an error, because it needs no
opt-in. So is a harness the service does not run. `supertag config` and `supertag ps` show the
setting. `supertag init` explains the trade-off and asks, defaulting to yes; `supertag init --yes`
opts in for the harnesses it finds and prints how to undo it.

Without the opt-in, SuperTag places such a Task on another Worker that may run commands, such as
Codex on the same host. When no bound host has one, or the Tag's execution settings name
`claude-code`, the Task waits. `supertag describe task`, the
Objective's Runnable condition, and `supertag create objective` give the reason:

```text
Worker Host laptop runs claude-code without a sandbox; add claude-code to allow-unsandboxed-commands in its supertag.yaml service to let it run commands.
```

Add the harness and run `supertag up`; the host restarts and the Task runs. Tasks without
`commands:execute` are unaffected, including Tasks that only write files: the harness writes those
through its own file tools, inside the Task's worktree. `supertag connect worklet` takes
`--allow-unsandboxed-commands` for the same opt-in. See
[Harness-native tools](iam.md#harness-native-tools) for what each runtime action enables.

### Host MCP servers

An MCP server gives a Tag tools, such as Sentry's issue tools or Notion's page tools. `mcp`
lists the servers this machine provides. Each one is an HTTP server with a `url`, a `preset`
for a provider SuperTag knows, or a stdio server with a `command` that runs on this machine:

```yaml
services:
  laptop:
    type: host
    harnesses: [claude-code, codex]
    mcp:
      github: { preset: github }
      sentry: { url: https://mcp.sentry.dev/mcp, auth: { bearer: { env: SENTRY_TOKEN } } }
      notion: { url: https://mcp.notion.com/mcp, auth: { oauth: { refreshToken: { env: NOTION_MCP_REFRESH_TOKEN } } } }
      local-db: { command: [npx, -y, "@acme/db-mcp"], env: { DATABASE_URL: { env: ACME_DB_URL } } }
```

A Task uses a server's tools only when a Permission Set grants them, such as
`{ target: mcp, action: "sentry/get_issue_details" }`. The harness reaches the server only through
SuperTag's per-Task policy proxy. See [MCP server tools](iam.md#mcp-server-tools).

The host advertises each server as the [placement label](resource-model.md#worker-host-labels)
`mcp:NAME`, such as `mcp:sentry`. A Task whose grants name `sentry` runs only on bound hosts that
provide it, and so does a Tag whose `runsOn` lists `mcp:sentry`. When none does, `supertag describe
task` names the missing server. A Task without a Workspace, such as a conversation turn, needs only
granted servers that some bound host declares; see [MCP server placement](iam.md#placement). The `labels` key, `supertag connect worklet --label`, and Auth Keys
cannot declare `mcp:` labels; declare the server under `mcp` instead.

A server name is 1-59 lowercase letters, digits, hyphens, or underscores. Each server takes these
keys:

| Key | Meaning |
| --- | --- |
| `url` | The server's `http(s)` URL. It must not hold a user name, password, query string, or fragment. Set `url` or `preset`, not both. |
| `preset` | `github` (`https://api.githubcopilot.com/mcp/`), `slack` (`https://mcp.slack.com/mcp`), `linear` (`https://mcp.linear.app/mcp`), or `teams` (Microsoft's Agent 365 Teams server for `tenantId`). A preset always uses its official URL, because its resource mapping is written for that server. For another server, such as GitHub Enterprise Server, give its `url` without a preset. |
| `tenantId` | With `preset: teams` only, and required there: the Microsoft Entra tenant ID or domain |
| `type` | Optional; `http`, or `stdio` for a server with a `command` |
| `auth` | How SuperTag signs in to the server, in exactly one of the forms below |

A stdio server takes these keys instead:

| Key | Meaning |
| --- | --- |
| `command` | The executable and its arguments, such as `[npx, -y, "@acme/db-mcp"]`. A leading `~` expands to the home directory. Arguments must not hold `${VAR}`; pass credentials in `env`. |
| `preset` | `lark`, Lark's official `@larksuiteoapi/lark-mcp` server, which ships with SuperTag. Set `command` or `preset`, not both. Give the App credentials in `env` as `APP_ID` and `APP_SECRET`. |
| `env` | Variables the server process gets, each a reference: `{ env: VAR }`, `{ file: PATH }`, or `{ secretRef: NAME }`. A literal value fails validation. |

### stdio servers

The Worker, never the harness, starts a stdio server. When a Task Attempt starts, the Worker runs
the server briefly to list its tools. It starts it again when the harness first calls it, and
stops it when the Task Attempt ends. The harness reaches the server only through the per-Task
policy proxy, which checks grants, resource arguments, and approvals the same way it does for HTTP
servers.

The process gets a minimal environment plus the variables in `env`. The minimal environment is
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `LANG`, `LC_ALL`, and
`LC_CTYPE`. The process gets nothing else from the host service's environment, so it never
inherits credentials such as `GITHUB_TOKEN`, `SUPERTAG_AUTH_KEY`, or a model API key. The harness,
its shell, and its MCP configuration never see the command or `env`. A missing reference, or a
`command` that is not executable, stops the host before it takes Tasks. `supertag mcp list` shows
a stdio server as `stdio: EXECUTABLE`, without its arguments, and the state of its `env`
references.

A server under a host service's `mcp` is trusted, because the host operator wrote it. Its
references can name any variable, file, or secret. A server a Workspace selects from its
repository's `.mcp.json` is not. Its `${VAR}` references can name only variables that start with
`SUPERTAG_MCP_`, such as `${SUPERTAG_MCP_SENTRY_TOKEN}`. Set those in the host's environment or in
`~/.supertag/.env`. SuperTag reads that `.mcp.json`, and runs its stdio servers, from a snapshot
of the Task's base commit that the Worker owns. See
[Workspaces](../guides/workspaces.md#select-repository-mcp-servers).

### MCP server authentication

A server's `auth` never holds a credential. It names where one comes from, as a reference:

| Reference | Credential source |
| --- | --- |
| `{ env: VAR }` | The environment variable `VAR` on this host |
| `{ file: PATH }` | A file; a relative path resolves against this supertag.yaml, and `~` is your home directory |
| `{ secretRef: NAME }` | An entry in this file's [`secrets`](#secrets) |

| Form | Example | What the proxy sends |
| --- | --- | --- |
| `bearer` | `auth: { bearer: { env: SENTRY_TOKEN } }` | `Authorization: Bearer` with the value |
| `headers` | `auth: { headers: { X-Api-Key: { env: INTERNAL_MCP_KEY } } }` | Each header with its value |
| `githubApp` | `auth: { githubApp: { appId: 123456, installationId: 7890123, privateKey: { file: ~/keys/app.pem } } }` | A new installation token for each Task Attempt, from GitHub's App API |
| `clientCredentials` | `auth: { clientCredentials: { clientId: { env: ACME_ID }, assertionKey: { file: ~/keys/acme.pem } } }`, with exactly one of `clientSecret` or `assertionKey`, and optional `scope` and `tokenUrl` | A new access token for each Task Attempt, from the MCP client-credentials grant |
| `helper` | `auth: { helper: [/opt/bin/mcp-token, vendor] }`, a command and its arguments | The headers the command prints, run for each Task Attempt |
| `oauth` login | `auth: { oauth: true }` | An access token from `supertag mcp login NAME` on this host, refreshed by SuperTag |
| `oauth` refresh token | `auth: { oauth: { refreshToken: { env: NOTION_MCP_REFRESH_TOKEN } } }`, with an optional `tokenUrl` | An access token from the refresh token, reused until it expires |

`auth: { oauth: true }` is an interactive login for local deployments. Run
`supertag mcp login NAME` once on the host; see [MCP OAuth login](#mcp-oauth-login).

The Worker's per-Task policy proxy adds these headers to its own requests to the server. The
harness, its shell, its MCP configuration, and Task records never see them.

When the server answers 401 or 403, the proxy fetches the credential again and retries the
request once. A second refusal fails the call.

Before a host takes Tasks, `supertag up` checks every server's credentials. Each variable is set,
each file is readable, each private key parses, and each helper is executable. A missing one
stops the host with a message that names the server and the reference, never a value.

- `githubApp` signs a short-lived App JWT with the private key, then asks
  `https://api.github.com/app/installations/ID/access_tokens` for a token.
- `clientCredentials` authenticates with `clientSecret` as HTTP Basic, or with `assertionKey` as
  a signed JWT client assertion. It names the server's URL as the token's `resource`.
- `helper` must print one JSON object of header names to string values, such as
  `{"Authorization": "Bearer ..."}`, within 15 seconds. A helper from this file runs with the
  host's environment. A helper a repository declares runs without credential-like variables,
  such as `*_TOKEN`, `*_SECRET`, `*_API_KEY`, and `SUPERTAG_*`. It also runs without connection
  strings, such as `DATABASE_URL`, `MONGO_URL`, `REDIS_URL`, and `*_DSN`, and without any variable
  whose value is a URL with a user name or password.
- `oauth.refreshToken` holds the refresh token. It may also hold a JSON object with
  `refresh_token`, an optional `client_id`, and an optional `client_secret`, such as the value
  `supertag mcp login NAME --export` prints. A rotated refresh token replaces the old one until
  the host stops.

### MCP credentials on a Rust deployment

On a Rust deployment, a Worker Host reads its MCP servers from an owner-only JSON catalog that
`--mcp-catalog PATH` names, not from `mcp` in this file. See `--mcp-catalog` in the
[Rust CLI reference](../../rust/docs/cli-reference.md). Each credential field there names a
Worker Host variable, such as `headerEnv`, `clientSecretEnv`, or `privateKeyEnv`. Or it names a
file through the matching `File` field, such as `headerFile`, `clientSecretFile`, or
`privateKeyFile`. A stdio server's `env` value is a variable name or `{"file": PATH}`. File
references differ from the ones above:

- The path is absolute or starts with `~/`. The catalog has no directory for a relative path.
- The file must be a regular file you own, not a symbolic link, with no group or other
  permissions, such as mode `0600`. Only a private key or a refresh token's JSON may span lines.
- The Worker Host reads each file when it starts, and again for each Task Attempt and each
  refetch after a 401 or 403. A replaced file takes effect without a restart.
- `{ secretRef: NAME }` is not supported, because the catalog has no `secrets` map.

### MCP OAuth login

`supertag mcp login NAME` runs the MCP authorization flow in a browser on this machine. It uses
the OAuth authorization code flow with PKCE (S256) and a loopback redirect to
`http://127.0.0.1:PORT/callback`. It registers a client with the server's authorization server
through dynamic client registration (RFC 7591). The command prints the authorization URL and tries
to open the browser.

The server must be declared with `auth: { oauth: true }` in a host service in
`~/.supertag/supertag.yaml`. The command stores the tokens in this host's credential store,
`~/.supertag/credentials.json`, or under `$SUPERTAG_STATE_DIR` when it is set. The per-Task policy
proxy uses the stored access token. It refreshes the token when it expires, or on a 401 or 403,
and then retries once. The harness and its shell never see the tokens.

SuperTag finds the authorization server from the server's OAuth protected resource metadata and
authorization server metadata. The token endpoint must be on the MCP server's own origin. The
login records that endpoint, and refreshes go only there. Token, refresh, and registration
requests never follow redirects. Login fails with a message saying so when the authorization
server issues no refresh token or offers no dynamic client registration.

`supertag mcp login NAME --export` runs the same browser login but stores nothing. It prints a
JSON value once, `{"refresh_token":"…","client_id":"…"}`, plus `client_secret` when registration
issued one. Store that value as a secret on a remote host and reference it with
`auth: { oauth: { refreshToken: { env: NOTION_MCP_REFRESH_TOKEN } } }`. With `--export`, the
local supertag.yaml must declare the server with `oauth: true` or `oauth: { refreshToken }`.

`supertag up` refuses to start a host service whose `oauth: true` server was never logged in on
this host. The message offers both ways forward: run `supertag mcp login NAME`, or run
`supertag mcp login NAME --export` on a machine with a browser and use
`auth: { oauth: { refreshToken: { env: VAR } } }`.

When the token endpoint refuses a refresh with HTTP 400 or 401, SuperTag marks the login lapsed in
the credential store. The host then advertises the placement label `mcp-login:NAME` instead of
`mcp:NAME`. A connected host sends the changed labels with its next heartbeat, without
reconnecting. Tasks whose granted tools need the server stay queued;
they do not fail. `supertag describe objective` explains the hold, `supertag describe task` shows
`Waiting: MCP server NAME needs a login on its Worker Host`, and the operator inbox shows an
`mcp_login` item. SuperTag creates no manager follow-up Task for this hold. After a new login,
the host advertises `mcp:NAME` again with its next heartbeat and the Task runs. The `labels` key, Tag `runsOn`, and Auth Key labels cannot declare `mcp-login:` labels.

`supertag mcp list` shows one row per host service MCP server, with these columns:

| Column | Meaning |
| --- | --- |
| `SERVICE`, `SERVER`, `URL` | The host service, the server name, and its URL |
| `AUTH` | `none`, `bearer`, `headers`, `githubApp`, `clientCredentials`, `helper`, `oauth login`, or `oauth refresh token` |
| `STATE` | For `oauth login`: `logged in`, `login lapsed; run supertag mcp login NAME`, or `not logged in; run supertag mcp login NAME`. `logged in` adds `, expires ISO` when the refresh token has a known expiry. For other forms: `ready`, or `missing: …` naming the env var or file. |

The list never prints a credential, and `missing:` names the reference, never its value.

### MCP token endpoints

`clientCredentials` and `oauth` send a secret to a token endpoint, so SuperTag picks that endpoint
carefully. Without `tokenUrl`, it reads the endpoint from the server's OAuth metadata. It uses that
endpoint only when it is on the MCP server's own origin. An authorization server elsewhere must be
named in `tokenUrl`, an `https` URL or a loopback `http` URL:

```yaml
partner: { url: https://mcp.partner.dev/mcp, auth: { clientCredentials: { clientId: supertag, clientSecret: { env: PARTNER_SECRET }, tokenUrl: https://login.partner-idp.dev/oauth/token } } }
```

Without `tokenUrl`, a token endpoint on another origin fails the Task Attempt. The message does
not repeat the advertised URL. Token requests never follow redirects; a redirect fails the
request too. When listing a server's tools fails, the Task sees only the server name and the HTTP
status, never the server's response.

A literal value where a reference belongs, such as `bearer: ghp_...`, fails validation. The error
never repeats the value. `supertag config` shows each server with its URL and auth references.
It masks interpolated MCP values and helper commands and arguments.

A stdio server has no `auth` and no login; its credentials are its `env` references.

### Keeping the machine awake

A laptop that sleeps in the middle of a Task Attempt stops the harness and can lose the work. So
while a host service runs at least one Task Attempt, it keeps the machine from idle sleep. It lets
go when the last Task Attempt finishes.

| Platform | How the host keeps the machine awake |
| --- | --- |
| macOS | Runs `caffeinate -i`, which holds a prevent-idle-sleep power assertion. |
| Linux | Runs `systemd-inhibit --what=idle:sleep`. |
| Other | Does nothing. |

The command also ends when the host process exits, so a crashed host leaves no hold behind. It
does not stop sleep you ask for, such as closing a laptop lid. If the command is missing, the host
prints a note once and runs Task Attempts anyway. If the command exits on its own while Task
Attempts run, the host starts it again, up to 3 times. `supertag ps` shows the hold while it lasts:

```text
studio  host  running  http://127.0.0.1:3434  41907 in the background
  Worker Host studio; connected; Tags lead; Task Attempts running: 1; keeping the machine awake (caffeinate -i) since 2026-10-02T16:20:00.000Z
```

On a laptop, `supertag ps` also warns while Task Attempts run if the laptop is on battery power or
would sleep when its lid closes:

```text
  warning: Task Attempts are running, but the laptop is on battery power and closing the lid will sleep it. A long sleep can fail them; plug in and keep the lid open.
```

| Platform | On battery | Sleeps on lid close |
| --- | --- | --- |
| macOS | `pmset -g batt` reports `Battery Power`. | Always, unless `pmset disablesleep 1` is set. |
| Linux | A battery and no online mains supply in `/sys/class/power_supply`. | Unless `HandleLidSwitch` in `/etc/systemd/logind.conf` is `ignore` or `lock`. |

A machine without a battery gets no warning. If the Control Plane runs on the laptop and sleeps,
running Task Attempts get a short grace to renew their leases when it wakes. See
[When the Control Plane sleeps](scheduling-and-recovery.md#when-the-control-plane-sleeps).

### Secrets

```yaml
secrets:
  db-password: { environment: PGPASSWORD }
  laptop-key: { file: ~/laptop.key }
```

A secret comes from an `environment` variable or a `file`. A relative file path starts from this
file. An `environment` secret reads the process environment first, then `env_file`. A key that
takes a secret, such as `database.password` or `auth-key`, takes the secret's name.

SuperTag reads secret values when a service starts. It never writes them to `supertag.yaml`, logs,
`supertag config` output, or service unit files.

### Interpolation

Any string value may use these forms:

| Form | Becomes |
| --- | --- |
| `${VAR}` | The value of `VAR`. Unset is an error. |
| `${VAR:-default}` | The value of `VAR`, or `default` when it is unset or empty |
| `${VAR:?message}` | The value of `VAR`, or an error with `message` |
| `$$` | A literal `$` |

Values come from the process environment first, then `env_file`. Unlike Compose, an unset
`${VAR}` without a default is an error, so an empty database URL fails at once instead of later.
Keys that start with `x-` are not interpolated.

### On a Rust deployment

The Rust CLI's `supertag up -f supertag.yaml` reads `env_file` and interpolates values as described
above. It differs in these ways:

- Each `env_file` must be a regular file owned by you and not writable by group or others. A
  symbolic link is an error, including the default `.env`. Together the files may hold at most
  1 MiB and 1,024 variables.
- `env_file` supplies interpolation, `environment` secrets such as `auth-key`, harness provider
  credentials, and the Control Plane's `SUPERTAG_GITHUB_*` settings. It does not supply other
  `SUPERTAG_*` overrides or the `SUPERTAG_SERVER_CA_FILE`, `SUPERTAG_CLIENT_CERT_FILE`, and
  `SUPERTAG_CLIENT_KEY_FILE` paths, and never `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, or the
  locale variables, which decide where a harness finds its sign-in. Set those in the process
  environment.
- For credentials, a blank process value counts as unset, so `env_file` fills it. Interpolation
  still uses a set but empty process value.
- Error messages name the variable, never its value.
- A host service's `attempt-timeout-seconds`, from 1 through 86400, sets how long each Task
  Attempt may run; it defaults to 3600, the same 60 minutes. A host whose Workspace files live in
  an E2B or Modal sandbox accepts at most 3600, the longest sandbox those providers grant, and
  stops the harness early enough to leave the sandbox 3 minutes for capture and cleanup.
- A Workspace's `setup` command belongs to the host's checkout:
  `workspaces: { app: { path: ~/code/app, setup: npm ci } }`. It works as described in
  [Prepare each worktree with setup](../guides/workspaces.md#prepare-each-worktree-with-setup),
  with these differences: setup gets `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, and the locale
  variables, and no provider credentials; it runs again in each Task Attempt's new checkout, so
  a retried Attempt reinstalls its dependencies; a host with an `environment` sandbox refuses it;
  and a failed Task's result starts with `Workspace setup failed` instead of recording
  `failureKind`.
- A host restarted after it was killed checks the processes it recorded for an interrupted Task
  Attempt. When all of them are gone, it records the Task Attempt as failed with an unknown
  outcome, never runs it again, and takes new work. Otherwise, and always for an Attempt that
  used an E2B or Modal sandbox or shared execution (as in TypeScript, the record proves only
  processes on the host), it waits until you record a decision with the Rust CLI's
  `task resolve-attempt` command (`--decision failed|retry --confirmed-stopped`; see the
  [Rust CLI reference](../../rust/docs/cli-reference.md)). The Rust CLI has no
  `supertag recover worklet`.

Each service process starts with an empty environment. It gets `PATH`, `HOME`, `USER`, `LOGNAME`,
`TMPDIR`, `LANG`, `LC_ALL`, and `LC_CTYPE` from the shell, plus what its role needs:

| Process | Also receives |
| --- | --- |
| Control Plane | Its database URL, the service token, and the operator token. It gets `SUPERTAG_GITHUB_*` only when a host serves a GitHub Workspace from the Control Plane. |
| Gateway | The service token, plus each connected surface's settings. It holds no operator token. It runs only when the file connects a surface or names a `notify` destination. |
| Worker Host | The provider credentials for its harness only, such as `CODEX_API_KEY`, `OPENAI_API_KEY`, and `CODEX_HOME` for `codex`, or `CURSOR_API_KEY` for `cursor`. Every host also gets the TLS file paths set in the shell. |

A Worker Host never receives a service token or another harness's credential. Its harness
processes get `PATH`, `LANG`, those provider credentials, and private working paths. The
Control Plane and Gateway never receive provider credentials.

### Several files

`-f PATH` names a file, or a directory that holds `supertag.yaml`. Repeat it to merge files in
order. A later file merges over an earlier one: maps merge by key, lists replace, and `null`
removes a key. There is no automatic override file.

```sh
supertag up -f supertag.yaml -f staging.yaml
```

### Precedence

Values come from four places. Each wins over the ones after it:

1. Flags on the command.
2. Environment variables: the process environment first, then `env_file`.
3. The files, in `-f` order.
4. Defaults.

`supertag config` marks each value an environment variable supplied with a `# from VAR` comment.
[Environment and supertag.yaml](../operations/control-plane.md#environment-and-supertagyaml) maps
each `SUPERTAG_*` variable to its key.

## Provision resources

`provision` creates resources a Control Plane should start with. It lists manifest files or
directories, relative to this file, and inline manifests in the
[resource manifest format](../operations/resources.md):

```yaml
services:
  control-plane:
    type: control-plane
    provision:
      - ~/acme/org.yaml
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec: { roles: [Lead] }
```

On every `supertag up`, including `--foreground`, SuperTag waits for the Control Plane to become
healthy, then creates each listed resource that is missing. It never changes or deletes one that
exists; change those with `supertag apply -f`. A resource you add to the list later appears on the
next `supertag up`. If provisioning fails, `up` reports the error and stops a foreground Control
Plane. In a multi-service foreground run, provisioning finishes before dependent hosts start.

To provision, `supertag up` authenticates with the first of these that is set:
`SUPERTAG_OPERATOR_TOKEN` or `SUPERTAG_ADMIN_TOKEN` in its environment, `SUPERTAG_ADMIN_TOKEN` in
`env_file`, then this machine's local operator credential. That matches the admin token the
Control Plane reads, so an admin token kept only in `~/.supertag/.env` works for both.

Provisioned resources belong to the apply set `provision`. To move to full reconciliation, run
`supertag apply -f DIRECTORY --set provision --prune` with the same manifests.

A host service in the same file as its Control Plane also creates its missing Workspaces. Each one
gets defaults from its checkout: the origin as source, the default branch as ref, and branch
delivery.

### Provision Surface Accounts

A provisioned [Surface Account](../operations/resources.md#declare-surface-accounts) manifest
can take its secrets from this file. `{ secretRef: NAME }` names an entry in `secrets:`, and
`provision` reads its value from there:

```yaml
services:
  control-plane:
    type: control-plane
    provision:
      - apiVersion: supertag/v1
        kind: SurfaceAccount
        metadata:
          name: acme-slack
        spec:
          provider: slack
          configuration:
            transport: socket
          secrets:
            botToken: { secretRef: slack-bot-token }
            appToken: { secretRef: slack-app-token }
secrets:
  slack-bot-token: { environment: SLACK_BOT_TOKEN }
  slack-app-token: { file: ~/secrets/slack-app-token }
```

A Surface Account that exists keeps its stored credentials. `supertag apply -f` refuses
`secretRef`, so manifests you apply by hand use `env` or `file` references.

## Service units

`restart: unless-stopped` makes `supertag up` install a per-user service unit. The unit starts the
service when you log in and restarts it when it fails. Switching back to `restart: no` removes the
unit on the next `supertag up`. `supertag down` stops units until the next login, and
`supertag down --remove-services` uninstalls them.

| System | Unit |
| --- | --- |
| macOS (launchd) | `~/Library/LaunchAgents/ai.supertag.SERVICE.plist`, label `ai.supertag.SERVICE` |
| Linux (systemd) | `~/.config/systemd/user/supertag-SERVICE.service` |

With the default `name`, the Control Plane unit is `ai.supertag.control-plane`. A file that sets
`name` puts it before the service: `ai.supertag.NAME.SERVICE` and `supertag-NAME-SERVICE.service`.
On Linux, run `loginctl enable-linger $USER` once to keep units running while you are logged out.
Units are not supported on Windows.

### Environment under a unit

A unit runs `supertag up --foreground SERVICE`. It does not inherit your shell's environment.
`supertag up` decides the unit's environment when it installs or updates the unit:

| Variable | In the unit |
| --- | --- |
| `PATH`, `HOME`, `SUPERTAG_STATE_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` | Copied from the shell |
| `SUPERTAG_*` overrides that hold no secret, such as `SUPERTAG_GATEWAY_PORT` | Copied from the shell |
| `SUPERTAG_DATABASE_URL` with a password in it | Never copied |
| Secrets, `SUPERTAG_ADMIN_TOKEN`, `VAULT_TOKEN`, and variables for `${VAR}` | Never copied |

A unit reads what is not copied from `~/.supertag/.env`, which `env_file` loads by default, or from
secret files. SuperTag never writes a secret value into a unit file.

`supertag up` resolves a unit's service the way the unit will: from the copied variables,
`env_file`, the files, and the defaults. It compares that with the settings the running service
recorded when it started. A value only your shell holds therefore never restarts a unit's service.
Instead, `up` prints one warning that names the variables:

```text
Warning: the service unit for control-plane does not inherit this shell's environment, so it cannot see SUPERTAG_DATABASE_URL. Put them in ~/.supertag/.env (env_file) or a secret file, or unset them in this shell. supertag up does not restart the service for them.
```

Move each named variable to `~/.supertag/.env`, or unset it. A copied override changes the unit,
so running `supertag up` with a different value, or without it, updates the unit and restarts the
service.

## In containers and hosting platforms

The SuperTag container image starts the Control Plane with `supertag up --foreground control-plane`.
Docker Compose and the Railway and Fly.io templates run that command. (Render, Modal, and
Cloudflare run the native services from the `hosted` image, configured only by environment
variables; they do not read this file.) It reads `/var/lib/supertag/supertag.yaml` when the file exists, and the defaults
otherwise. Environment variables stay the main configuration and override the file, so a
deployment configured only by environment variables needs no file.

A file suits settings you want reviewed in one place, such as `notify`, `logging`,
`operators.file`, or `provision`. To supply one, mount it at `/var/lib/supertag/supertag.yaml`, or
bake it into your image at another path and add `-f PATH` to the start command. A platform volume at
`/var/lib/supertag` hides anything the image puts there. Each
[deployment guide](../guides/self-hosting.md#1-choose-a-deployment) shows the way that fits its
platform.

Some keys behave differently in a container:

| Key or setting | In a container |
| --- | --- |
| `ports` | The image sets `SUPERTAG_GATEWAY_HOST=0.0.0.0`, which overrides the address. On a hosting platform, the platform's `PORT` sets the port unless `SUPERTAG_GATEWAY_PORT` does. Leave `ports` out. |
| `restart` | Ignored. `--foreground` never installs a service unit; Compose or the platform restarts the container. |
| `provision` | Applied after the Control Plane becomes healthy. Missing resources are created; existing resources are left alone. A provisioning failure stops the foreground process. |
| `database.url` | A hosting platform checks `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` in the environment, so keep them there. |
| Admin token | Read from `SUPERTAG_ADMIN_TOKEN`. Without it, the Control Plane generates a local operator credential in the state directory. |
| Migrations | With `SUPERTAG_DEPLOYMENT_PLATFORM` set, the Control Plane never migrates at startup; the platform's release step does, and a schema that is not current stops startup. Elsewhere, pending ordinary migrations apply at startup. |

The Control Plane writes its log to standard output, where the platform collects it, and stops
cleanly on `SIGTERM`. `supertag ps` and `supertag logs` describe services on the machine they run
on, so use the platform's own tools for a container.

## Where things live

All local state lives in `~/.supertag/`, or the directory `SUPERTAG_STATE_DIR` names:

```text
supertag.yaml          the services file
.env                   optional; loaded by the env_file default; can hold SUPERTAG_MCP_* values
supertag.db            the local Control Plane's default SQLite database
credentials.json       credential vault: local operator credential, MCP logins, surface secrets
control-plane/         pid, status.json, logs/control-plane.log
hosts/SERVICE/         credential.json, pid, status.json, logs/host.log, attempt-journal/
worker-hosts/          credentials of hosts started with supertag connect worklet
control-planes.json    saved Control Plane connections
workers/, workspaces/, artifacts/
```

`hosts/SERVICE/credential.json` holds the host's Worker Host credential and ID. Renaming the
machine therefore creates no new Worker Host. A log over 10 MB moves to `NAME.log.1` when its
process starts. See [Credential storage](credential-storage.md) for how each credential is used.

## Credentials

The local Control Plane accepts this machine's local operator credential, a random token generated
once and stored in `credentials.json`. Commands use it when no other Control Plane is selected:
`--control-plane NAME`, `SUPERTAG_CONTROL_PLANE`, and `supertag connect control-plane URL` choose
another, and `SUPERTAG_OPERATOR_TOKEN` or `SUPERTAG_ADMIN_TOKEN` replaces the token.

A host service never connects with the operator credential. The operator credential only enrolls
it, and the host connects with its own Worker Host credential. Neither credential is printed or
logged. If an operator revokes the host, delete `hosts/SERVICE/credential.json`. The next
`supertag up` enrolls a local host again; a host of a shared Control Plane needs a new Auth Key.

## Schema

[`spec/supertag-yaml.schema.json`](../../spec/supertag-yaml.schema.json) is the JSON Schema for
`supertag.yaml`. To get completion and checks in an editor that supports JSON Schema, point it at
your local copy of that file.
