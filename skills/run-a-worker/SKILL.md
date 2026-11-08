---
name: run-a-worker
description: Run Workers locally or attach another Worker Host to an existing Control Plane.
---

# Run a Worker

Start with [install-and-first-reply](../install-and-first-reply/SKILL.md) for a local setup.
`supertag init` already starts the Control Plane and connects this computer as a Worker Host.
Use this guide to inspect that setup or connect another machine; a chat smoke test is optional.

A Worker runs Tasks with a **harness** (Codex or Claude Code) and returns request-specific
answers. A **Worklet** on the Worker Host connects outbound to the Control Plane API Server's Worklet API and supervises its
Workers, so execution can stay on a laptop or build machine while the Control Plane runs elsewhere.

## Everyday path: `supertag init`

On the user's own computer, `supertag init` (run inside a git repository) writes
`~/.supertag/supertag.yaml` with two services and brings them up: a `control-plane` service (the
local Control Plane) and a `host` service named after the machine (this machine as a Worker Host).
All state lives in `~/.supertag/` (or `SUPERTAG_STATE_DIR`); nothing is written to the repository.

- `supertag up [SERVICE...]` brings up the services in `supertag.yaml` (or the `-f PATH` files,
  merged in order) in `depends_on` order, waits for each health check, and returns; they run in the
  background. Without a file it runs one `control-plane` service with defaults. Reruns leave
  unchanged services alone and restart changed ones; a changed host drains first (no new Task
  Attempts; waits at most the longest remaining Task Attempt time limit plus 30 s, capped at 30
  min; `--force` skips the wait). `--foreground` runs services in the terminal; `--dry-run` prints
  the plan. `restart: unless-stopped` on a service installs a launchd or systemd user unit.
- A host service lists `harnesses` (one Worker each), `workspaces` (name to absolute or `~` path),
  optional `models` (OpenCode needs `provider/model`), and `labels`. Claude Code, Cursor and
  OpenCode run commands as the host user without an enforceable sandbox, so they run Tasks granted `commands:execute` only
  when `allow-unsandboxed-commands` lists them (`--allow-unsandboxed-commands` for
  `connect worklet`); Codex needs no opt-in. A host in the same file as its
  Control Plane is enrolled with the local operator credential and keeps its own credential in
  `~/.supertag/hosts/SERVICE/credential.json`. Which Tags it serves comes from Tag manifests
  (`spec.workerHosts`) or `supertag update tag TAG --add-worker-host ID`; `init` binds the Tag it created.
- `supertag ps` lists services, connection state, Tags served, and running Task Attempts;
  `supertag logs -f [SERVICE...]` follows logs; `supertag down` stops hosts first, then the Control
  Plane (`--remove-services` also uninstalls units); `supertag config` prints the resolved file or
  every problem in it.
- Environment variables (`SUPERTAG_DATABASE_URL`, ...), from the shell or `env_file`, override the
  file. Service units do not inherit the shell: `up` copies `PATH`, `HOME`, and non-secret
  `SUPERTAG_*` overrides into the unit, never secrets. Put secrets and other needed variables in
  `~/.supertag/.env`. A shell-only value never restarts a unit's service; `up` warns and names it.
- Commands use the local Control Plane with this machine's local operator credential unless
  another Control Plane is selected.

To join a machine to a shared Control Plane, the operator creates an Auth Key, and the teammate
saves it in a file and adds a host service to `~/.supertag/supertag.yaml`:

```yaml
services:
  laptop:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-key
    harnesses: [codex]
    workspaces: { app: ~/code/app }
secrets:
  laptop-key: { file: ~/laptop.key }
```

Then `supertag up`. The host connects over WebSocket to that URL (a Control Plane run with
`supertag start control-plane` needs `SUPERTAG_WORKLET_TRANSPORT=remote`). The key decides the
host's Tags. The host credential is saved in `~/.supertag/hosts/laptop/`, so later runs ignore the
key. Resources there change only through `supertag apply -f` with manifests, run with an Operator
Token (`supertag create operator-token NAME`, issued by the admin-token holder; the teammate saves
it with `supertag connect control-plane URL`). See
[supertag.yaml and local state](../../docs/reference/supertag-yaml.md).

`supertag connect worklet`, below, is the low-level foreground command for deployments, scripts,
and custom setups: one harness, flags only, never reads `supertag.yaml`, credentials in
`~/.supertag/worker-hosts/`.

## Switch the Control Plane to remote Worklet transport

`supertag init` and `supertag up` already configure remote Worklet transport. Skip this
section for those services. Only a bare Control Plane started directly defaults to the
embedded smoke-test responder. Stop that foreground process before restarting it to
accept a real Worklet:

```sh
export SUPERTAG_WORKLET_TRANSPORT=remote
supertag start control-plane
```

Connect the administrative CLI, then create an **Auth Key** for the Tag the host will serve. The
key is a join secret: the machine that redeems it becomes a Worker Host bound to the key's Tags.

## Connect the Worklet

From the operator environment (the secret `stak_...` is printed once):

```sh
supertag create auth-key laptop --tag engineering            # one-off, expires in 1 hour
supertag create auth-key ci --tag engineering --reusable --ephemeral   # CI runners; 90 days
```

From the machine that owns the codebase and harness authentication:

```sh
SUPERTAG_AUTH_KEY=stak_... supertag connect worklet \
  --transport websocket \
  --worklet-url http://127.0.0.1:3434 \
  --harness codex \
  --workspace /absolute/path/to/codebase \
  --worker-profile local-codex
```

The host joins under its hostname (`--worker-host NAME` overrides; collisions become `NAME-2`),
stores its credential under `~/.supertag/worker-hosts/`, and is already bound to the key's Tags.
Later runs use the stored credential and ignore the key, so scripts may always pass it. Ephemeral
hosts keep the credential in memory and are removed after they disconnect.

Credential resolution order: stored credential for this Control Plane, then `--auth-key` /
`SUPERTAG_AUTH_KEY`, then operator credentials on the machine (the host is enrolled but not bound;
run `supertag update tag TAG --add-worker-host ID`). Joining uses the management API:
`SUPERTAG_CONTROL_PLANE` if set, else the origin of a WebSocket Worklet URL, else the saved
Control Plane (a separate gRPC listener never serves it).

Omit `--worklet-url` to use the currently selected Control Plane's URL. For a remote Control Plane use
`https://`; the Worklet upgrades it to `wss://` itself. **Never send the Worker Host credential over
plaintext outside loopback.**

## Choose a harness

| Harness | Flags | Authentication |
| --- | --- | --- |
| Codex | `--harness codex` | `CODEX_API_KEY`, `OPENAI_API_KEY`, or an existing file-backed Codex sign-in copied into the isolated Task Attempt directory |
| Claude Code | `--harness claude-code --worker-profile local-claude-code` | `ANTHROPIC_API_KEY`, read from the Worker Host by the Claude Agent SDK |

Both shipped profiles ignore user and project MCP configuration. They receive only the Skills,
workspace, and hosted tools admitted for that Task. Permission Sets control which MCP actions
the harness may use; the provider credential must also allow each action.

**A Task that selects a Worker Profile needs a bound host advertising that exact profile and
revision.** Bind an existing Tag to the host with `supertag update tag engineering --add-worker-host HOST_ID`.

## Optional capabilities

**Skills** — a host service's local allowlist catalog:

```yaml
services:
  laptop:
    type: host
    harnesses: [codex]
    skills: ~/skills
```

A Context Set selects Skill identities; the Worker verifies version and digest pins before
staging. The catalog is the allowlist — a Skill not in it cannot be staged.

**Named Workspaces** — `--workspace NAME=PATH` (repeatable) declares a local git checkout of a
`Workspace` resource. Tasks that name it run on this host in their own git worktree on their
Session's branch, `supertag/session/<short session id>`, edited in place; the Worker commits after
each Task Attempt.
Only local process profiles serve Workspaces. Without a declared checkout, such a host clones a
Workspace's `source` under `~/.supertag/workspaces/<workspace>/clone`. `delivery: pull-request`
pushes the Session's branch and opens a GitHub draft pull request; it needs `pull-requests:create` on
the repository and a host-local `GITHUB_TOKEN` restricted to it. An unnamed
`--workspace PATH` is still a read-only-by-default copy. See `docs/guides/workspaces.md`.

**Request-selected GitHub workspace** — if a request names an authorized repository, or
originates in one, the Workspace Resolver can resolve a commit-pinned snapshot. The Tag needs
`contents:read` and the Worker needs:

```sh
GITHUB_TOKEN
GITHUB_ACCOUNT_ID   # optional account guard
```

**Hosted MCP tools** — GitHub, Slack, Linear, Teams, and Lark use host service `mcp` presets
and `target: mcp` grants. Set their host-local `auth` or `env` references in `supertag.yaml`. See [MCP tools](../../docs/surfaces/worker-tools.md).

## Verify

```sh
curl --fail http://127.0.0.1:3434/readyz      # unavailable until a compatible Worklet connects
supertag list worker-host
supertag describe worker-host HOST_ID          # Connected / Ready / Draining / Unreachable
supertag list worker-profile
```

`/readyz` failing in remote mode with no Worklet connected is expected, not a fault.

Then mention the Tag. You should get a substantive answer rather than the smoke-test reply.

## Operate

```sh
supertag drain worker-host HOST_ID     # finish active Attempts, accept no new ones
# update or restart the Worklet or its Workers
supertag resume worker-host HOST_ID
```

Run the Worklet under a process supervisor when the host is always on. If the Worklet disconnects
or stops heartbeating, its Worker Host becomes unreachable, its active Task Attempt fails, and durable
work becomes eligible for recovery.

To integrate an engine other than Codex or Claude Code, see
[build-a-custom-worker](../build-a-custom-worker/SKILL.md).
