# Run Worker Hosts

A **Worker Host** is a machine or sandbox that runs Tasks for Tags, the persistent AI actors with
their own responsibilities and permissions. Its **Worklet**, the `supertag worker-host` program,
connects outbound to the **Control Plane**, the service that stores your organization and
schedules its work, and claims Tasks its Tags may run. For each **Task Attempt**, one execution of
a Task, the Worklet starts a **Worker**, a process of its own that runs a **harness adapter**, the
program that drives an agent system such as Codex or Claude Code, and that harness. See the
[glossary](../reference/glossary.md) for other terms.

`supertag init` already connects your own computer. Use this guide to add machines, choose
harnesses and models, and control where work runs.

## Connect a machine day to day

A `host` service in `~/.supertag/supertag.yaml` runs a Worker Host's Worklet under `supertag up`:

```yaml
services:
  control-plane:
    type: control-plane
  studio:
    type: host
    harnesses: [codex, claude-code]
    models:
      codex: [gpt-6-sol]
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

Codex runs commands inside its own sandbox. Claude Code, OpenCode, and Cursor have no
operating-system sandbox that SuperTag can enforce. Run their Tasks in containers on this
machine's Docker instead:

```yaml
    environment: local-vm
```

Their file tools and commands then run in a container with no network, and the harness and its
keys stay on the host. `supertag init` sets this up when Docker is running. Podman is not
supported yet. See
[local-vm containers](../reference/supertag-yaml.md#local-vm-containers).

Otherwise a host does not run their Tasks that may run commands until you consent:

```yaml
    allow-unsandboxed-commands: [claude-code, cursor]
```

`supertag worker-host --allow-unsandboxed-commands` consents for a host started without
supertag.yaml. Commands then run as your user, with your files, network, and the environment the
harness receives, which may include its provider key. Run such a host as a dedicated user
or in a disposable machine when the work is untrusted.

### Run several Tasks at once

`concurrency` sets how many Task Attempts each harness on the host runs at once, from 1 through
16; the default is 1, and the host `supertag init` writes sets 3. With 1, one stuck Task Attempt
holds that harness for every Tag on the host. The host's Worklet runs each Task Attempt in a
Worker process of its own, so `concurrency` is the size of its Worker pool for each harness, not a
number of host processes. `supertag up` changes running hosts' concurrency without restarting
them. A host started with `supertag worker-host` takes `--concurrency N`.
Teams can also cap how many of their Tasks run at once; see [Teams](teams.md).

### Limit how long a Task Attempt runs

A Task Attempt may run for 60 minutes. Set `attempt-timeout-seconds` on the host service, up to
86400, to change that.

## Join your team's Control Plane

Ask an operator of the shared Control Plane for a host **Auth Key**, a short-lived secret that
enrolls one machine:

```sh
supertag auth-key create laptop-2 --role host --tag lead --gateway team
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

On a server, CI runner, or container, enroll once and then run the host's Worklet directly:

```sh
supertag host enroll build-1 --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --auth-key file:build-1.key
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex --label linux \
  --workspace-id app --workspace-source /srv/app
```

`supertag worker-host` runs the Worklet. It reads the host's credential from the state directory
and stays connected until you stop it. Use the `wss://` URL for a Control Plane behind Render, Cloudflare, or Modal. The host needs
no inbound port. `--once` exits after one Task Attempt, for a disposable runner.

## Keep a Tag's Tasks on the right hosts

A host carries **labels**, such as `gpu` or `linux`, from the Auth Key it joined with, from
`--label` on `supertag worker-host`, or from its host service's `labels` in supertag.yaml:

```yaml
services:
  mac:
    type: host
    harnesses: [codex]
    labels: [gpu]
```

A Tag's `runsOn` names labels a host must carry to run the Tag's Tasks:

```sh
supertag placement runs-on builder gpu --gateway team
supertag placement explain TASK_ID --gateway team
```

`placement explain` says why a queued Task waits: no host may run its Tag, the eligible hosts lack
a label, or they are busy or draining. `describe task` includes the same explanation.

## Choose a harness

| Harness | Needs on the host | Sign-in |
| --- | --- | --- |
| `codex` | `codex` on `PATH` | `CODEX_API_KEY`, `OPENAI_API_KEY`, or a sign-in file from `codex -c 'cli_auth_credentials_store="file"' login` |
| `claude-code` | Node.js; `claude` on `PATH` for `init` and `sign-in`. Tasks run the Claude Code bundled with the release unless `--claude-path` names another | `ANTHROPIC_API_KEY`, or `claude` signed in as the host's user |
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
  execution: { harness: codex, models: [gpt-6-sol], efforts: [medium, high] }
```

A Task that names a model runs only on a host that lists it. See
[execution settings](../reference/resource-model.md#execution-settings).

### Codex

Codex runs through an adapter built into `supertag`, using Codex's app-server. It reports token
usage as it goes, so a Task's `--max-reported-tokens` limit stops the turn when the reported
count reaches it. `--codex-path` names another Codex executable. When `codex` is the launcher
that `npm install -g @openai/codex` installs, SuperTag runs the native binary behind it, so Node
need not be on the Worker Host's PATH. `supertag sign-in codex` and `supertag init` print the
binary they use.

### Claude Code, Cursor, and OpenCode

These run through Node bridges that the release archive installs. `--claude-path`,
`--opencode-path`, and `--cursor-node` name other executables. A CLI built without the archive
needs `--harness-entrypoint` pointing at a built adapter.

### Your own harness

`--adapter PATH` runs any executable that speaks the harness protocol, with `--adapter-arg` for
its arguments; in `supertag.yaml`, use `adapter` and `adapter-args` instead of `harnesses`. See
[Write a harness adapter](harness-adapters.md).

## Run a harness in a sandbox

Cursor and Claude Code Tasks can keep their Workspace in a sandbox while the harness, and its
credentials, stay on the host. Every file and command tool runs in the sandbox, and the harness
has no built-in tool that could run on the host:

| Option | Runs the Workspace in |
| --- | --- |
| `--local-vm` (`environment: local-vm`) | A container on this machine's Docker per Task Attempt |
| `--e2b-workspace-provider` | An E2B sandbox per Task Attempt |
| `--modal-workspace-provider` | A Modal sandbox per Task Attempt, in the existing Modal app named by `SUPERTAG_MODAL_WORKSPACE_APP` (the host never creates one; a missing app fails the Task naming it), with optionally `SUPERTAG_MODAL_WORKSPACE_IMAGE` and the token in `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` |
| `--workspace-provider` | Your own provider's sandbox per Task Attempt, given only the variables you name with `--workspace-provider-env`; see [Run your own provider](../reference/sandbox-providers.md#run-your-own-provider) |
| `--shared-execution-endpoint` | A long-lived shared execution environment, served by `supertag-shared-execution`, that several Cursor Sessions share (Cursor only) |

A Task that may run commands (`commands:execute`) runs them in its sandbox, so such a host needs
no `allow-unsandboxed-commands` (and cannot take it). The sandbox has no network access, DNS
included, and a Task with `web:search`, or with a `web:fetch` that has no
[network scope](../reference/iam.md#network-scopes), doesn't run on such a host. With a
local-vm, E2B, or Modal Workspace, a Task whose commands have a scoped `web:fetch` reaches the hosts it
allows: a relay in the sandbox carries each connection over the provider's command channel to
the Attempt's egress proxy on the Worker Host, and nothing else leaves the sandbox. Such a host can also take
`--network-credential`. Each
command stops at its own time limit inside the sandbox. Before the Workspace returns, SuperTag
stops every process the Task left running there. Files your ignore rules match, such as
`node_modules/`, and any `.git` directory a command creates stay in the sandbox and are not
returned; the Task output directory is always returned. A Task whose Permission Sets hide paths
can't run commands there, because the sandbox holds the whole checkout. A sandbox caps a
Task Attempt at 3600 seconds, the longest E2B and Modal grant. A Tag
requires a shared environment with `tag put --shared-execution-environment ID`. A repository's
`.devcontainer` settings choose the sandbox's image, user, and setup commands; see
[Devcontainer settings](../reference/devcontainer-subset.md).

## Optional: Skills

`skills` on a host service, or `--skill-catalog`, names a private allowlist of **Skills**,
reusable instruction packages that Context Sets select. A directory holds one directory per
Skill. A JSON catalog can also name Skills in a GitHub repository, fetched at an exact commit when
a Task needs one. See [Context and permissions](../concepts/context-and-permissions.md).

## Optional: MCP servers

`--mcp-catalog` names an owner-only JSON catalog of MCP servers that the Worklet offers Claude
Code Tasks. A Task sees a catalog tool only when its Permission Sets grant it. See
[MCP tools for GitHub, Slack, Linear, Teams, and Lark](../surfaces/worker-tools.md).

## Keep artifacts on Worker Hosts

Every artifact a Task captures, and every Workspace delivery's patch and bundle, stays on the
Worker Host that produced it, where its Worklet keeps them. The Control Plane stores and relays
none of them. By default the Worklet keeps them in
`STATE_DIRECTORY/artifacts`; `--artifact-directory` names another owner-only directory. Keep that
directory on persistent storage: losing it loses those artifacts and deliveries, unless an
artifact also has a Volume copy. On a host that does not last, such as a CI runner or one whose Tasks run
in Modal or E2B sandboxes, give its Tags a `volume`: every capture then gets a Volume copy, written
by the Worklet, before it succeeds. A file Volume also needs `--volume VOLUME_ID=DIRECTORY` on each
host that writes it. See [Keep every capture on a Volume](../reference/artifacts.md#keep-every-capture-on-a-volume).

A Task on another host reads a host's artifacts directly from that host's Worklet; the Control
Plane passes no files. Give the producing host's Worklet a transfer listener:

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory /var/lib/supertag-host --harness codex \
  --artifact-directory /var/lib/supertag-artifacts \
  --artifact-transfer-listen 0.0.0.0:8443 \
  --artifact-transfer-tls-cert transfer.pem --artifact-transfer-tls-key transfer.key
```

A consuming host pins each producing host to an origin with `--artifact-peer HOST_ID=ORIGIN`, and
trusts its CA with `--artifact-peer-ca-file`. See [Artifacts](../reference/artifacts.md).

## Drain, resume, and remove a host

```sh
supertag host drain build-1 --gateway team
supertag host resume build-1 --gateway team
supertag host revoke build-1 --gateway team
supertag host rotate-credential build-1 --gateway team --out build-1.credential
```

A draining host finishes its running Task Attempts and claims no new ones. Revoking a host refuses
its credential at once. `supertag down` drains this machine's hosts before stopping them.

A host keeps the only copy of the artifacts and Workspace deliveries it produced, so once it is
revoked they cannot be read, fetched, or continued from, unless their Tag keeps its captures on a
Volume; Workspace deliveries have no Volume copy. When you remove a
host service from `supertag.yaml` and revoke it, `supertag up` removes its state but keeps its
`artifacts` directory, and names it on every run until you delete it.

A host reads a few relayed files at once and queues the rest. When too many reads wait for one
host, a new read fails as busy rather than as offline; retry it.

## Recover an interrupted Task Attempt

A host restarted after it was killed checks the processes it recorded for an interrupted Task
Attempt. When all of them are gone, it records the Task Attempt as failed with an unknown outcome
and takes new work. Otherwise, and always for a Task Attempt that used a remote sandbox or shared
execution, an operator decides:

```sh
supertag task resolve-attempt TASK_ID ATTEMPT_ID --decision failed \
  --evidence "The sandbox was deleted; no commit was pushed." --confirmed-stopped \
  --gateway team
```

`--decision retry` runs the Task again. See [Scheduling and recovery](../reference/scheduling-and-recovery.md).

## Check that it worked

```sh
supertag get host --gateway team
supertag status
```

The host shows as connected and ready, with its harnesses and labels. Send its Tag a message and
confirm a reply.

## If something goes wrong

- **A Task stays queued.** Run `supertag placement explain TASK_ID`.
- **The host stops with a sign-in error.** Run `supertag sign-in HARNESS` as the host's user.
- **A Claude Code, Cursor, or OpenCode Task that may run commands stays queued.** Set
  `environment: local-vm` on the host, add the harness to
  `allow-unsandboxed-commands`, or run Tasks that do not need commands.
- **A Codex Task fails because its model needs Codex code mode to run commands.** Grant the Tag
  `web:fetch` and `files:write` as well as `commands:execute`, or select a Codex model that is not code-mode-only.
  `allow-unsandboxed-commands` does not apply to Codex. See
  [Codex commands and models](../operations/requirements.md#codex-commands-and-models).
- **A Cursor Task fails.** The result gives Cursor's reason, such as a model outside the
  account's plan. Choose a model the plan includes in `models`, or add credits. A result naming
  a failed `Worker Host call` means the harness adapter's call through its Worklet failed; check
  that host's log.

See [Troubleshoot the first reply](troubleshooting.md).

## Next

- [Work in a repository with Workspaces](workspaces.md)
- [Write a harness adapter](harness-adapters.md)
