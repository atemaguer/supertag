# supertag.yaml and local state

`supertag.yaml` lists the services that run SuperTag on one machine, much like a compose file.
`supertag up` reads it and brings those services up. There are two service types:

- A **`control-plane` service** runs a local **Control Plane**, the SuperTag service that stores
  your [organization](glossary.md#autonomous-organization) and schedules its work. A file has at
  most one. `supertag up` runs a local **Gateway** beside it, for collaboration surfaces and
  operator notifications.
- A **`host` service** connects this machine as a **Worker Host**, a computer that runs
  [Tasks](glossary.md#task) for Tags, the persistent AI actors with their own responsibilities
  and permissions. A file can have any number.

The file declares how SuperTag runs on this machine, not what your organization contains:

| To change | Use |
| --- | --- |
| The local Control Plane, Gateway, and this machine's Worker Hosts | `supertag.yaml`, then `supertag up` |
| Tags, Roles, Permission Sets, Context Sets, Teams, and Objectives | Manifests and `supertag apply -f` ([Manage Control Plane resources](../operations/resources.md)) |
| A shared Control Plane on a server or hosting platform | `supertag setup deployment` ([Self-host SuperTag](../guides/self-hosting.md)) |
| Operator access and joining keys | `supertag operator-token create NAME` and `supertag auth-key create NAME --role host` |

The file lives at `~/.supertag/supertag.yaml`, or in the directory `SUPERTAG_STATE_DIR` names.
`supertag init` writes it, and `-f PATH` (or `--state-directory DIR`) reads another. Without a
file, `supertag up` runs a `control-plane` service with the defaults. Nothing is written to your
repositories.

## Examples

### On your own

`supertag init` writes a file like this. The host service is named after the machine:

```yaml
version: 1
name: supertag
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:3434"]
    provision:
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec: { roles: [Lead], execution: { harness: codex } }
  studio:
    type: host
    harnesses: [codex]
    workspaces:
      app: /Users/you/code/app
```

`supertag up` starts the Control Plane and the Gateway, then the host, which joins on its own.

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

## Commands

| Command | Does |
| --- | --- |
| `supertag up` | Brings up every service. Restarts only changed services, after their running Task Attempts finish unless `--force` |
| `supertag up --foreground` | Runs the services in this terminal until interrupted |
| `supertag down` | Drains hosts, waits for running Task Attempts, and stops every service; `--force` does not wait |
| `supertag ps` | Lists services and their state |
| `supertag logs -f` | Follows service logs: `supervisor`, `control-plane`, `gateway`, or a host |
| `supertag config` | Prints the resolved file, or every problem in it; `--services` lists service names |

## File format

### Top level

| Key | Meaning |
| --- | --- |
| `version` | Optional. `1`, the only format. |
| `name` | Instance name, default `supertag`. Labels service units. |
| `services` | Service name to service. Names use lowercase letters, digits, `-`, and `_`, up to 63 characters. `gateway` and `supervisor` are reserved. |
| `secrets` | Secret name to source. Services refer to secrets by name. See [Secrets](#secrets). |
| `surfaces` | Surface Accounts the local Gateway serves. `supertag setup surface` and `supertag tag update` write it; see [Connect a collaboration surface](../surfaces/README.md). |
| `env_file` | A file, or a list of files, of `KEY=value` lines for interpolation, `environment` secrets, and provider credentials. The process environment wins over it. Default: `.env` beside this file, when present. |
| `x-*` | Ignored. Use these keys for YAML anchors. |

An unknown key is an error. `supertag up` and `supertag config` report the problem without
echoing secret values.

### control-plane service

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | required | `control-plane` |
| `ports` | `["127.0.0.1:3434"]` | One entry, `"PORT"` or `"IP:PORT"`. The local listener must be loopback |
| `url` | `http://LISTENER` | Must match the listener when set |
| `database.url` | SQLite at `~/.supertag/runtime.sqlite3` | `postgresql://USER@HOST:PORT/DATABASE` without a password. `SUPERTAG_DATABASE_URL` also selects PostgreSQL |
| `database.password` | none | A secret name. It becomes `PGPASSWORD` for the Control Plane |
| `credentials` | `file` | The credential vault. The local supervisor supports `file` only |
| `notify` | `desktop` | One destination or a list: `desktop`, `webhook:https://HOST/PATH[#SECRET_NAME]`, or `slack:CHANNEL_OR_USER` (optionally `slack:WORKSPACE/CHANNEL_OR_USER`). A webhook's secret name must exist under `secrets:`. See [Set up operator notifications](../guides/notifications.md) |
| `logging.audit` | off | Also write each audit entry as one JSON line to `stderr` or an absolute file path. The database keeps every entry either way. See [Audit log](../operations/control-plane.md#audit-log) |
| `provision` | none | Manifests to create when missing. See [Provision resources](#provision-resources) |
| `restart` | `no` | `unless-stopped` installs a service unit. See [Service units](#service-units) |

### host service

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | required | `host` |
| `control-plane` | the file's `control-plane` service | A shared Control Plane's `https://` or `wss://` URL |
| `auth-key` | none | A secret name holding a host [Auth Key](resource-model.md#auth-keys). Only with a URL `control-plane`. Without it, `SUPERTAG_AUTH_KEY` |
| `harnesses` | required, unless `adapter` | Up to five of `codex`, `claude-code`, `cursor`, `opencode`, and `openai-agents` |
| `adapter`, `adapter-args` | none | An executable that speaks the harness protocol, in place of `harnesses`. See [Write a harness adapter](../guides/harness-adapters.md) |
| `models` | none | Models per harness: one model, or a list whose first is the default. See [Host models](#host-models) |
| `workspaces` | none | Workspace name to a repository path, or `{ path, delivery, setup }`. See [Workspaces](#workspaces) |
| `skills` | none | Local Skill directory or JSON catalog file selected by Context Sets. Relative paths resolve from this file |
| `labels` | none | Placement labels the host carries, such as `[gpu]`, for a Tag's `runsOn`. See [Worker Host labels](resource-model.md#worker-host-labels) |
| `allow-unsandboxed-commands` | none | `claude-code`, `cursor`, or `opencode` from `harnesses`. See [Unsandboxed harnesses](#unsandboxed-harnesses) |
| `concurrency` | `1` | Task Attempts each harness runs at once, from 1 through 16. See [Host concurrency](#host-concurrency) |
| `attempt-timeout-seconds` | `3600` | Seconds a Task Attempt may run, from 1 through 86400 |
| `depends_on` | none | Service names to bring up first |
| `restart` | `no` | `unless-stopped` installs a service unit |

### Host enrollment

A host in the same file as its Control Plane joins on its own, with this machine's local operator
credential, and may run every Tag. A host of a shared Control Plane joins with its `auth-key` on
its first `supertag up` and may run the Tags its key names. A missing or rejected key fails on the
terminal. After joining, the host uses its stored credential.

### Host models

```yaml
    harnesses: [codex, opencode]
    models:
      codex: [gpt-5.5, gpt-5.5-mini]
      opencode: anthropic/claude-sonnet-4-5
```

The first model is the default for Tasks that name none. A Task that names a model runs only on a
host that lists it. OpenCode requires a `provider/model`.

### Host labels

```yaml
    harnesses: [codex]
    labels: [gpu, team:infra]
```

The host reports these labels when it connects, in addition to its automatic ones. `supertag up`
checks them before starting any service: each must be a valid label, outside the reserved
`mcp:`, `mcp-login:`, `volume-credential:`, and `artifact-volume:` prefixes, and a host takes at
most 64. Changing a host's labels restarts that host on the next `supertag up`.

### Host concurrency

`concurrency` is per harness: `harnesses: [codex, claude-code]` with `concurrency: 2` runs up to
two Codex and two Claude Code Task Attempts at once. When only `concurrency` changes,
`supertag up` changes the running host without restarting it.

### Unsandboxed harnesses

Codex runs commands in its own sandbox. Claude Code, Cursor, and OpenCode have none that SuperTag
can enforce, so a host does not run their Tasks that may run commands (`commands:execute`) unless
the harness is listed in `allow-unsandboxed-commands`; such a Task waits for a host that allows
it. Commands then run as your user, with your files, network, and the environment the harness
receives, which may include its provider key. Cursor also needs `files:write` to run commands.

```yaml
    harnesses: [codex, claude-code]
    allow-unsandboxed-commands: [claude-code]
```

A host started without supertag.yaml takes the same opt-in with `supertag worker-host
--allow-unsandboxed-commands`.

### Workspaces

```yaml
    workspaces:
      app: ~/code/app
      api: { path: ~/code/api, delivery: patch, setup: npm ci }
```

Each Task Attempt runs in its own checkout of the repository, pinned to an exact commit. `setup`
runs in each new checkout before the harness starts, on the host and outside any harness sandbox,
with a 10-minute limit. With `delivery: branch`, the default, `supertag up` imports each delivered
Task into the repository as the branch `supertag/session/SESSION`. With `delivery: patch`, the
repository is left alone, and the patch and bundle stay downloadable with `supertag task
download`.

## Secrets

```yaml
secrets:
  db-password: { environment: PGPASSWORD }
  laptop-key: { file: ~/laptop.key }
```

A secret is read from a variable in the environment or `env_file`, or from an owner-only file. A
service refers to it by name. SuperTag never writes a secret value into this file, a service
unit, or a log.

### Interpolation

`${VAR}` in a value is replaced from the environment or `env_file`. `supertag config` shows the
resolved file with secrets still as references.

## Provision resources

`provision` creates resources the local Control Plane should start with. It lists manifest files
or directories, relative to this file, and inline manifests in the
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

On every `supertag up`, SuperTag waits for the Control Plane to become healthy, then creates each
listed resource that is missing. It never changes or deletes one that exists; change those with
`supertag apply -f`. Provisioned resources belong to the apply set `provision`.

## Service units

`restart: unless-stopped` makes `supertag up` install a per-user service unit, launchd on macOS
and systemd on Linux. The unit runs the supervisor and starts it again after a failure or a
login. `supertag down` stops it; `supertag down --remove-services` uninstalls it. On Linux, run
`loginctl enable-linger $USER` once to keep it running while you are logged out.

A unit does not inherit your shell's environment. Put provider keys and other variables it needs
in `~/.supertag/.env` or a secret file. When your shell holds a variable the unit cannot see,
`supertag up` prints a warning naming it instead of restarting the service.

## Where things live

All local state lives in `~/.supertag/`, or the directory `SUPERTAG_STATE_DIR` names:

```text
supertag.yaml          the services file
.env                   optional; loaded by the env_file default
runtime.sqlite3        the local Control Plane's SQLite database
credentials.json       the file credential vault: the local operator credential and surface secrets
checkpoints/           the transfer directory: Session checkpoints, bundles, artifact files
logs/                  supervisor, control-plane, gateway, and hosts/ logs
```

Each host service keeps its credential, execution journal, captured artifacts, and checkouts in
its own state directory beneath this one. See [Credential storage](credential-storage.md).

## Credentials

The local Control Plane accepts this machine's local operator credential, a random token stored
in `credentials.json`. Operator commands that name no other Control Plane use it. A host
service never connects with it: it only enrolls the host, which then connects with its own
credential. Neither credential is printed or logged.
