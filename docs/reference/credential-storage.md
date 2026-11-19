# Credential storage

If the [organization](glossary.md#autonomous-organization) and execution terms on this page are new,
start with [core concepts](../concepts/README.md).

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt),
[Permission Set](glossary.md#permission-set), [Control Plane](glossary.md#control-plane),
[Gateway](glossary.md#gateway), [Surface Account](glossary.md#surface-account),
[Worker Host](glossary.md#worker-host), [host service](glossary.md#host-service),
[Auth Key](glossary.md#auth-key), [admin token](glossary.md#admin-token),
[Operator Token](glossary.md#operator-token),
[harness adapter](glossary.md#harness-adapter), and
[Workspace](glossary.md#workspace).

SuperTag keeps each credential with the component that uses it, so a Gateway's collaboration
surface secrets, an operator's token, and a Worker Host's keys never share a store.

## Five logical boundaries

| Boundary | Owner | Examples | Default implementation |
| --- | --- | --- | --- |
| Gateway credential vault | The Gateway | Collaboration surface secrets, such as a Slack bot token | `~/.supertag/gateway-credentials.json`, or HashiCorp Vault |
| Operator credentials | Operator's CLI, terminal UI, and desktop app | The admin token, an [Operator Token](resource-model.md#operator-tokens), or a client device credential | The saved Control Plane stores of the terminal UI and desktop app, or `SUPERTAG_OPERATOR_TOKEN` |
| Worker Host enrollment credential | One Worker Host | Its connection to the Control Plane | The host's own state directory, on that host |
| MCP and git credentials | One Worker Host | MCP server and git credentials | The host's environment, owner-only files, or `~/.supertag/.env`; see [MCP and git credentials](#mcp-and-git-credentials) |
| Network credentials | One Worker Host | Secrets the egress proxy adds to a Task's web requests, such as a GitHub token | A `secrets` entry in `supertag.yaml`; see [Network credentials](supertag-yaml.md#network-credentials) |

The Control Plane stores only SHA-256 digests of the credentials it issues: Auth Keys, enrolled
host, Gateway, and client credentials, and Operator Tokens. It never resolves a collaboration
surface, MCP, or git secret.

### Local storage paths and model credentials

The local Control Plane that `supertag init` and `supertag up` run uses the same directory,
`~/.supertag/`, or the one `SUPERTAG_STATE_DIR` names. Nothing is stored in a repository:

| Path in `~/.supertag/` | Holds |
| --- | --- |
| `credentials.json` | The local credential bundle: this machine's operator token and the local Gateway's and host's bootstrap credentials, owner-only |
| `gateway-credentials.json` | The local Gateway's file credential vault |
| `mcp-logins/` | OAuth tokens that `supertag mcp login` stores, one owner-only file per server |
| `hosts/SERVICE/` | The Worker Host credential (`enrollment.json`) and execution journal of each host service in `supertag.yaml`, owner-only |
| `supertag.yaml` | The services file. It never holds a secret value: keys that take a secret name an entry in `secrets`, whose value comes from an environment variable or a file. |
| `runtime.sqlite3` | Local SQLite state, owner-only |

`supertag init` and `supertag sign-in` check each harness's credentials as its Task Attempts
will read them. For Claude Code, run `claude` and use `/login`, or set `ANTHROPIC_API_KEY` in the
host's `env_file` (default `~/.supertag/.env`). Task Attempts read the sign-in store selected by
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, otherwise `~/.claude` (macOS Keychain on macOS,
`.credentials.json` on Linux).

Codex Task Attempts use `CODEX_API_KEY` first, then copy `$CODEX_HOME/auth.json` (default
`~/.codex/auth.json`), then fall back to `OPENAI_API_KEY` if that file is missing. Set either API
key in the host's `env_file`, or, for a login that Task Attempts can copy, run
`codex -c 'cli_auth_credentials_store="file"' login`; a Keychain-only login is not copied. The
file-backed sign-in check verifies credential structure without testing account access.

A background host started from a shell also inherits these variables from the shell; a service
unit does not.

### Operator and host credentials

The local operator token in `credentials.json` is the local Control Plane's admin token. Commands
that name no other Control Plane use it. A host service never connects with it. For a host in
the same file as the local Control Plane, `supertag up` enrolls the host once, then the host uses
its own Worker Host credential from `hosts/SERVICE/enrollment.json`. A host of a shared Control
Plane joins with an Auth Key instead. See [supertag.yaml and local state](supertag-yaml.md#credentials).

`supertag connect` saves a remote Gateway and its Operator Token or client device credential in
the per-user stores the terminal UI and desktop app read:
`supertag/tui-gateways.json` and `ai.supertag.desktop/gateways.json` in the user
configuration directory (`~/Library/Application Support` on macOS, `~/.config` on Linux).
Neither store ever holds the local operator token: the terminal UI and the desktop app read it
from `credentials.json` each time they connect to the local Gateway.

The desktop app also caches what it shows on launch, so it shows at once: the conversation list,
the selected Tag, the latest messages of each conversation, and messages not yet sent. It keeps
them in `ai.supertag.desktop/cache/` in the user data directory, which is the configuration
directory on macOS and `~/.local/share` on Linux. Each Control Plane and principal has its own
owner-only directory there. The cache never holds a credential. Forgetting a saved Control Plane
deletes its cache.

The terminal UI keeps the same kind of cache, so `supertag` shows the last Tag's conversation
before the Control Plane answers: the Tag list with each conversation's row, the selected Tag,
the latest 50 messages of each conversation shown, messages not yet sent, and unsent drafts. It
keeps them in `supertag/tui/` in the user cache directory (`~/Library/Caches` on macOS,
`~/.cache` on Linux), in an owner-only directory per Control Plane and principal, with one
owner-only file per entry, each replaced in one step. To find the principal before the Control
Plane answers, it records whom each credential acted as under a one-way digest of the
credential, which cannot be used to connect. The cache never holds a credential. An entry in
another format is discarded. Forgetting a saved Control Plane deletes its cache; deleting the
directory loses only unsent messages and drafts. The rail's width and whether it is folded are
kept beside it, in `preferences.json`.

### Gateway credential vault

The Gateway reads each collaboration surface's secrets from its vault when it starts, at the
logical ID `surface/PROVIDER/ACCOUNT`, such as `surface/slack/T123`. A variable set in the Gateway's
environment still wins for that secret. `supertag setup surface` and
`supertag gateway credential store` write the vault; `supertag gateway credential delete` removes
an entry. A rotated secret takes effect when the Gateway restarts.

The vault never reaches the Control Plane, the CLI after setup, or a Worker Host. In a local
deployment the file vault sits beside the other local state; any process that can read the file
can read it, so it is not an operating-system isolation boundary.

The relational store records the logical ID, never a backend-specific address such as a file path
or a Vault path. Moving the values to another backend therefore needs no resource change.

## Worker Host enrollment credential

A Worker Host enrollment credential is distinct from the harness and MCP credentials its Tasks
use. A host obtains one with a host [Auth Key](resource-model.md#auth-keys); the Control Plane
stores only a SHA-256 digest of each `stak_` secret and of each enrolled `stcr_` credential, and
compares them in constant time. Operator Tokens (`stop_`) are stored the same way.

A Worker Host enrolls from its own side and keeps its credential in its owner-only state
directory, outside any checkout a harness can read. Its Worklet uses that credential, and no
[Worker](glossary.md#worker), the process that runs one Task Attempt, receives it:

```bash
supertag host enroll build-east-1 --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --auth-key file:build-east-1.key
```

A host service in `supertag.yaml` does the same on its first `supertag up`. A host that reads its
credential from its own secret manager uses `SUPERTAG_HOST_TOKEN`; an operator writes a new one
with `supertag host rotate-credential build-east-1 --out FILE`, and a stopped host's own
credential is rotated with `--host-state-directory`. Rotation replaces the credential at once;
revocation refuses it at once. `supertag get host` never shows the token or its digest.

### Task Attempt credential

When a Task Attempt starts, the Control Plane returns a Task Attempt credential (`stat_` and 64
hex digits) for that Task Attempt alone, again storing only its digest. The Worklet passes it to
the Worker it starts for the Task Attempt over their private channel and keeps no copy; it is never
written to the state directory. The Worker makes its data calls with it. It works only while the
Worklet holds the lease. Renewing the
lease extends it. Finishing or reclaiming the Task Attempt, a lapsed lease, revoking the host, the
host registering again, or a repeated start ends it. After a cancellation it still records the
Task Attempt's usage, milestones, and network log until the Worklet reports that execution
stopped. A harness adapter never receives it: the
adapter's bootstrap token works only on its Worker's loopback endpoint.

### Which process holds which credential

| Process | Holds |
| --- | --- |
| The Worklet, one per Worker Host | The host credential, and the provider and network credentials of every harness it runs |
| A Worker, one per Task Attempt | Its Task Attempt credential, its own harness's provider credentials, the network credentials its Task may use, and the MCP credentials it resolves for its Task Attempt |
| A harness adapter | Its own harness's provider credentials and a bootstrap token for its Worker's loopback endpoint |

A Worker inherits its Worklet's environment, except the host credential and the
`SUPERTAG_NETWORK_CREDENTIAL_*` values, and never receives the host credential in its arguments or
any message. A Worker that needs a call only the host may make asks its Worklet, which makes
it only for that Worker's own Task Attempt.

A host credential is never a CLI flag. The Worker's own calls never carry it, and the built-in
supervisor removes the exact host credential, Task Attempt credential, and bootstrap token values
from harness events and errors. Local-process execution under the same operating-system account is
not a filesystem security boundary; production deployments must keep the supervisor credential
outside the Task Attempt sandbox or run the harness under a separately confined identity.

## MCP and git credentials

MCP tool credentials, including those for the GitHub, Slack, Linear, Teams, and Lark presets, come
from references in the Worker Host's MCP catalog, which the Worker of each Task Attempt resolves.
`supertag mcp login` keeps OAuth tokens in `mcp-logins/` in the state directory
(`SUPERTAG_STATE_DIR`, else `~/.supertag`). They never enter the Surface Account vault. Git repository
source and pull-request delivery use a separate host-local `GITHUB_TOKEN`. See
[MCP tools](../surfaces/worker-tools.md).

Who wrote the server's configuration decides which variables it may read:

| Server declared in | References may name | Why |
| --- | --- | --- |
| The Worker Host's `--mcp-catalog` file | Any Worker Host variable or owner-only file | The host owner wrote it, so it is trusted. |
| A Workspace repository's `.mcp.json` | Only variables named `SUPERTAG_MCP_*`, such as `${SUPERTAG_MCP_SENTRY_TOKEN}` | A repository must not read the Worker Host's own credentials, such as `GITHUB_TOKEN`, `SUPERTAG_AUTH_KEY`, or a model API key. |

Set `SUPERTAG_MCP_*` values in the host's environment or in `~/.supertag/.env`. A Workspace
reference to any other variable stops the Task when it starts, with a message that names the
variable and this rule. SuperTag never sends the literal `${VAR}` text instead. The rule follows
GitHub Copilot's `COPILOT_MCP_` prefix. A stdio server starts with only a minimal environment plus
its resolved `env`, so it never inherits the Worker Host's credentials either. See
[Workspaces](../guides/workspaces.md#select-repository-skills-and-mcp-servers).

## Declared Surface Accounts

A SurfaceAccount manifest, applied with `supertag apply -f`, records an account's identity and the
Gateway that serves it, never a secret. Its credentials reach that Gateway's vault only through
`supertag setup surface` or `supertag gateway credential store` on the Gateway's machine. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

## API invariants

- Collaboration surface secrets go only to a Gateway's vault, from the Gateway's own machine.
- Auth Key creation and Worker Host, Gateway, and client enrollment or rotation return a secret
  once; revocation and ordinary reads never return it.
- Surface Account responses expose configuration and verification status, never credential values
  or physical locations.
- Tags, Permission Sets, Tasks, Worker Hosts, and harness prompts never contain Gateway
  collaboration surface credentials.
- A Worker Host resolves MCP and git credential references itself. A Workspace `.mcp.json` can
  reach only `SUPERTAG_MCP_*` variables. Each Worker holds the process-level secret boundary for
  its harness adapter.
- A shared backend must enforce distinct workload identities and policies; namespace names alone
  are not a security boundary.

## HashiCorp Vault KV v2

Select Vault for the Gateway with `SUPERTAG_CREDENTIAL_VAULT=vault`, `VAULT_ADDR`, and
`VAULT_TOKEN`, plus optional `SUPERTAG_VAULT_MOUNT`, `SUPERTAG_VAULT_PATH_PREFIX`, and
`VAULT_NAMESPACE`. Each logical ID maps beneath the deployment's KV v2 prefix. `supertag up` passes
the selection from the shell or `env_file` to the local Gateway, and `supertag setup surface`
stores into the same backend. A store replaces the entry, and errors never include a response
body or token.

Use a narrowly scoped token with `create`, `update`, and `read` capabilities on the prefix's KV v2 `data` path and `read` and `delete` on its `metadata` path. Non-loopback addresses require HTTPS. Follow [Vault production hardening](https://developer.hashicorp.com/vault/docs/concepts/production-hardening) for server deployment, authentication, audit devices, recovery, and token policy.
