# Run Worker Hosts

A **Worker Host** is a machine or sandbox that runs Tasks for Tags, the persistent AI actors with
their own responsibilities and permissions. It connects outbound to the **Control Plane**, the
service that stores your organization and schedules its work, claims Tasks its Tags may run, and
runs each **Task Attempt**, one execution of a Task, through a **harness adapter**: the process
that drives an agent system such as Codex or Claude Code. See the
[glossary](../reference/glossary.md) for other terms.

`supertag init` already connects your own computer. Use this guide to add machines, choose
harnesses and models, and control where work runs.

## Connect a machine day to day

A `host` service in `~/.supertag/supertag.yaml` runs a Worker Host under `supertag up`:

```yaml
services:
  control-plane:
    type: control-plane
  studio:
    type: host
    harnesses: [codex, claude-code]
    models:
      codex: [gpt-5.5, gpt-5.5-mini]
    workspaces:
      app: ~/code/app
    concurrency: 2
```

A host in the same file as its Control Plane joins on its own and may run every Tag. `harnesses`
lists up to five built-in harnesses: `codex`, `claude-code`, `cursor`, `opencode`, and
`openai-agents`. `workspaces` maps each Workspace name to a local Git repository. `supertag ps`
shows the host, and `supertag logs -f studio` shows its log. See
[supertag.yaml and local state](../reference/supertag-yaml.md) for every key.

### Harnesses without a sandbox

Codex and Claude Code run commands inside their own sandbox. OpenCode and Cursor have no
operating-system sandbox that SuperTag can enforce, so a host refuses their Tasks that may run
commands until you consent:

```yaml
    allow-unsandboxed-commands: [cursor]
```

Commands then run as your user, with your files and network. Run such a host as a dedicated user
or in a disposable machine when the work is untrusted.

### Run several Tasks at once

`concurrency` sets how many Task Attempts each harness on the host runs at once, from 1 through
16; the default is 1. `supertag up` changes running hosts' concurrency without restarting them.
Teams can also cap how many of their Tasks run at once; see [Teams](teams.md).

### Limit how long a Task Attempt runs

A Task Attempt may run for 60 minutes. Set `attempt-timeout-seconds` on the host service, up to
86400, to change that.

## Join your team's Control Plane

Ask an operator of the shared Control Plane for a host **Auth Key**, a short-lived secret that
enrolls one machine:

```sh
supertag auth-key create laptop-2 --role host --tag lead --control-plane team
```

Save it to a private file and point a host service at the Control Plane:

```yaml
services:
  laptop-2:
    type: host
    control-plane: https://supertag.example.com
    auth-key: laptop-2-key
    harnesses: [codex]
    workspaces:
      app: ~/code/app
secrets:
  laptop-2-key: { file: ~/laptop-2.key }
```

```sh
supertag up
rm ~/laptop-2.key
```

The first `supertag up` enrolls the host as `host:laptop-2` and keeps its own credential in its
state directory. The host may run only the Tags its key names, or every Tag for a key created with
`--all-tags`.

## Run a host without supertag.yaml

On a server, CI runner, or container, enroll once and then run the host directly:

```sh
supertag host enroll build-1 --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex --label linux \
  --workspace-id app --workspace-source /srv/app
```

`worker-host` reads its credential from the state directory and stays connected until you stop
it. Use the `wss://` URL for a Control Plane behind Render, Cloudflare, or Modal. The host needs
no inbound port. `--once` exits after one Task Attempt, for a disposable runner.

## Keep a Tag's Tasks on the right hosts

A host carries **labels**, such as `gpu` or `linux`, from `--label` or from the Auth Key it joined
with. A Tag's `runsOn` names labels a host must carry to run the Tag's Tasks:

```sh
supertag placement runs-on builder gpu --control-plane team
supertag placement explain TASK_ID --control-plane team
```

`placement explain` says why a queued Task waits: no host may run its Tag, the eligible hosts lack
a label, or they are busy or draining. `describe task` includes the same explanation.

## Choose a harness

| Harness | Needs on the host | Sign-in |
| --- | --- | --- |
| `codex` | `codex` on `PATH` | `CODEX_API_KEY`, `OPENAI_API_KEY`, or a file-backed `codex login` |
| `claude-code` | `claude` on `PATH`, and Node.js | `ANTHROPIC_API_KEY`, or `claude` signed in as the host's user |
| `cursor` | Node.js | `CURSOR_API_KEY` |
| `opencode` | `opencode` on `PATH`, and Node.js; a `provider/model` model | The provider's API key variable, or `--opencode-auth-file` |
| `openai-agents` | Python with the `supertag` package's OpenAI Agents extra | `OPENAI_API_KEY` |

Check a harness's sign-in with the credentials the host will have:

```sh
supertag sign-in codex
supertag sign-in opencode --model anthropic/claude-sonnet-4-5
```

Put provider keys in the env file beside `supertag.yaml`, `~/.supertag/.env`, rather than in a
shell profile: a service unit does not inherit your shell. A host passes each harness only its
own provider credentials. See [Requirements](../operations/requirements.md#choose-and-sign-in-to-a-harness).

### Choose models and effort

A host advertises the models each harness serves: `models` in `supertag.yaml`, or
`--harness-model` and `--harness-models` for `worker-host`. The first is the default. A Tag's or
Role's `execution` then chooses a harness, models, and efforts within what hosts offer:

```yaml
apiVersion: supertag/v1
kind: Role
metadata: { name: Builder }
spec:
  purpose: Implement bounded changes with tests.
  execution: { harness: codex, models: [gpt-5.5], efforts: [medium, high] }
```

A Task that names a model runs only on a host that lists it. See
[execution settings](../reference/resource-model.md#execution-settings).

### Codex

Codex runs through an adapter built into `supertag`, using Codex's app-server. It reports token
usage as it goes, so a Task's `--max-reported-tokens` limit stops the turn when the reported
count reaches it. `--codex-path` names another Codex executable.

### Claude Code, Cursor, and OpenCode

These run through Node bridges that the release archive installs. `--claude-path`,
`--opencode-path`, and `--cursor-node` name other executables. A CLI built without the archive
needs `--harness-entrypoint` pointing at a built adapter.

### Your own harness

`--adapter PATH` runs any executable that speaks the harness protocol, with `--adapter-arg` for
its arguments; in `supertag.yaml`, use `adapter` and `adapter-args` instead of `harnesses`. See
[Write a harness adapter](harness-adapters.md).

## Run Cursor in a sandbox

Cursor Tasks can keep their files and commands in a sandbox while the harness, and its
credentials, stay on the host:

| Option | Runs the Workspace in |
| --- | --- |
| `--e2b-workspace-provider` | An E2B sandbox per Task Attempt |
| `--modal-workspace-provider` | A Modal sandbox per Task Attempt, with `SUPERTAG_MODAL_WORKSPACE_APP` and optionally `SUPERTAG_MODAL_WORKSPACE_IMAGE` |
| `--shared-execution-endpoint` | A long-lived shared execution environment, served by `supertag-shared-execution`, that several Cursor Sessions share |

A remote sandbox caps a Task Attempt at 3600 seconds, the longest those providers grant. A Tag
requires a shared environment with `tag put --shared-execution-environment ID`. A repository's
`.devcontainer` settings choose the sandbox's image, user, and setup commands; see
[Devcontainer settings](../reference/devcontainer-subset.md).

## Optional: Skills

`skills` on a host service, or `--skill-catalog`, names a private allowlist of **Skills**,
reusable instruction packages that Context Sets select. A directory holds one directory per
Skill. A JSON catalog can also name Skills in a GitHub repository, fetched at an exact commit when
a Task needs one. See [Context and permissions](../concepts/context-and-permissions.md).

## Optional: MCP servers

`--mcp-catalog` names an owner-only JSON catalog of MCP servers that the host offers Claude Code
Tasks. A Task sees a catalog tool only when its Permission Sets grant it. See
[MCP tools for GitHub, Slack, Linear, Teams, and Lark](../surfaces/worker-tools.md).

## Keep artifacts on Worker Hosts

A host keeps the artifacts its Tasks capture in its state directory. To let Tasks on other hosts
read them, give it a transfer listener:

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex \
  --artifact-transfer-listen 0.0.0.0:8443 \
  --artifact-transfer-tls-cert transfer.pem --artifact-transfer-tls-key transfer.key
```

A consuming host pins each producing host to an origin with `--artifact-peer HOST_ID=ORIGIN`, and
trusts its CA with `--artifact-peer-ca-file`. See [Artifacts](../reference/artifacts.md).

## Drain, resume, and remove a host

```sh
supertag host drain build-1 --control-plane team
supertag host resume build-1 --control-plane team
supertag host revoke build-1 --control-plane team
supertag host rotate-credential build-1 --control-plane team --out build-1.credential
```

A draining host finishes its running Task Attempts and claims no new ones. Revoking a host refuses
its credential at once. `supertag down` drains this machine's hosts before stopping them.

## Recover an interrupted Task Attempt

A host restarted after it was killed checks the processes it recorded for an interrupted Task
Attempt. When all of them are gone, it records the Task Attempt as failed with an unknown outcome
and takes new work. Otherwise, and always for a Task Attempt that used a remote sandbox or shared
execution, an operator decides:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The sandbox was deleted; no commit was pushed." --confirmed-stopped \
  --control-plane team
```

`--decision retry` runs the Task again. See [Scheduling and recovery](../reference/scheduling-and-recovery.md).

## Check that it worked

```sh
supertag get host --control-plane team
supertag status
```

The host shows as connected and ready, with its harnesses and labels. Send its Tag a message and
confirm a reply.

## If something goes wrong

- **A Task stays queued.** Run `supertag placement explain TASK_ID`.
- **The host stops with a sign-in error.** Run `supertag sign-in HARNESS` as the host's user.
- **A Cursor or OpenCode Task fails before running commands.** Add the harness to
  `allow-unsandboxed-commands`, or run Tasks that do not need commands.

See [Troubleshoot the first reply](troubleshooting.md).

## Next

- [Work in a repository with Workspaces](workspaces.md)
- [Write a harness adapter](harness-adapters.md)
