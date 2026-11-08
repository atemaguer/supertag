# IAM and policy resolution

For a plain-language explanation of Tags and their security model, start with
[Tags](../concepts/tags.md). For execution terms, start with
[Workers and harnesses](../concepts/workers.md). This page is for developers implementing routing,
policy admission, collaboration surface actions, or Worker Tool Providers.

This page uses these SuperTag terms, each defined in the glossary: [Role](glossary.md#role),
[Objective](glossary.md#objective), [Team](glossary.md#team), [Workstream](glossary.md#workstream),
[Mailbox](glossary.md#mailbox), [Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt),
[Skill](glossary.md#skill), [Context Set](glossary.md#context-set),
[Permission Set](glossary.md#permission-set), [Control Plane](glossary.md#control-plane),
[Gateway](glossary.md#gateway), [Surface Account](glossary.md#surface-account),
[Worker Host](glossary.md#worker-host), [host service](glossary.md#host-service),
[Worker Profile](glossary.md#worker-profile), [Workspace](glossary.md#workspace),
[Runtime Input](glossary.md#runtime-input), and [Tool Provider](glossary.md#tool-provider).

SuperTag's IAM model treats a Tag as an accountable workload identity rather than equating it
with a model process, harness session, collaboration surface bot, or credential. Governance policy attaches to
that identity and is resolved before its work reaches execution.

## Identity and routing

A Tag is the persistent non-human workload principal. Collaboration surface bots/apps are provider-facing invocation identities; Surface Accounts are credential boundaries; Workers execute Tasks. None is the Tag itself.

An authenticated event resolves in this order:

1. identify provider, Surface Account, and canonical scope;
2. resolve the single enabled Tag route at that scope;
3. load the Tag and origin-specific activations;
4. capture immutable Context and authorization snapshots;
5. admit the Task.

A missing, disabled, or account-mismatched route fails before Task admission. Routes are internal
records behind the locations reported on a Tag; they are not public resources or identities.

## Authorization snapshot

The Task freezes:

- Tag ID and name;
- origin route, Surface Account, provider, and scope;
- requester identity;
- active Permission Sets and their approvers;
- explicit resource/action pairs;
- MCP server tools granted with `target: mcp`;
- granted actions marked `approval: required`, with the Permission Sets that require them;
- capture time.

The Worker receives this same snapshot. Later policy changes do not rewrite accepted work.

## Effective authorization

```text
origin-activated Permission Sets
  intersected with origin restrictions
  intersected with requester restrictions
  intersected with Worker Profile and installed-tool policy
  intersected with approvals
  intersected with native provider authorization
```

Everything outside the intersection is denied. Prompt wording, channel membership, or a broad installed credential cannot widen it.

## Approval

A permission can require a recorded decision before each use. Add `approval: required` to a
collaboration surface, runtime, or MCP permission. A Permission Set can also list `approvers`.

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: release-engineering
spec:
  approvers:
    - tag:release-manager
    - operator:release-oncall
  permissions:
    - target: surface
      surfaceAccountId: SURFACE_ACCOUNT_ID
      scope: repository:123456
      reference: acme/api
      action: pull-requests:create
    - target: mcp
      action: "github/merge_pull_request"
      resource: "repository:acme/api"
      approval: required
    - target: runtime
      action: commands:execute
```

### Precedence

Every active Permission Set applies: Permission Sets activated at the Tag's location and those of
its Roles. The result follows three rules, in order:

1. A missing grant denies. Permissions stay an allow-list, so an action no set grants is denied.
2. Any ask wins over allow. If one set grants an action with `approval: required`, the action
   needs approval even when another set grants it plainly.
3. Otherwise the grant allows the action.

The approvers of a request are the union of the approvers of the sets that require it.

### Approvers

| Entry | Who may decide |
| --- | --- |
| `operator:<operatorId>` | That operator, authenticated to the coordination API |
| `tag:<Tag name or ID>` | That Tag, in its own turn |

Without `approvers`, authorized operators decide. Listing only Tags adds Tag approvers; it
does not remove operator authority. Listing any operator restricts operator decisions to the
listed operators. A Tag never decides a request its own Task made.

### Where SuperTag checks approval

| Action | Check |
| --- | --- |
| Collaboration surface action through hosted MCP | The Worker-local policy proxy asks the Control Plane before forwarding each call |
| MCP server tool (`target: mcp`) | The Worker-local policy proxy asks the Control Plane before forwarding each call; see [MCP server tools](#mcp-server-tools) |
| Opening a Workspace pull request (`pull-requests:create`) | The Worker asks the Control Plane before pushing the Task branch; see [Workspaces](../guides/workspaces.md#deliver-pull-requests) |
| Shell commands and file writes inside a harness | Not checked per action yet; only through Task admission |

The Worker fails closed. A gated call without a reachable Control Plane is not forwarded. The
call returns "approval pending" with the request ID. Every turn except a conversation's own ends
waiting on that request, and the decision continues the Session as its next Task, unless the
Tag's permissions changed while it waited. A conversation's turn keeps going and tells the person.

A pending request expires when its Task finishes without waiting on it. A waiting Session's
request stays pending: its Task completed listing the request, and no later Task of that Session
started. See [a turn waiting on approval](coordination.md#a-turn-waiting-on-approval).

A decision chooses its scope:

| Scope | Effect |
| --- | --- |
| `once` | Allows one call with the same Task, action, and arguments digest. For a work Session, any Task of that work Session matches, so the retry in its next Task runs |
| `objective` | Allows every matching action in the Objective, optionally until a time |

An Objective-scope approval of a runtime action also admits later Tasks in that Objective
without holding them. See [Approval requests](coordination.md#approval-requests) for the
lifecycle.

## Current action vocabulary

| Collaboration surface | Actions |
| --- | --- |
| Lark / Feishu | `messages:read`, `messages:send`, `messages:reply` |
| GitHub Workspace source and delivery | `contents:read`, `pull-requests:create` |
| Linear | `issues:read`, `issues:create`, `comments:create` |
| Teams | `messages:read`, `messages:send`, `messages:reply` |

Runtime permissions use the same Permission Set but have a different target:

| Runtime action | Meaning |
| --- | --- |
| `commands:execute` | Use command or shell tools |
| `files:write` | Edit files in a writable Task workspace |
| `web:fetch` | Fetch a known web resource |
| `web:search` | Search the web |
| `browser:use` | Use browser or computer-control tools |

Custom Workers may define additional `namespace:action` names. Published actions should describe authority, not a particular harness API.

### Runtime actions in an Objective

An Objective stores the runtime actions its Tasks may receive. Without an explicit list, it gets
the actions its owner Tag's Permission Sets allow, resolved once at creation:

| Objective created | Default runtime actions |
| --- | --- |
| By an operator (`supertag create objective`, API) | Union across the owner's active Roles |
| From a collaboration thread (`@SuperTag objective`) | The invoking Task's: the Tag's Roles and the Permission Sets activated at that location |

An operator's explicit list narrows the default and never widens it. A Task in the Objective
receives the actions within the Objective's list and, for delegated work, within its delegating
Task's. Approval travels with the action: a Task waits when its own Permission Sets, or those of
the Task or owner it inherits the action from, mark it `approval: required`. See
[Objective runtime actions](coordination.md#objective-runtime-actions).

Prefer narrow operations over `read`, `write`, or `admin` labels.

## MCP server tools

A host service can provide MCP servers; see
[host MCP servers](supertag-yaml.md#host-mcp-servers). A Permission Set grants their tools with
`target: mcp`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: triage
spec:
  permissions:
    - { target: mcp, action: "sentry/get_issue_details" }
    - { target: mcp, action: "sentry/update_issue", approval: required }
    - { target: mcp, action: "notion/*" }
    - { target: mcp, action: "github/create_pull_request", resource: "repository:acme/api" }
```

| Field | Meaning |
| --- | --- |
| `action` | `server/tool`. The server is an exact server name. The tool is a tool name, or a pattern in which `*` matches any run of characters. |
| `resource` | Optional. Limits the grant to calls whose arguments name this resource, as `kind:value`. Allowed only for servers with a resource mapping. |
| `approval` | Optional `required`: each call waits for a recorded decision. See [Approval](#approval). |

Matching is exact and case-sensitive. `sentry/get_*` covers `get_issue` and `get_event`, but not
`Get_Issue` or `list_issues`. Server names never take a pattern. Tool names outside letters,
digits, `_`, `-`, and `.` never match any grant, so a look-alike name cannot stand in for a
granted tool.

### How the Worker enforces grants

When a Task Attempt starts, the Worker lists the tools of each granted server and keeps the
granted ones. The harness reaches the server only through the per-Task policy proxy on the Worker
Host. The harness's own MCP configuration is never read. For every call, the proxy checks in
order:

1. The tool is granted. Other tools are missing from `tools/list` and refused when called.
2. The resource. A grant without `resource` covers the tool on any resource. Otherwise the call's
   arguments must name exactly one resource, and a covering grant must name it.
3. Approval. When an `approval: required` grant covers the call, the proxy asks the Control Plane.
   A `once` approval covers only the same arguments, compared by their canonical JSON digest.

A refused call never reaches the server. The proxy fails closed: a call is refused when its
resource argument is missing, given twice with different values, padded, or contains the mapping's
separator. A gated call without a reachable Control Plane returns "approval pending". An approval
requirement limited to a resource also applies to a call whose resource the proxy cannot
determine.

### Resource mappings

A resource mapping tells the proxy which arguments of a tool name a resource. For example, a
mapping for `create_pull_request` might read the `owner` and `repo` arguments and build
`repository:OWNER/REPO`. Presets supply mappings for the providers SuperTag knows. A grant with
`resource` on a server without a mapping fails the Task Attempt before the harness starts. Resource
values compare exactly: `repository:ACME/api` does not match `repository:acme/api`.

### Placement

Which granted servers a Task needs depends on whether it has a Workspace:

| Task | Needs |
| --- | --- |
| With a Workspace, such as a work Session Task | Every server its grants name. A server comes from the host, which carries the label `mcp:NAME`, or from the Workspace's [`spec.mcp`](../guides/workspaces.md#select-repository-mcp-servers). |
| Without a Workspace, such as a conversation turn | Only the granted servers a bound Worker Host declares. |

A conversation turn stays light. A granted server that no bound host declares, such as one only a
Workspace's `.mcp.json` provides, is not available in that turn. Its grants are left out of the
Task Attempt, so the harness gets no tool for an absent server. The Tag's work Sessions that get
that Workspace use the server. A host server whose login lapsed still counts as declared, so the
turn waits for `supertag mcp login NAME`.

When no bound host provides a needed server, the Task waits. `supertag describe task` shows
`Waiting: no bound Worker Host provides MCP server NAME`. A Worker that receives a Task for a
server it cannot provide fails the Task Attempt before the harness starts.

## Tool resolution and adaptation

Permission Sets contain portable targets and actions. GitHub and Slack tools are MCP grants,
using the preset server names and the official tool names. For example,
`github/add_issue_comment` on `repository:acme/api` or `slack/slack_send_message` on
`channel:C0123456789`. The policy proxy checks each call's arguments and any required approval.
The Linear, Teams, and Lark presets map `team:ID`, `team:ID/channel:ID`, and `chat:ID` the same
way. See [MCP tools](../surfaces/worker-tools.md) for the full mappings.

GitHub Workspace source and pull-request delivery use separate Workspace permissions.

### Harness-native tools

Runtime actions are captured separately from collaboration surface resources in the immutable Task authorization snapshot. The harness adapter translates them at launch:

| Runtime action | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| no write permission | removes `Write` and `Edit` | read-only sandbox | read, grep, glob, ls, and MCP tools only |
| `files:write` | enables `Write` and `Edit` | workspace-write sandbox | adds edit |
| `commands:execute` | enables `Bash` | enables shell and unified execution features, and lets commands use loopback sockets | adds shell only with `files:write` and `allow-unsandboxed-commands: [cursor]`; otherwise refused |
| `web:fetch` | enables `WebFetch` | with `files:write`, enables sandbox network access | no native web tool |
| `web:search` | enables `WebSearch` | enables live web search | adds `webSearch` |
| `browser:use` | available only through an installed compatible tool | enables supported browser/computer-use features | no native browser tool |

### Cursor limits

Cursor can read outside the workspace and has no per-call approval. It refuses a repository or
Task Attempt home `.cursor/sandbox.json` at start. The agent can create that file during a run
and widen later shell decisions, so its sandbox is defense in depth, not command isolation.
See [Cursor setup and limits](../operations/requirements.md#cursor-setup-and-limits).

### Codex sandbox network

Many test suites start a local server on `127.0.0.1`. Codex's read-only and workspace-write
sandboxes deny every socket, so such a command fails with `listen EPERM 127.0.0.1`. When a Task
may run commands, the Codex Worker therefore allows loopback and nothing more:

| Admitted runtime actions | Files Codex may write | Network inside the sandbox |
| --- | --- | --- |
| neither `commands:execute` nor `web:fetch` | the workspace with `files:write`, otherwise none | none |
| `commands:execute` | the workspace with `files:write`, otherwise none | loopback only |
| `files:write` and `web:fetch` | the workspace | outbound network, as before |

For loopback, the Worker replaces Codex's `--sandbox` mode with a Worker-owned Codex permission
profile named `supertag`. The profile extends Codex's `:workspace` or `:read-only` profile, so
file access does not change. Its network section sets `allow_local_binding = true`. It also turns
on Codex's managed network proxy in `limited` mode with no allowed domains. Commands can bind,
accept, and connect on loopback. The sandbox still refuses direct external connections, and the
proxy refuses every external request. Codex also rejects commands that name an external host.
With the proxy on, Codex sets `HTTP_PROXY`, `HTTPS_PROXY`, and related variables inside commands.
Its `NO_PROXY` value keeps loopback addresses direct.

The profile also grants write access to the Task Attempt's output directory, so a Task with
`files:write` can still write its deliverables there.

Codex's `sandbox_workspace_write.network_access` setting is all-or-nothing, so it cannot express
loopback alone. In `sandboxMode: "external"`, Codex runs without its own sandbox, and the execution
environment's network policy applies instead.

The Worker records what the sandbox allows in the Task Attempt's Runtime Input Manifest, under
`harness.provenance.sandbox`. Run `supertag events task TASK_ID` and find the event whose type ends
in `runtime-inputs.resolved`. For a Task with `commands:execute` and `files:write`, it reads:

```json
{ "filesystem": "workspace-write", "network": "loopback", "permissionProfile": "supertag" }
```

`network` is `none`, `loopback`, `enabled`, or `external`. `filesystem` is `read-only`,
`workspace-write`, or `external`.

### Fail-closed behavior

Unknown runtime actions remain available to custom Workers but do not enable anything in the shipped harnesses. A harness must fail closed when it cannot enforce an admitted policy. Permission checks select tools; execution-environment isolation, filesystem mounts, and network policy provide the hard boundary.

### Failed write calls

If execution fails after a write call starts, the Control Plane marks the Task failed and does not
replay it automatically. The action may already have completed, so an operator must reconcile the
provider before manually retrying. Worker-managed adapters can provide stronger idempotency with
the SDK's durable effect journal.

### Unsandboxed harnesses

Codex enforces the [harness-native tools](#harness-native-tools) runtime actions inside its
operating-system sandbox. Claude Code, OpenCode, and Cursor on a host service do not provide an
enforced command boundary: their shell
tools run commands as the Worker Host's user. SuperTag therefore places a
Task with `commands:execute` on them only when the host service lists them in
`allow-unsandboxed-commands`. Otherwise the Task goes to a Worker that may run commands, such as
Codex, or waits with a reason naming that setting. See
[Unsandboxed harnesses](supertag-yaml.md#unsandboxed-harnesses).

`files:write` alone needs no opt-in. The harness writes files through its own file tools, inside
the Task's worktree, and those tools run no program. A file written there can still be run later,
by a Task with `commands:execute` or by you, so review delivered changes before running them.

Each Worker Profile reports this with two capabilities. `supertag.commands.unsandboxed` means its
harness runs commands without a sandbox. `supertag.commands.execute` means it may run Tasks with
`commands:execute`. Placement requires the second on a host whose profiles report either one;
hosts that report neither, such as custom Workers, are not checked. Like labels, these capabilities
are self-reported and decide placement, never access.

## Credential boundaries

[Credential storage](credential-storage.md) is the canonical reference for each credential
boundary.

- Gateway credentials receive events and deliver replies.
- Worker credentials authenticate harness tools and request-selected resources.
- Authorization snapshots contain identifiers and policy, never credentials.
- collaboration surface MCP traffic stays outside the collaboration Gateway. Hosted HTTP calls pass through a Task-scoped policy proxy on the Worker Host before reaching the official provider server.

Tool allowlists constrain operations; provider-owned resource policies constrain call arguments. When an operation cannot expose a verifiable resource, the built-in harnesses reject it rather than trusting prompt instructions. Native installations and tokens should still be no broader than the permitted repository, channel, or team envelope.

## Security invariants

- Tags do not impersonate invoking humans.
- A configured location grants no general provider authority; an accepted inbound request supplies
  only its originating interaction lifecycle.
- Same-Session continuity is automatic; cross-Session sharing requires Context policy.
- Context Sets never create provider authority.
- Permission Sets never add content or Skills.
- Reading, disclosing, and modifying data are distinct capabilities.
- Cross-Tag context is denied even when Tags share accounts or Workers.
- Worker Hosts contain the secret and isolation boundary used by their Workers.

## Explicit internal messaging

[Tag messaging](../guides/tag-messaging.md) permits selected, application-supplied message
bodies to cross Tag boundaries under an explicit directional grant. This does not relax
Context Set isolation or give a recipient access to another Tag's artifacts. A messaging
grant authorizes delivery, not the requested action. The recipient application must apply
its own execution and disclosure policies. The trusted Worker host holds a Tag-scoped
credential; sender identity is never accepted from model-written message fields. A message is
plain text and grants no authority. Tags in one Team message each other without a grant. Grant
rules are in [Mailbox](coordination.md#mailbox).

Team membership permits reading and posting to the Team's Workstream. This does not expand
Context Set access, native provider permissions, or messaging grants, and a post carries no
authority. See [Workstream](coordination.md#workstream).

Objectives use the experimental [Objective API](../../spec/objectives.md). A Tag reads the
Objectives it owns and those whose Team it belongs to; only the owner or an operator changes an
Objective's status. See [Objectives](coordination.md#objectives).
