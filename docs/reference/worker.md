# Worker Host reference

The exact behavior of a **Worker Host**, the process that connects a machine or sandbox to the
**Control Plane** and runs **Task Attempts**, and of the **harness adapters** it starts. For the
ideas, read [Worker Hosts and harnesses](../concepts/workers.md); to run one, read
[Run Worker Hosts](../guides/workers.md). Other terms are in the [glossary](glossary.md).

## Boundary

| The Worker Host owns | The Control Plane owns |
| --- | --- |
| Harness sign-ins, MCP credentials, and Volume keys on this machine | Tags, policy, admission, and the accepted Task |
| Workspace checkouts and the Task Attempt's files | Scheduling, leases, and recovery decisions |
| The execution journal and captured artifact bytes | The artifact catalog, events, results, and audit |
| Supervising adapter processes | Which hosts may run which Tags |

A Worker Host never receives the database credential, a Gateway's surface credentials, or another
host's credential. A harness adapter receives only its own harness's provider credentials and a
bootstrap token scoped to one Task Attempt.

## Enrollment and credentials

A host enrolls once, with a host Auth Key, under a name that is never reused: `host:NAME`. It
keeps its credential in its state directory. A reusable key that finds the name taken enrolls the
host as `NAME-2`, `NAME-3`, and so on. A key created with `--ephemeral` removes its hosts once they
go offline, and their running Task Attempts return to the queue. `host rotate-credential` replaces
the credential; `host revoke` refuses it at once.

## Placement

A host reports its harnesses, its models per harness, its labels, its concurrency, and its
Workspace mappings. The Control Plane offers a Task only to a host that:

- may run the Task's Tag, from its Auth Key's `--tag` list or `--all-tags`, or because it is a
  host in the same `supertag.yaml` as its local Control Plane;
- carries every label in the Tag's `runsOn`;
- serves the Task's harness and model, and the limits the Task requires;
- maps the Tag's Workspace, and any Workspace Volume the Task copies;
- is ready and not draining.

`supertag placement explain TASK_ID` reports which of these keeps a Task queued.

## Claims and leases

A host claims a Task and holds a lease on its Task Attempt, renewed while the Task Attempt runs. The
lease is fenced by the Task Attempt's generation: a host that lost its lease cannot record events,
results, or deliveries for it. A Task Attempt may run for `--attempt-timeout-seconds`, 3600 by
default and at most 86400; a host whose Workspace runs in an E2B or Modal sandbox accepts at most
3600 and stops the harness early enough to leave time for capture and cleanup.

## The execution journal

Before each step with an effect outside the host, the host records it in its journal: claiming,
preparing the checkout, running, capturing artifacts, delivering, and finalizing. A restarted host
reads the journal and finishes or reports what it started, without running a step twice.

A host restarted after it was killed checks the processes it recorded for an interrupted Task
Attempt. When every one is gone, it records the Task Attempt as failed with an unknown outcome and
does not run it again. Otherwise, and always for a Task Attempt that used a remote sandbox or
shared execution, it waits for `supertag task resolve-attempt`. With `--wait-for-recovery`, the
host stays connected while it waits. See [Scheduling and interrupted execution](scheduling-and-recovery.md).

## Process supervision

The host starts each adapter in its own process group and stops the group when the Task Attempt
is cancelled, times out, or ends. On Linux it is a child subreaper, so processes that leave the
adapter's group are still found and stopped. On macOS it finds such processes with a scan every
100 milliseconds; a process that detaches with a double fork within one scan interval can escape.
Use an isolated Linux host, container, or VM when that matters. Work started through an
already-running daemon, such as a tmux server or `ssh localhost`, also escapes supervision.

## Execution limits

A Task may require limits; a host that cannot enforce one does not claim the Task.

| Limit | Set with | Enforced by |
| --- | --- | --- |
| Reported tokens | `task submit --max-reported-tokens` | Codex: the adapter interrupts the turn when reported usage reaches it. Reports arrive after use, so usage can overshoot |
| Reported cost | `--max-reported-cost-minor` with `--reported-cost-currency` | Claude Code: the provider's own budget, in USD |
| Native agents and work Sessions | `--max-native-agents` | The adapter |

An Objective with a budget caps each of its turns at what its budget has left. Reported tokens
are not a billing cap. See [Budgets and allocation](coordination.md#budgets-and-allocation).

## Built-in harnesses

| Harness | Adapter | Credentials it receives | Commands |
| --- | --- | --- | --- |
| `codex` | Built into `supertag`; drives Codex's app-server | `CODEX_API_KEY`, `OPENAI_API_KEY`, and a copy of a file-backed sign-in | In Codex's sandbox, writable only in the checkout and read-write Workspace Volume copies |
| `claude-code` | Node bridge on the Claude Agent SDK | `ANTHROPIC_API_KEY` or the host user's sign-in | In Claude Code's sandbox, with a permission hook for file roots |
| `cursor` | Node bridge on the Cursor SDK | `CURSOR_API_KEY` | Without a sandbox, only with `--allow-unsandboxed-commands`; or in an E2B, Modal, or shared execution environment |
| `opencode` | Node bridge | The selected provider's API key, or `--opencode-auth-file` | Without a sandbox, only with `--allow-unsandboxed-commands` |
| `openai-agents` | The `supertag` Python package | `OPENAI_API_KEY` | The tools the Task's permissions allow |

`supertag sign-in HARNESS` checks a harness's credentials the way a host uses them, and
`supertag init` runs the same check.

## Workspaces

A Tag's Workspace is a repository the host maps: a local Git source
(`--workspace-id ID --workspace-source PATH`, or `workspaces` in `supertag.yaml`), or a GitHub
source the Control Plane holds (`--workspace-from-control-plane`). Each Task Attempt runs in its
own checkout pinned to an exact commit. The host's own Git commands never run repository hooks,
filters, or configuration a Task wrote, and the host fails a Task Attempt whose repository Git
configuration changed while it ran.

`--workspace-setup ID=COMMAND`, or `setup` in a `supertag.yaml` Workspace, runs a shell command
such as `npm ci` in each new checkout before the harness starts. It runs on the host, outside any
harness sandbox, with a 10-minute limit, and receives no provider credentials.

### Delivery

After the harness finishes, the host commits the Task's changes and verifies them. It records the
result as a Git bundle, with the ref `refs/heads/supertag-deliveries/DELIVERY_ID`, and a patch. It
never writes your repository. Your machine imports the delivery as the branch
`supertag/session/SESSION`, one branch per Session that each later Task advances:

- `supertag up` imports deliveries for every Workspace its `supertag.yaml` maps, unless the
  Workspace sets `delivery: patch`.
- `supertag fetch TASK_OR_SESSION_ID --repository PATH` imports one into any clone.
- `supertag task download TASK_ID --kind patch|bundle --output FILE` saves the file.

A Task with no commits delivers nothing. For GitHub Workspaces, `github-publication` commands
follow and stop publication of verified results.

### Workspace Volumes

A Tag may copy data from a **Volume**, a registered directory or S3 prefix, into its Tasks:
`supertag workspace-volume put` registers it, `tag put --workspace-mounts` binds it, and each
serving host maps it with `--workspace-mount-mappings`. A read-only copy is staged before the
harness starts and removed afterwards. A read-write copy requires `files:write`; after a
successful Task Attempt the host writes changed and created files back to the Volume, never
deletions or links, and records a summary on the Task. Copies serve local Codex and Claude Code
Tasks that do not run commands or fetch from the web.

## Remote sandboxes and shared execution

A Cursor Task can keep its files and commands in an E2B or Modal sandbox
(`--e2b-workspace-provider`, `--modal-workspace-provider`) while the harness and its credentials
stay on the host. Only the checkout moves into the sandbox; keys never do. A repository's
`.devcontainer` settings choose the sandbox image, user, and setup; see
[Devcontainer settings](devcontainer-subset.md).

A shared execution environment, served by `supertag-shared-execution`, holds one workspace that
several Cursor Sessions use. The host connects with `--shared-execution-endpoint` and
`SUPERTAG_EXECUTION_ADMIN_TOKEN`. `--shared-execution-commands` allows lease-bound commands on a
Linux provider that runs them as its configured workload user.

## Skills and MCP servers

A host's Skill catalog (`--skill-catalog`) is the allowlist of Skills a Task may load; a GitHub
catalog entry is pinned to the commit a new Task first resolves, and its retries keep it. A host's
MCP catalog (`--mcp-catalog`) lists HTTP and stdio servers for Claude Code Tasks, with presets for
GitHub, Slack, Linear, Microsoft Teams, and Lark. A Task sees a catalog tool only when its
Permission Sets grant it, and calls that require approval wait in the operator inbox. An OAuth
server's login lives on the host: `supertag mcp login NAME`. A Workspace's own `.mcp.json` servers
run only when the Tag lists them with `--workspace-mcp`.

## Artifacts

A Task captures files as artifacts. The host keeps their bytes in its state directory, and the
Control Plane records only the catalog. Other hosts read a host's artifacts through its transfer
listener (`--artifact-transfer-listen`), pinned by `--artifact-peer HOST_ID=ORIGIN`. See
[Artifacts](artifacts.md).

## Next

- [Write a harness adapter](../guides/harness-adapters.md)
- [CLI reference: `supertag worker-host`](cli.md#supertag-worker-host)
