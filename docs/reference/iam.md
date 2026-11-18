# IAM and policy resolution

For a plain-language explanation of Tags and their security model, start with
[Tags](../concepts/tags.md). For execution terms, start with
[Worker Hosts and harnesses](../concepts/workers.md). This page is for developers implementing
routing, policy admission, collaboration surface actions, or harness adapters.

This page uses these SuperTag terms, each defined in the glossary: [Role](glossary.md#role),
[Objective](glossary.md#objective), [Team](glossary.md#team), [Workstream](glossary.md#workstream),
[Mailbox](glossary.md#mailbox), [Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt),
[Skill](glossary.md#skill), [Context Set](glossary.md#context-set),
[Permission Set](glossary.md#permission-set), [Control Plane](glossary.md#control-plane),
[Gateway](glossary.md#gateway), [Surface Account](glossary.md#surface-account),
[Worker Host](glossary.md#worker-host), [host service](glossary.md#host-service),
and [Workspace](glossary.md#workspace).

SuperTag's IAM model treats a Tag as an accountable workload identity rather than equating it
with a model process, harness session, collaboration surface bot, or credential. Governance policy attaches to
that identity and is resolved before its work reaches execution.

## Identity and routing

A Tag is the persistent non-human workload principal. Collaboration surface bots/apps are provider-facing invocation identities; Surface Accounts are credential boundaries; Worker Hosts execute Tasks. None is the Tag itself.

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
- granted actions marked `approvalRequired: true`, with the Permission Sets that require them;
- capture time.

The Worker Host receives this same snapshot. Later policy changes do not rewrite accepted work.

## Effective authorization

```text
origin-activated Permission Sets
  intersected with origin restrictions
  intersected with requester restrictions
  intersected with the Worker Host's harness and installed-tool policy
  intersected with approvals
  intersected with native provider authorization
```

Everything outside the intersection is denied. Prompt wording, channel membership, or a broad installed credential cannot widen it.

## Approval

A permission can require a recorded decision before each use. Add `approvalRequired: true` to a
collaboration surface, runtime, or MCP permission. A Permission Set can also list `approvers`.

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: release-engineering
spec:
  approvers:
    - operator:release-oncall
  permissions:
    - target: mcp
      action: "github/merge_pull_request"
      resource: "repository:acme/api"
      approvalRequired: true
    - target: runtime
      action: commands:execute
```

### Precedence

Every active Permission Set applies: Permission Sets activated at the Tag's location and those of
its Roles. The result follows three rules, in order:

1. A missing grant denies. Permissions stay an allow-list, so an action no set grants is denied.
2. Any ask wins over allow. If one set grants an action with `approvalRequired: true`, the action
   needs approval even when another set grants it plainly.
3. Otherwise the grant allows the action.

The approvers of a request are the union of the approvers of the sets that require it.

### Approvers

| Entry | Who may decide |
| --- | --- |
| `operator:<operatorId>` | That operator, authenticated to the Control Plane's operator RPCs |
| `client:<name>` | That client device, enrolled with a client Auth Key. Only for `workstream:post` and `mailbox:send` |

A Permission Set that names a Tag (`tag:<id>`) as an approver is refused: approval is a person's
check on a Tag's work, so no Tag decides one.

Without `approvers`, any authorized operator decides, and no client does. Listing operators
restricts the decision to them. A gate must name at least one operator: a gated MCP tool call
whose approvers name none is denied, a gated Workspace pull request accepts only operator
approvers, and a gated runtime action whose approvers name none is not admitted.

### Where SuperTag checks approval

| Action | Check |
| --- | --- |
| MCP server tool (`target: mcp`), including collaboration surface tools | The Worker Host's policy proxy asks the Control Plane before forwarding each call; see [MCP server tools](#mcp-server-tools) |
| Posting to a Workstream or sending a Mailbox message (`workstream:post`, `mailbox:send`) | The harness's coordination tool asks the Control Plane before each post or message |
| Other runtime actions, such as shell commands and file writes | Not checked per call; only through Task admission. A Task never receives one of these that requires approval |

The Worker Host fails closed. A gated call without a reachable Control Plane is not forwarded. The
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
| `objective` | Allows the same Tag's later requests for the same action and resource in the Objective, optionally until a time |

An Objective-scope approval also covers later Tasks in that Objective. See [Approval requests](coordination.md#approval-requests) for the
lifecycle.

## Current action vocabulary

A remote Workspace needs no Permission Set: binding a Tag to it lets the Tag's Tasks read it, and
the Workspace's `land` setting, which an operator declares, decides where changes go. See
[Landing](resource-model.md#landing).

Tools on Slack, GitHub, Linear, Microsoft Teams, and Lark are MCP server tools, granted with
`target: mcp`; see [Tool resolution and adaptation](#tool-resolution-and-adaptation).

Runtime permissions use the same Permission Set but have a different target:

| Runtime action | Meaning |
| --- | --- |
| `files:read` | Read files in the Task workspace |
| `files:write` | Edit files in a writable Task workspace |
| `commands:execute` | Use command or shell tools |
| `files:delegate-write` | Let an Objective's owner delegate writes to a Team member whose Role grants `files:write` |
| `web:fetch` | Fetch a known web resource |
| `web:search` | Search the web |
| `browser:use` | Use browser or computer-control tools. No built-in harness supports it yet |
| `schedule:create` | Set and cancel [Schedules](coordination.md#schedules), wake-ups for the Tag itself, with the `schedule` and `cancel_schedule` tools |

`schedule:create` is an ordinary runtime action. Add `schedule:create` to a Permission Set to let
a Tag schedule; Tags created by `supertag init`, the desktop app, or the terminal UI have it. A
Tag without it cannot schedule. It offers only SuperTag's own tools, never a harness tool.

Other `namespace:action` names can be stored but enable nothing in the built-in harnesses. Published actions should describe authority, not a particular harness API.

### Runtime actions in an Objective

An Objective stores the runtime actions its Tasks may receive. Without an explicit list, it gets
the actions its owner Tag's Permission Sets allow, resolved once at creation:

| Objective created | Default runtime actions |
| --- | --- |
| By an operator (`supertag objective create`, API) | Union across the owner's active Roles |
| From a collaboration thread (`@SuperTag /goal`) | The invoking Task's: the Tag's Roles and the Permission Sets activated at that location |

An operator's explicit list narrows the default and never widens it. A Task in the Objective
receives the actions within the Objective's list and, for delegated work, within its delegating
Task's. Approval travels with the action: the action stays gated when the Task's own Permission
Sets, or those of the Task or owner it inherits the action from, mark it `approvalRequired: true`. See
[Objective runtime actions](coordination.md#objective-runtime-actions).

When the Objective and the delegating Task include `files:delegate-write`, a different Team
member can use its own `files:write` permission in the delegated Session. The grant gives
the lead no direct write access. An approval rule on the grant applies to the delegated write.

Prefer narrow operations over `read`, `write`, or `admin` labels.

## MCP server tools

A host service can provide MCP servers; see
[host MCP servers](../surfaces/worker-tools.md). A Permission Set grants their tools with
`target: mcp`:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata:
  name: triage
spec:
  permissions:
    - { target: mcp, action: "sentry/get_issue_details" }
    - { target: mcp, action: "sentry/update_issue", approvalRequired: true }
    - { target: mcp, action: "notion/*" }
    - { target: mcp, action: "github/create_pull_request", resource: "repository:acme/api" }
```

| Field | Meaning |
| --- | --- |
| `action` | `server/tool`. The server is an exact server name. The tool is a tool name, or a pattern in which `*` matches any run of characters. |
| `resource` | Optional. Limits the grant to calls whose arguments name this resource, as `kind:value`. Allowed only for servers with a resource mapping. |
| `approvalRequired` | Optional `true`: each call waits for a recorded decision. See [Approval](#approval). |

Matching is exact and case-sensitive. `sentry/get_*` covers `get_issue` and `get_event`, but not
`Get_Issue` or `list_issues`. Server names never take a pattern. Tool names outside letters,
digits, `_`, `-`, and `.` never match any grant, so a look-alike name cannot stand in for a
granted tool.

### How the Worker Host enforces grants

When a Task Attempt starts, the Worker Host lists the tools of each granted server and keeps the
granted ones. The harness reaches the server only through the per-Task policy proxy on the Worker
Host. The harness's own MCP configuration is never read. For every call, the proxy checks in
order:

1. The tool is granted. Other tools are missing from `tools/list` and refused when called.
2. The resource. A grant without `resource` covers the tool on any resource. Otherwise the call's
   arguments must name exactly one resource, and a covering grant must name it.
3. Approval. When an `approvalRequired: true` grant covers the call, the proxy asks the Control Plane.
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
| With a Workspace, such as a work Session Task | Every server its grants name. A server comes from the host, which carries the label `mcp:NAME`, or from the Workspace's `.mcp.json` servers the Tag lists in [`workspace.mcp`](../guides/workspaces.md#select-repository-skills-and-mcp-servers). |
| Without a Workspace, such as a conversation turn | Only the granted servers a bound Worker Host declares. |

A conversation turn stays light. A granted server that no bound host declares, such as one only a
Workspace's `.mcp.json` provides, is not available in that turn. Its grants are left out of the
Task Attempt, so the harness gets no tool for an absent server. The Tag's work Sessions that get
that Workspace use the server. A host server whose login lapsed still counts as declared, so the
turn waits for `supertag mcp login NAME`.

When no bound host provides a needed server, the Task waits. `supertag describe task` shows
`No bound Worker Host provides MCP server NAME` as the reason it waits. A Worker Host that receives a Task for a
server it cannot provide fails the Task Attempt before the harness starts.

## Tool resolution and adaptation

Permission Sets contain portable targets and actions. GitHub and Slack tools are MCP grants,
using the preset server names and the official tool names. For example,
`github/add_issue_comment` on `repository:acme/api` or `slack/slack_send_message` on
`channel:C0123456789`. The policy proxy checks each call's arguments and any required approval.
The Linear, Teams, and Lark presets map `team:ID`, `team:ID/channel:ID`, and `chat:ID` the same
way. See [MCP tools](../surfaces/worker-tools.md) for the full mappings.

### Harness-native tools

Runtime actions are captured separately from collaboration surface resources in the immutable Task authorization snapshot. The harness adapter translates them at launch:

| Runtime action | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| `files:read` | enables `Read`, `Glob`, and `Grep` | read-only sandbox | read, grep, glob, ls, and MCP tools |
| no write permission | removes `Write` and `Edit` | read-only sandbox | no edit tool |
| `files:write` | enables `Write` and `Edit` | Workspace writes in the `supertag` permission profile | adds edit |
| `commands:execute` | enables `Bash` only with `allow-unsandboxed-commands: [claude-code]`; with a local-vm, E2B, or Modal Workspace, adds the sandbox's command tool instead; otherwise a Claude Code host does not run the Task | enables shell and unified execution features, and lets commands use loopback sockets. A code-mode-only model, which is every current Codex model, runs commands only when the Task also has `web:fetch`; see [Codex commands and models](../operations/requirements.md#codex-commands-and-models) | adds shell only with `files:write`, and locally only with `allow-unsandboxed-commands: [cursor]`; with an E2B or Modal Workspace, commands run in the sandbox; otherwise the Task waits |
| `web:fetch` | enables `WebFetch` | requires `files:write`; enables outbound network in the `supertag` permission profile, for commands too, limited to the Task's [network scope](#network-scopes) | not supported: the Task waits |
| `web:search` | enables `WebSearch` | enables live web search | adds `webSearch` |
| `browser:use` | not supported | not supported | not supported: the Task waits |

`files:write` or `commands:execute` also gives a Codex Task read access. A Codex Task with none of
`files:read`, `files:write`, and `commands:execute` fails, because Codex reads the Workspace in
every sandbox mode. A harness adapter that receives an action it cannot enforce fails the Task
Attempt before the harness starts.

### Cursor limits

Cursor can read outside the workspace and has no per-call approval. The agent can change
Cursor's own sandbox configuration during a run and widen later shell decisions, so its sandbox
is defense in depth, not command isolation.
See [Cursor setup and limits](../operations/requirements.md#cursor-setup-and-limits).

### Codex sandbox network

Many test suites start a local server on `127.0.0.1`. Codex's read-only and workspace-write
sandboxes deny every socket, so such a command fails with `listen EPERM 127.0.0.1`. When a Task
may run commands, the Codex adapter therefore allows loopback and nothing more:

| Admitted runtime actions | Files Codex may write | Network inside the sandbox |
| --- | --- | --- |
| neither `commands:execute` nor `web:fetch` | the workspace with `files:write`, otherwise none | none |
| `commands:execute` without `web:fetch` | the workspace with `files:write`, otherwise none | loopback only |
| `files:write` and `web:fetch` | the workspace | outbound network |

Every Codex Task with `files:write`, `commands:execute`, or a path scope runs under a
SuperTag-owned Codex permission profile named `supertag`, in place of Codex's `--sandbox` mode.
The profile extends Codex's `:workspace` or `:read-only` profile and adds the same filesystem
rules whatever the network access: [Git metadata](#git-metadata-stays-read-only), Volume copies,
and the Task's [path scope](#path-scopes).

For loopback, the profile's network section sets `allow_local_binding = true`. It also turns
on Codex's managed network proxy in `limited` mode with no allowed domains. Commands can bind,
accept, and connect on loopback. The sandbox still refuses direct external connections, and the
proxy refuses every external request. Codex also rejects commands that name an external host.
With the proxy on, Codex sets `HTTP_PROXY`, `HTTPS_PROXY`, and related variables inside commands.
Its `NO_PROXY` value keeps loopback addresses direct.

With `web:fetch`, the profile's network section turns network access on in `full` mode and the
managed proxy off, so commands connect to external hosts directly, as well as on loopback. A
[network scope](#network-scopes) that limits hosts or methods changes this; see
[Network scope enforcement](#network-scope-enforcement).

The profile also grants write access to the Task Attempt's output directory, so a Task with
`files:write` can still write its deliverables there.

### Git metadata stays read-only

SuperTag runs `git` in a Workspace outside any sandbox, for example to list changed paths and to
capture a delivery. A Task therefore never writes the Workspace's Git metadata. Otherwise it could
set a hook, an fsmonitor, or a filter that SuperTag would then run on the Worker Host.

The `supertag` profile grants read-only access to:

- the Workspace's `.git`, whether it is a directory or a linked worktree's `gitdir:` file. When
  there is no `.git`, the grant also stops a command from creating one.
- the Workspace's `.codex`, `.agents`, and `.aws`, which Codex's built-in profiles also protect.
- the Git directory a `gitdir:` file names, and a linked worktree's common Git directory.
- the same four entries in each read-write Volume copy.

Codex protects these entries in its built-in profiles. A profile that extends `:workspace` loses
that protection when the Workspace sits under another writable root, such as `/tmp` or
`$TMPDIR`. The grants are therefore always explicit, with or without `web:fetch`. Codex's
`apply_patch` tool refuses `.git` and paths outside the writable roots on its own.

Claude Code's, OpenCode's, and Cursor's file tools refuse a write to any `.git` path in the
worktree or a Volume copy, in any letter case, since macOS treats `.GIT` as `.git`. Cursor's
file tools are SuperTag's own, and its native sandbox never sees the Workspace. Their commands,
which need `allow-unsandboxed-commands`, can still write anything the Worker Host's user can.

SuperTag's own Git commands on a Workspace also run nothing the repository configures. They turn
off hooks, fsmonitor, the pager, external diff, and the `ext` transport. Before reading a
checkout, the Worker Host refuses one whose Git configuration changed, or whose Git directory
names another common directory. It never follows a `.git` file to a Git directory elsewhere.

### Path scopes

A path scope narrows a Permission Set's file grants to parts of the Task's Workspace. For
example, a Builder Role may write only `src/` and `tests/`, never read `.env` files, and let
commands write pip's cache. Path scopes live only in Permission Sets. A Tag's own
`allowedActions` stay whole-Workspace.

A runtime `files:write` or `files:read` permission takes three optional fields:

| Field | On `files:write` | On `files:read` |
| --- | --- | --- |
| `paths` | Workspace directories or exact files the Task may write. Omitted: the whole Workspace | Not allowed yet. Reads cover the whole Workspace except `exclude` |
| `exclude` | Workspace paths that stay readable but are never written | Workspace paths that are neither read nor written. Only here may an entry be a glob: `*`, `**`, and `?` |
| `additionalDirectories` | Directories outside the Workspace that are writable | Directories outside the Workspace that are readable |

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: app-code }
spec:
  permissions:
    - target: runtime
      action: files:write
      paths: [src/, tests/]
      exclude: [src/generated/]
      additionalDirectories: ["~/.cache/pip"]
    - target: runtime
      action: files:read
      exclude: ["**/.env", "**/.env.*", secrets/]
    - { target: runtime, action: commands:execute }
```

Entries follow these rules:

- Workspace entries are relative to the Workspace root and anchored there. `.env` names only the
  top-level file; `**/.env` names one at any depth. An entry names a file or a whole directory.
  `src/**` means `src/`.
- `paths` and `files:write` `exclude` entries are literal: no globs.
- An entry may not contain `..` or `.` segments, a backslash, or a control character. Each field
  holds at most 64 entries of at most 1024 bytes.
- `additionalDirectories` entries are absolute or start with `~/`, the only place `~` is allowed.
  `~` is the Worker Host user's home directory. The directory must exist on the Worker Host, or
  the Task Attempt fails before the harness starts.
- `~`, `/`, `~/.supertag`, and directories that hold SuperTag or harness state or credentials
  are refused, for example `~/.codex`, `~/.claude`, `~/.config/opencode`, and `~/.ssh`. So is a
  directory that contains one of them, such as `~/.config`. The Worker Host also refuses an
  entry that overlaps the Workspace or the harness's private home.
- A path scope never makes a protected entry writable. `paths` may not name `.git`, `.codex`,
  `.agents`, `.aws`, `.claude`, `.cursor`, `.opencode`, or `.supertag`, in any letter case. An
  `exclude` may name them: `exclude: [.git/]` on `files:read` hides history from the agent.

`supertag apply` and `supertag diff` refuse an invalid entry and say why.

### Combining path scopes

Every Permission Set a Task receives applies. SuperTag unions the grants. A `files:write` grant
without `paths`, including a Tag's own `files:write`, makes the whole Workspace writable.
Precedence is: a `files:read` exclude (hidden) beats a `files:write` exclude (read-only), which
beats `paths`. A set that only hides, such as `{ action: files:read, exclude: [secrets/] }`, adds
no access of its own, so you can attach it to every Role.

Hidden and read-only entries match in any letter case, because macOS opens `SECRETS/x` as
`secrets/x`. `paths` match exactly. Each path is checked after symlinks resolve, so a link
cannot reach a hidden or read-only file.

A Task keeps the scope recorded when SuperTag accepted it. `supertag describe task` shows it
under `file_scope`, for example
`Writes src/, tests/, ~/.cache/pip · Read-only src/generated/ · Hidden **/.env, secrets/`. When
an Objective owner delegates a write, the member writes within its own `paths`, and both Tags'
exclusions apply.

Path scopes govern the agent's tools and commands, not the harness itself. The harness's private
home, the Task Attempt's output directory, Skill files, Volume copies, and the temporary
directory keep their usual access.

### Path scope enforcement

A harness enforces a scope at one of three strengths:

| Strength | Meaning |
| --- | --- |
| operating system | The kernel refuses the access, for commands and file tools alike |
| tool | SuperTag or the harness refuses the file-tool call. Commands are not confined |
| delivery | The Worker Host refuses to deliver Workspace changes outside the write scope |

| Harness | File tools | Commands |
| --- | --- | --- |
| Codex | operating system: the `supertag` permission profile | operating system, with or without `web:fetch` |
| Claude Code | tool: SuperTag's file-tool hook and Claude Code's own deny rules | write scope at delivery; hidden entries not enforced, so such a Task waits |
| OpenCode | tool: OpenCode's `edit` and `read` rules | write scope at delivery; hidden entries not enforced, so such a Task waits |
| Cursor, remote or shared execution | tool: SuperTag's Workspace tools | write or hidden scope not enforced, so such a Task waits |
| Cursor, local | not supported yet: a scoped Task waits | — |

SuperTag works out the strength a Task needs. It never asks you to declare one:

- Commands with hidden entries need the operating system. Only Codex qualifies today.
- Commands with `paths` or a `files:write` exclude need delivery, so the Task needs a Workspace.
- Without `commands:execute`, every harness above except local Cursor applies the scope with its
  file tools.
- Cursor cannot grant `additionalDirectories`. Custom harnesses cannot apply any scope.

A Task no host can run waits. `supertag placement explain TASK` names the `file-scope`
requirement and why, for example:

```text
Claude Code cannot keep commands from reading hidden paths (**/.env); run the Tag on Codex, or
remove commands:execute from its Permission Sets
```

### Path scope delivery check

When a Task Attempt completes, the Worker Host checks every Workspace path it added, changed, or
deleted. A path outside `paths`, in a read-only entry, or hidden fails the Task Attempt. Its
result names the paths, at most 20. Nothing is delivered. This check covers commands and any
harness tool. It does not stop a change that is undone before the Task Attempt ends, or a write
outside the Workspace.

### Path scope limits

- Codex on Linux matches hidden globs against the files that exist when it starts. A checked-in
  `.env` stays hidden; a matching file the agent creates later is not. Prefer literal hidden
  entries for paths an agent might create.
- Codex on Linux also cannot hide a literal path that does not exist yet under a write path, such
  as `src/secret` with `paths: [src/]`. The agent may create it and read what it wrote; the
  delivery check still refuses to deliver it. On macOS such a path stays hidden.
- Codex on Linux cannot start its sandbox when a hidden glob matches a path inside a hidden
  directory, for example `secrets/` and `**/.env` with a `secrets/.env`. The Task Attempt fails;
  nothing is exposed. Hide the directory alone, or narrow the glob.
- A hard link reaches a file through a different name. On macOS, Codex's sandbox refuses to
  link a hidden file. A harness without that boundary could link one into an allowed path. The
  delivery check therefore refuses a delivered file that is a hard link to a hidden file.
- Claude Code applies its deny rules to `Grep` and `Glob` results. OpenCode does not, so a
  scope with hidden entries turns off OpenCode's `grep` tool. Both list the names of hidden
  files, as an operating-system sandbox does; neither reads them.
- OpenCode matches its rules in exact letter case, so SuperTag denies every case spelling of a
  read-only or hidden entry. Past the eighth letter of an entry, a denial covers any character in
  that position: a hidden `secrets.production` also hides other names of that length that
  share its first eight letters, such as `secrets.playground`.
- An Objective's runtime actions narrow which actions its Tasks get, not their paths.

### Network scopes

A network scope narrows a Permission Set's `web:fetch` grant to named origins, HTTP methods, and
URL paths.
It can also name a credential that the Worker Host adds to those requests. The Task's commands
never see the secret, only a placeholder. Network scopes live only in Permission Sets. A Tag's
own `allowedActions` `web:fetch` reaches every origin.

A runtime `web:fetch` permission takes four optional fields:

| Field | Meaning |
| --- | --- |
| `hosts` | Origins the Task may reach, `https://NAME`, `https://NAME:PORT`, or `https://*.NAME` for every subdomain of `NAME`. Omitted: any origin |
| `methods` | HTTP methods allowed on those origins: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`. Omitted: any method |
| `paths` | URL path prefixes allowed on those origins, such as `/repos/acme`. Omitted: any path. Needs `hosts` |
| `credential` | A credential configured on the Worker Host, added to requests this permission allows. Needs `hosts` |

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: python-and-github }
spec:
  permissions:
    - target: runtime
      action: web:fetch
      hosts: ["https://pypi.org", "https://files.pythonhosted.org"]
      methods: [GET, HEAD]
    - target: runtime
      action: web:fetch
      hosts: ["https://api.github.com"]
      methods: [GET]
      paths: [/repos/acme]
      credential: github
    - { target: runtime, action: commands:execute }
    - { target: runtime, action: files:write }
```

Read as one statement: *the Task may read packages from PyPI, and read the `acme` organization's
repositories through the GitHub API with the host's GitHub token, and nothing else on the
network.*

Entries follow these rules:

- An origin matches its exact host name, in any letter case, and its exact port. The default port
  443 is dropped, so `https://pypi.org:443` is `https://pypi.org`. `https://pypi.org` does not
  cover `https://www.pypi.org`.
- `https://*.example.com` matches `a.example.com` and `a.b.example.com`, but not `example.com`;
  list both when the Task needs both. A wildcard is allowed only as the first label.
- Only `https://` origins are allowed, so a credential never travels in clear text. An origin
  has no path, query, or user name, and is not an IP address or `localhost`.
- A path prefix matches at a `/` boundary: `/repos/acme` matches `/repos/acme` and
  `/repos/acme/app`, but not `/repos/acmex`. A prefix is literal and starts with `/`. A request
  whose path holds a `.` or `..` segment or a percent-encoded dot or slash never matches a
  prefix, so two spellings of one URL cannot pass different prefixes.
- `GET` does not imply `HEAD`; list both.
- A permission lists at most 64 hosts.

`supertag apply` and `supertag diff` refuse an invalid entry and say why.

Every Permission Set a Task receives applies, and their grants combine. A request is allowed when
any grant allows its origin, method, and path. A `web:fetch` grant with neither `hosts` nor `methods`,
including a Tag's own `web:fetch`, allows every request; then only the credential bindings still
matter. A credential is added only to a request that a grant naming it allows. A request that
carries a credential's placeholder anywhere else is refused.

A Task keeps the scope recorded when SuperTag accepted it. `supertag describe task` shows it
under `network_scope`, for example
`Reaches https://api.github.com (GET; credential github) · https://pypi.org (GET, HEAD)`.

### Network credentials

A network credential is a secret on the Worker Host, such as a GitHub token, that a Permission
Set names. Configure it on a host service in `supertag.yaml`; see
[Network credentials](supertag-yaml.md#network-credentials). The Control Plane learns only its
name.

For each Task Attempt, the host makes a placeholder such as
`supertag-credential-github-4f2c0d1e9b8a7c6d5e4f3a2b`. The Task's commands see it in the
variable the host names, such as `GITHUB_TOKEN`. When a command sends a request that a grant
naming the credential allows, the Worker Host's egress proxy replaces the placeholder with the
secret. It replaces it in any header, including inside `Authorization: Basic`, so `git` over
HTTPS works with `x-access-token:$GITHUB_TOKEN`. It never replaces it in a URL or a body.

An allowed origin can still echo a secret back, for example in an error message or a created
resource. Keep `methods` and origins as narrow as the work needs.

### Network scope enforcement

The Worker Host runs an egress proxy for each Task Attempt whose Task has a network scope. The
proxy listens on loopback and accepts only that Task Attempt's harness. It refuses an origin
outside the scope before any TLS. For an allowed origin, it ends TLS with a certificate from a
certificate authority made for that Task Attempt. It then checks each request's method and
`Host`, adds credentials, and forwards the request over a verified TLS connection. The
authority's key never leaves the Worker Host's memory. The proxy also refuses an origin whose
address is loopback, private, link-local, or otherwise not public, such as a cloud metadata
service.

Commands get the authority's certificate in `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
`CURL_CA_BUNDLE`, `PIP_CERT`, and `GIT_SSL_CAINFO`, as a bundle with the host's own roots, and in
`NODE_EXTRA_CA_CERTS`.

| Harness | Scope with `hosts` or `methods` | Scope that only names credentials |
| --- | --- | --- |
| Codex, local Worker Host | operating system: the sandbox allows only loopback, Codex's managed network proxy allows only the scope's hosts, and it forwards every connection through the egress proxy | commands reach the network directly, and the proxy variables point at the egress proxy |
| Claude Code | `WebFetch`: tool, SuperTag's tool hook checks each URL. Commands: operating system, Claude Code's own sandbox sends their traffic only to the egress proxy, on a host that can run it. A scope that names a credential is not supported: the Task waits | not supported: the Task waits |
| OpenCode, Cursor, custom harnesses | not supported: the Task waits | not supported: the Task waits |
| Cursor or Claude Code with a Modal Workspace, Task with `commands:execute` | provider network policy: the sandbox has no network at all, DNS included. Commands reach the web only through a relay in the sandbox that carries each connection over the provider's own command channel to the egress proxy on the Worker Host | commands carry the proxy credential and the placeholders through the relay |
| E2B Workspaces and shared execution | not supported: the Task waits | not supported: the Task waits |

A Task waits too when no Worker Host offers a credential its scope names.
`supertag placement explain TASK` names the `network-scope` requirement and why, for example:

```text
this Worker Host offers no network credential github; configure it under network-credentials on
a host that runs the Tag
```

Codex code-mode commands run under the same profile, so they reach the network only through
the managed proxy and the egress proxy as well.

Claude Code's sandbox runs on macOS, and on Linux when `bubblewrap` and `socat` are installed and
a process may create a user namespace inside bubblewrap's. Ubuntu's `bwrap-userns-restrict`
AppArmor profile forbids that, so such a host does not offer the sandbox. A
Claude Code host reports whether it can run the sandbox, and only such a host takes a Task that
may run commands under a network scope. Claude Code fails the Task Attempt instead of running
commands unsandboxed when its sandbox does not start. The sandbox isolates only the network:
commands still need `allow-unsandboxed-commands`. Go programs on macOS, such as `gh`, may not
trust the proxy's certificate from inside the sandbox.

Claude Code's sandbox connects to the egress proxy without the Task Attempt's proxy password, so
the proxy of a Claude Code Task Attempt accepts any process on the Worker Host. Such a proxy
never carries a credential, and it still allows only the Task's scope. A process that can reach
the Worker Host's loopback, such as another Task's Codex commands, could use it while the Task
Attempt runs.

### Network log

The egress proxy records every request it decides: the time, the method, the origin, the path
without its query, whether it was allowed, the reason for a refusal, the origin's status code, and
the credential it added. It never records headers or bodies, and it removes secrets and
placeholders from paths. It keeps the first 500 requests of a Task Attempt and counts the rest.
`supertag describe task` shows each Task Attempt's log under `network_log`. Operators also see a
Tag's 20 newest logs in the desktop app's Tag details, opened from the Tag's name above the
conversation, and under **Network** in the terminal UI's command palette. A log names the origins
and paths of other people's Tasks, so only operators may read it.

### Fail-closed behavior

Unknown runtime actions do not enable anything in the built-in harnesses. A harness must fail closed when it cannot enforce an admitted policy. Permission checks select tools; execution-environment isolation, filesystem mounts, and network policy provide the hard boundary.

When a Task's file and command tools run in a remote sandbox or a shared execution
environment, a sandbox that cannot be reached or fails makes the tool return an error. The
Worker Host never runs the operation itself instead.

### Failed write calls

If execution fails after a write call starts, the Control Plane marks the Task failed and does not
replay it automatically. The action may already have completed, so an operator must reconcile the
provider before manually retrying. A harness adapter can provide stronger idempotency with effect
receipts; see [Reliable external actions](action-effects.md).

### Unsandboxed harnesses

Codex enforces the [harness-native tools](#harness-native-tools) runtime actions inside its
operating-system sandbox. Claude Code, OpenCode, and Cursor on a local Worker Host do not provide
an enforced command boundary: their shell tools run commands as the Worker Host's user. SuperTag therefore
places a Task with `commands:execute` on them only when the host service lists them in
`allow-unsandboxed-commands`. On a host with `environment: local-vm`, they run
commands in a container instead. Otherwise the Task goes to a Worker Host that may run commands,
such as one serving Codex, or waits. See
[Unsandboxed harnesses](supertag-yaml.md#unsandboxed-harnesses).

`files:write` alone needs no opt-in. The harness writes files through its own file tools, inside
the Task's worktree, and those tools run no program. A file written there can still be run later,
by a Task with `commands:execute` or by you, so review delivered changes before running them.

Each Worker Host reports this setting in its execution profile when it registers. Like labels,
the setting is self-reported and decides placement, never access.

## Credential boundaries

[Credential storage](credential-storage.md) is the canonical reference for each credential
boundary.

- Gateway credentials receive events and deliver replies.
- Worker Host credentials authenticate harness tools and request-selected resources.
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
- Cross-Tag context is denied even when Tags share accounts or Worker Hosts.
- Worker Hosts contain the secret and isolation boundary used by their harnesses.

## Explicit internal messaging

[Tag messaging](../guides/tag-messaging.md) permits selected, application-supplied message
bodies to cross Tag boundaries under an explicit directional grant. This does not relax
Context Set isolation or give a recipient access to another Tag's artifacts. A messaging
grant authorizes delivery, not the requested action. The recipient application must apply
its own execution and disclosure policies. The trusted Worker Host holds a Tag-scoped
credential; sender identity is never accepted from model-written message fields. A message is
plain text and grants no authority. Tags in one Team message each other without a grant. Grant
rules are in [Mailbox](coordination.md#mailbox).

Team membership permits reading and posting to the Team's Workstream. This does not expand
Context Set access, native provider permissions, or messaging grants, and a post carries no
authority. See [Workstream](coordination.md#workstream).

Only an Objective's owner, through its turns' results, or an operator changes an Objective's
status. See [Objectives](coordination.md#objectives).
