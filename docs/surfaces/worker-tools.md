# MCP tools for GitHub, Slack, Linear, Teams, and Lark

An MCP server gives a **Task**, one request accepted for a **Tag** (a persistent AI actor with
its own responsibilities and permissions), tools to read or change an external service. A **Worker
Host**, a machine or sandbox that provides execution capacity, runs the Task. There the **Worker**,
the code that completes the Task, drives an agent system through its **harness**. Declare a preset
for the provider on that host when the harness needs those tools. The host supplies the server
credential, while a **Permission Set**, a set of allowed actions, selects tools and resources. The
**Surface Account**, the connected external account, remains in the **Control Plane**, the SuperTag
service, for incoming messages and thread replies.

## GitHub

For example, a Task may read one repository and send messages to one Slack channel. Set up the
host's HTTP MCP servers in `supertag.yaml`:

```yaml
services:
  laptop:
    type: host
    mcp:
      github: { preset: github, auth: { bearer: { env: GITHUB_MCP_TOKEN } } }
      slack: { preset: slack, auth: { bearer: { env: SLACK_MCP_TOKEN } } }
```

Use host-local credentials restricted by GitHub and Slack to the intended repositories and
channels. SuperTag reads the environment variables on the host and injects the headers in its
per-Task policy proxy. The harness and its shell never receive them. See
[host MCP servers](../reference/supertag-yaml.md#host-mcp-servers).

Grant the exact official tools in a Permission Set:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: review-tools }
spec:
  permissions:
    - { target: mcp, action: "github/get_file_contents", resource: "repository:acme/api" }
    - { target: mcp, action: "github/create_pull_request", resource: "repository:acme/api", approval: required }
    - { target: mcp, action: "slack/slack_read_channel", resource: "channel:C0123456789" }
    - { target: mcp, action: "slack/slack_send_message", resource: "channel:C0123456789", approval: required }
```

The GitHub preset maps `owner` plus `repo` or `repository` to `repository:OWNER/REPO`.
It maps `get_file_contents`, `issue_read`, `add_issue_comment`, `pull_request_read`,
`create_branch`, `create_pull_request`, and `merge_pull_request`.

## Slack

The Slack preset maps
`channel_id`, `channelId`, or `channel` to `channel:ID` for `slack_read_channel`,
`slack_read_thread`, and `slack_send_message`. A scoped call without checkable arguments fails.
See [MCP server tools](../reference/iam.md#mcp-server-tools) for grants and approval.

Git credentials for cloning a **Workspace**, a named repository that Tasks work in, or delivering its pull request are separate from MCP
credentials. Those operations use the host's `GITHUB_TOKEN` and existing Workspace permissions;
see [Workspaces](../guides/workspaces.md#deliver-pull-requests).

## Linear

```yaml
mcp:
  linear: { preset: linear, auth: { bearer: { env: LINEAR_MCP_TOKEN } } }
```

The preset uses Linear's official server, `https://mcp.linear.app/mcp`. It maps `team_id`,
`teamId`, or `team` to `team:ID` for `list_issues` and `create_issue`. Other Linear tools, such
as `get_issue` and `create_comment`, take only an issue or comment ID, so grant them per tool,
without a `resource`. Use a token restricted to the teams the Tag needs.

## Teams

```yaml
mcp:
  teams:
    preset: teams
    tenantId: contoso.onmicrosoft.com
    auth: { bearer: { env: TEAMS_MCP_TOKEN } }
```

The preset uses Microsoft's preview Agent 365 Teams MCP server for the `tenantId` you give.
It maps `team_id` or `teamId` plus `channel_id` or `channelId` to
`team:TEAM_ID/channel:CHANNEL_ID` for `mcp_graph_teams_listChannelMessages`,
`mcp_graph_teams_postChannelMessage`, and `mcp_graph_teams_replyToChannelMessage`. The
Microsoft permission covers the whole tenant, so restrict the identity's Teams access as a
second boundary.

## Lark / Feishu

```yaml
mcp:
  lark:
    preset: lark
    env:
      APP_ID: { env: LARK_APP_ID }
      APP_SECRET: { env: LARK_APP_SECRET }
      LARK_DOMAIN: { env: LARK_DOMAIN }   # optional: https://open.feishu.cn is the server's default
```

Lark's server runs only over stdio. The preset runs the official `@larksuiteoapi/lark-mcp`
package that ships with SuperTag. The Worker starts it for each **Task Attempt**, one execution or retry of a
Task, and the harness
reaches it only through the policy proxy. The App credentials reach only the server process. The
preset maps these calls to `chat:ID`, so a grant can name one chat:

- `im_v1_message_list` with `params.container_id_type: chat` uses `params.container_id`.
- `im_v1_message_create` with `params.receive_id_type: chat_id` uses `data.receive_id`.

A chat-scoped grant refuses any other recipient type, such as `open_id`, because no chat can be
checked. Grant other tools, such as
`im_v1_message_reply`, per tool.

The Lark Surface Account's Gateway credentials are separate and stay in the Control Plane.

## Secret handling

For where each credential is stored and who can resolve it, see
[credential storage](../reference/credential-storage.md).

Credentials are resolved per Task Attempt on the **Worker Host**, the machine or sandbox that runs the Task. They are supplied through proxy headers or the stdio server's environment, never Permission Sets, Task snapshots, Runtime Input Manifests, prompts, session state, or command-line arguments. Built-in harnesses and local processes receive a minimal environment instead of inheriting every Worker Host variable. Known secret values are redacted from Worker events and errors before they cross the transport of the **Worklet**, the program that connects the Worker Host to the Control Plane.

HTTP MCP endpoints must use TLS. A plain HTTP endpoint is accepted only on the loopback interface for local development and automated verification.
