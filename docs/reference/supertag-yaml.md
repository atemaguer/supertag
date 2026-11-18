# supertag.yaml and local state

`supertag.yaml` lists the services that run SuperTag on one machine, much like a compose file.
`supertag up` reads it and brings those services up. There are two service types:

- A **`control-plane` service** runs a local **Control Plane**, the SuperTag service that stores
  your [organization](glossary.md#autonomous-organization) and schedules its work. A file has at
  most one. `supertag up` always runs a local **Gateway** beside it: the service the CLI, the
  terminal UI, and the desktop app connect to, which also carries collaboration surfaces and
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

`supertag init` writes a file like this for the repository you run it in. It provisions a
`local-tools` Permission Set, a `Lead` Role, and the Control Plane's lead Tag, which follows the
current branch. For a Codex lead, `local-tools` also grants `web:fetch`, because current Codex
models run commands only in Codex code mode; see
[Codex commands and models](../operations/requirements.md#codex-commands-and-models). The host
service is named after the machine:

```yaml
version: 1
name: supertag
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:3434"]
    provision:
      - apiVersion: supertag/v1
        kind: PermissionSet
        metadata: { name: local-tools }
        spec:
          permissions:
            - { target: runtime, action: commands:execute }
            - { target: runtime, action: files:write }
            - { target: runtime, action: web:fetch }
      - apiVersion: supertag/v1
        kind: Role
        metadata: { name: Lead }
        spec:
          purpose: "Own Objectives for this repository: plan the work, make and verify changes, and report what changed."
          permissionSets: [local-tools]
      - apiVersion: supertag/v1
        kind: Tag
        metadata: { name: lead }
        spec:
          lead: true
          roles: [Lead]
          execution: { harness: codex }
          workspace: { id: app, ref: main }
  studio:
    type: host
    harnesses: [codex]
    concurrency: 3
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
| `services` | Service name to service: one to 33 services, at most 32 of them hosts. Names use lowercase letters, digits, `-`, and `_`, up to 63 characters. A host cannot be named `supervisor`, `control-plane`, or `gateway`. |
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
| `time-zone` | the machine's | An IANA name such as `Europe/Berlin`. Schedule times that name no time zone are read in it. `supertag init` writes the machine's |
| `credentials` | `file` | The credential vault. The local supervisor supports `file` only |
| `notify` | none | One destination or a list: `webhook:https://HOST/PATH[#SECRET_NAME]` or `slack:CHANNEL_OR_USER` (optionally `slack:WORKSPACE/CHANNEL_OR_USER`). A webhook's secret name must exist under `secrets:`. See [Set up operator notifications](../guides/notifications.md) |
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
| `workspaces` | none | Up to 128 Workspace names, each to a repository path or `{ path, land, setup }`. See [Workspaces](#workspaces) |
| `skills` | none | Local Skill directory or JSON catalog file selected by Context Sets. Relative paths resolve from this file |
| `labels` | none | Placement labels the host carries, such as `[gpu]`, for a Tag's `runsOn`. See [Worker Host labels](resource-model.md#worker-host-labels) |
| `environment` | none | `local-vm` runs Claude Code, Cursor, and OpenCode Tasks' commands and file tools in containers on this machine. See [local-vm containers](#local-vm-containers) |
| `allow-unsandboxed-commands` | none | `claude-code`, `cursor`, or `opencode` from `harnesses`. See [Unsandboxed harnesses](#unsandboxed-harnesses) |
| `network-credentials` | none | Credential name to `{ secret, environment }`, added to a Task's requests by the egress proxy. Codex, or every harness on a local-vm host. See [Network credentials](#network-credentials) |
| `volumes` | none | Volume ID to an absolute, owner-only directory: a file Volume this host maps and writes directly, such as the copies of a Tag's captures. Tags on that Volume run only on hosts that map it. See [Keep every capture on a Volume](artifacts.md#keep-every-capture-on-a-volume) |
| `concurrency` | `1` | Task Attempts each harness runs at once, from 1 through 16. See [Host concurrency](#host-concurrency) |
| `attempt-timeout-seconds` | `3600` | Seconds a Task Attempt may run, from 1 through 86400 |
| `depends_on` | none | The file's `control-plane` service, to bring up first. Only a host of the local Control Plane takes it |
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
      codex: [gpt-6-sol]
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
`mcp:`, `mcp-login:`, `volume-credential:`, and `volume:` prefixes, and a host takes at
most 64. Changing a host's labels restarts that host on the next `supertag up`.

### Host concurrency

`concurrency` is per harness: `harnesses: [codex, claude-code]` with `concurrency: 2` runs up to
two Codex and two Claude Code Task Attempts at once. When only `concurrency` changes,
`supertag up` changes the running host without restarting it. The host `supertag init` writes
sets `concurrency: 3`.

### local-vm containers

Claude Code, Cursor, and OpenCode have no sandbox of their own that SuperTag can enforce. `environment:
local-vm` gives them one: each Task Attempt's Workspace lives in a container on this machine's
Docker or Podman, and every file and command tool runs there. The harness and its keys stay on
the host. This is the setup `supertag init` writes when Docker or Podman is running.

```yaml
    harnesses: [claude-code, cursor]
    environment: local-vm
    workspaces:
      app: ~/code/app
```

The container has no network, and none of your files but the Workspace copy. A
Task whose commands have a scoped `web:fetch` reaches only the hosts its
[network scope](iam.md#network-scopes) allows, through a relay to the Attempt's egress proxy on
the host; names do not resolve otherwise. Such a host can also take `network-credentials`. Its
commands run as an unprivileged user without sudo or any capability. Before the Workspace returns, SuperTag stops
every process the Task left running; the Task cannot hide a process from that step. The first
Task Attempt on a machine builds the container image, which takes a few minutes; the host's log
shows the progress.

A local-vm host needs a Workspace and cannot take `allow-unsandboxed-commands`. When both a local-vm host and a host with `allow-unsandboxed-commands` could run a
Task with `commands:execute`, the local-vm host gets it unless it is busy. These variables, in the
shell or `env_file`, change the container:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPERTAG_LOCAL_VM_RUNTIME` | `docker`, or `podman` when only it is installed | The container runtime |
| `SUPERTAG_LOCAL_VM_IMAGE` | a Debian image with Git, Python, Node, and ripgrep | An image with `python3`, `git`, and a POSIX shell. A Task Attempt fails to start when the image lets its user write `python3`, `git`, or what they load, such as a Python installed under the user's home |
| `SUPERTAG_LOCAL_VM_USER` | `user` | The image's unprivileged user. Root is refused |
| `SUPERTAG_LOCAL_VM_MEMORY` | `8g` | The container's memory limit |

A repository's `.devcontainer` settings add to the image; see
[Devcontainer settings](devcontainer-subset.md). A host started without supertag.yaml takes
`supertag worker-host --local-vm`.

### Unsandboxed harnesses

Codex runs commands in its own sandbox. Claude Code, Cursor, and OpenCode have none that SuperTag
can enforce. Prefer [local-vm containers](#local-vm-containers) for them.
Otherwise a host does not run their Tasks that may run commands (`commands:execute`) unless
the harness is listed in `allow-unsandboxed-commands`; such a Task waits for a host that allows
it. Commands then run as your user, with your files, network, and the environment the harness
receives, which may include its provider key. Cursor also needs `files:write` to run commands.

```yaml
    harnesses: [codex, claude-code]
    allow-unsandboxed-commands: [claude-code]
```

A host started without supertag.yaml takes the same opt-in with `supertag worker-host
--allow-unsandboxed-commands`.

### Network credentials

```yaml
secrets:
  github-token: { environment: GITHUB_PAT }
services:
  laptop:
    type: host
    harnesses: [codex]
    network-credentials:
      github: { secret: github-token, environment: GITHUB_TOKEN }
```

A Permission Set's `web:fetch` grant names a credential by its name, here `github`; see
[Network scopes](iam.md#network-scopes). `secret` names an entry in `secrets`. `environment` is
the variable a Task's commands see, holding a placeholder instead of the secret. The host's
egress proxy swaps the placeholder for the secret only in requests the grant allows. Names are
lowercase letters, digits, and `-`. `environment` cannot be a proxy, certificate, `PATH`, or
`HOME` variable, or start with `SUPERTAG_`, `CODEX_`, `GIT_`, or another harness's prefix.

Only the host's Codex lanes receive the secrets, and the Control Plane learns only the names. A
host started without supertag.yaml takes `supertag worker-host --network-credential
github=GITHUB_TOKEN` and reads the value from `SUPERTAG_NETWORK_CREDENTIAL_GITHUB`.

### Workspaces

```yaml
    workspaces:
      app: ~/code/app
      api: { path: ~/code/api, land: patch, setup: npm ci }
      docs: { path: ~/code/docs, land: { merge: agents, push: origin } }
      handbook: { remote: true }
```

`{ remote: true }` serves a remote Workspace: a `Workspace` resource on a git server, which the
host reads and pushes itself with a credential the Control Plane grants for each operation. It
takes no `path`, `land`, or `setup`: the resource's own `land` applies. `supertag up` warns when its
Control Plane defines no such Workspace yet; create it with `supertag workspace put`. The rest of
this section is about local repositories.

Each Task Attempt runs in its own checkout of the repository, pinned to an exact commit. `setup`
runs in each new checkout before the harness starts, on the host and outside any harness sandbox,
with a 10-minute limit. `land` says where a Session's changes go. The host writes each Session branch into the repository
itself; `supertag up` runs `push` and `merge` only for a host of the file's own Control Plane.

| `land` | What `supertag up` does |
| --- | --- |
| `local` (default) | The host writes each delivered Task into the repository as the branch `supertag/session/HASH` |
| `patch` | Leaves the repository alone (the host's `--workspace-patch`) |
| `{ push: REMOTE }` | As `local`, then pushes each Session branch to `REMOTE`, one of the repository's git remotes |
| `{ merge: BRANCH }` | As `local`, then merges a Session into the local branch `BRANCH` once its work is reported done |
| `{ merge: BRANCH, push: REMOTE }` | Merges as above, then pushes the Session branch and `BRANCH` to `REMOTE` |

It uses the machine's own git configuration and credentials. Branches move only forward: nothing is
force-pushed, and a branch that is checked out is never moved. A merge conflict gives the Session
a follow-up Task that resolves it. See
[Push or merge from your machine](../guides/workspaces.md#push-or-merge-from-your-machine).

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
logs/                  supervisor, control-plane, gateway, and hosts/ logs
hosts/NAME/            each host service's own state directory
```

Each host service keeps its credential, execution journal, checkouts, and the artifacts,
Workspace deliveries, and Session checkpoints its Tasks produce in its own state directory,
`hosts/NAME/`. The Control Plane stores none of those bytes. See [Credential storage](credential-storage.md).

## Credentials

The local Control Plane accepts this machine's local operator credential, a random token stored
in `credentials.json`. Operator commands that name no other Control Plane use it. A host
service never connects with it: it only enrolls the host, which then connects with its own
credential. Neither credential is printed or logged.
