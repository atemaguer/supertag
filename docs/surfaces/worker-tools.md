# MCP tools for GitHub, Slack, Linear, Teams, and Lark

An MCP server gives a **Task**, one request accepted for a **Tag** (a persistent AI actor with
its own responsibilities and permissions), tools to read or change an external service. The
**Worker Host**, the machine that runs the Task, offers MCP servers from its own catalog and holds
their credentials. A **Permission Set**, a set of allowed actions, selects which tools and
resources a Task may use. The **Surface Account**, the connected account the Gateway uses for
incoming messages and thread replies, is separate. See the [glossary](../reference/glossary.md)
for other terms.

Catalog tools serve Claude Code Tasks.

## Write the host's catalog

The catalog is an owner-only JSON file that the Worker Host reads with `--mcp-catalog`. A
**preset** names an official server, its URL, and how its tool arguments map to resources:

```json
{
  "version": 1,
  "servers": [
    { "name": "github", "preset": "github", "headerEnv": { "Authorization": "GITHUB_MCP_AUTH" } },
    { "name": "slack", "preset": "slack", "headerEnv": { "Authorization": "SLACK_MCP_AUTH" } }
  ]
}
```

Each `headerEnv` value names a Worker Host environment variable that holds the full header value,
such as `Bearer TOKEN`. Use credentials restricted by the provider to the repositories and
channels the Tags need. The host injects the headers for each Task Attempt; the agent and its
shell never receive them.

```sh
chmod 600 ~/mcp-catalog.json
supertag mcp list --mcp-catalog ~/mcp-catalog.json
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --harness claude-code --mcp-catalog ~/mcp-catalog.json
```

`mcp list` shows each server, its auth form, and whether its credentials are ready, without
printing them. A server can also sign in with OAuth (`"oauth": true`, then
`supertag mcp login NAME --mcp-catalog PATH`), or mint credentials per Task Attempt from a refresh
token, client credentials, a GitHub App, or a helper command. See
[`supertag worker-host`](../reference/cli.md#supertag-worker-host) for every catalog form.

## Grant the tools

Grant exact tools, and optionally resources, in a Permission Set:

```yaml
apiVersion: supertag/v1
kind: PermissionSet
metadata: { name: review-tools }
spec:
  permissions:
    - { target: mcp, action: github/get_file_contents, resource: "repository:acme/api" }
    - { target: mcp, action: github/create_pull_request, resource: "repository:acme/api", approval_required: true }
    - { target: mcp, action: slack/slack_read_channel, resource: "channel:C0123456789" }
```

The action is `SERVER/TOOL`, where `SERVER` is the catalog name. A call that requires approval
waits in the operator inbox. A scoped call whose arguments cannot be checked against the resource
fails. See [MCP server tools](../reference/iam.md#mcp-server-tools).

## GitHub

The `github` preset maps `owner` plus `repo` or `repository` to `repository:OWNER/REPO`.

Git credentials for a GitHub **Workspace**, a repository that Tasks work in, are separate from MCP
credentials; see [Workspaces](../guides/workspaces.md).

## Slack

The `slack` preset maps `channel_id`, `channelId`, or `channel` to `channel:ID` for
`slack_read_channel`, `slack_read_thread`, and `slack_send_message`.

## Linear

The `linear` preset uses Linear's official server. It maps `team_id`, `teamId`, or `team` to
`team:ID` for `list_issues` and `create_issue`. Tools that take only an issue or comment ID, such
as `get_issue`, are granted per tool, without a `resource`.

## Teams

The `teams` preset uses Microsoft's preview Agent 365 Teams MCP server and needs `"tenantId"`, the
Microsoft Entra tenant ID or domain. It maps `team_id` plus `channel_id` to
`team:TEAM_ID/channel:CHANNEL_ID`. The Microsoft permission covers the whole tenant, so restrict
the identity's Teams access as a second boundary.

## Lark / Feishu

Lark's server runs only over stdio. The `lark` preset runs `lark-mcp`, from the
`@larksuiteoapi/lark-mcp` npm package, from the Worker Host's `PATH`:

```json
{ "name": "lark", "preset": "lark", "env": { "APP_ID": "LARK_APP_ID", "APP_SECRET": "LARK_APP_SECRET" } }
```

The host starts the server for each Task Attempt with only the variables its `env` names, and
stops it when the Task Attempt ends. A chat-scoped grant names `chat:ID`.

## Other servers

Any HTTPS server can be a catalog entry with `"url"` in place of `"preset"`, and any local
command a stdio entry with `"command"`. An optional `resources.tools` object maps a tool's
arguments to resources. HTTP endpoints must use TLS, except on loopback.

## Secret handling

Credentials stay on the Worker Host. They reach a server only through the headers or environment
the catalog names, never Permission Sets, prompts, Session state, or command-line arguments.
Known secret values are redacted from events and errors. See
[credential storage](../reference/credential-storage.md).
