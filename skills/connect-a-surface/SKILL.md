---
name: connect-a-surface
description: Connect Slack, GitHub, Lark/Feishu, Linear, or Microsoft Teams to a SuperTag Control Plane and place a Tag there. Read when adding a collaboration surface (Slack, GitHub, and similar tools where a Tag receives requests and replies).
---

# Connect a collaboration surface

Connecting an account gives the Control Plane's Gateway credentials to receive invocations and post replies. It
does **not** grant a Tag access to everything in that account — the Tag's Permission Sets still
decide what a Task may do.

A Control Plane must be running and reachable before `setup` will work; setup enrolls credentials
through the authenticated Control Plane API.

## Choose

| Collaboration surface | Setup | Needs a public Gateway URL? |
| --- | --- | --- |
| Slack | `supertag setup surface slack` | No, with Socket Mode (default) |
| Slack | `supertag setup surface slack --transport http` | Yes |
| GitHub | `supertag setup surface github [--auth token\|app] [--webhook]` | Yes, for webhooks |
| Lark / Feishu | `supertag setup surface lark --domain lark\|feishu` | No, outbound long connection |
| Linear | `supertag setup surface linear` | Yes, signed webhook |
| Microsoft Teams | `supertag setup surface teams` | Yes |

Prefer Slack Socket Mode or Lark for a local Gateway — neither needs inbound ingress. GitHub,
Linear, Teams, and Slack HTTP require the Gateway's webhook route to be reachable over HTTPS.

Each surface has a guide with the exact app-creation steps and native scopes. Read the relevant
one; do not guess at scopes:

- [Slack](../../docs/surfaces/slack.md) — with a paste-ready
  [app manifest](../../docs/surfaces/slack-app-manifest.yaml)
- [GitHub](../../docs/surfaces/github.md)
- [Lark / Feishu](../../docs/surfaces/lark.md)
- [Linear](../../docs/surfaces/linear.md)
- [Microsoft Teams](../../docs/surfaces/teams.md)

## Credentials

Always entered at a masked prompt, or read from the environment for non-interactive setup.
**Never passed as flags.** `supertag setup surface PROVIDER --help` lists the accepted variables.

| Collaboration surface | Non-interactive variables |
| --- | --- |
| Slack | `SLACK_BOT_TOKEN` plus `SLACK_APP_TOKEN` (socket) or `SLACK_SIGNING_SECRET` (http) |
| GitHub | `SUPERTAG_GITHUB_TOKEN`, or `GITHUB_APP_ID` / `GITHUB_INSTALLATION_ID` / `GITHUB_PRIVATE_KEY_PATH`, plus `GITHUB_WEBHOOK_SECRET` |
| Lark / Feishu | `LARK_APP_ID`, `LARK_APP_SECRET` |

## Place a Tag

Adding a Tag creates its presence at one exact scope. A scope holds at most one enabled Tag, so
routing is deterministic.

```sh
supertag update tag NAME --add-location slack  --channel-id C0123456789
supertag update tag NAME --add-location github --repo owner/name
supertag update tag NAME --add-location lark   --chat-id oc_0123456789
supertag update tag NAME --add-location linear --team ENG
supertag update tag NAME --add-location teams  --team-id ID --channel-id ID
```

Use `--repo-id ID` instead of `--repo` for a GitHub repository ID, or `--team-id UUID` instead
of `--team` for a Linear team ID. Add `--account ID` when more than one account is enrolled
for that provider. Use `supertag update tag NAME --remove-location PROVIDER` with the same
scope flags to remove it.

Invite the app or bot to the channel first, and use stable IDs rather than display names.

## Two credential boundaries

**Gateway credentials** authenticate ingress and thread replies — configured by `setup`.

**MCP server credentials** authenticate optional MCP tools a harness calls. They're set as
references in the host service's `mcp` servers in `supertag.yaml`, and reach only the Worker. See
[run-a-worker](../run-a-worker/SKILL.md) and
[Worker-side collaboration surface tools](../../docs/surfaces/worker-tools.md).

Neither grants authority by itself. The Tag's active Permission Sets decide.

## Verify

```sh
supertag list surface
supertag describe tag NAME        # confirms the presence
```

Then mention the Tag in the configured channel. No reply means
[troubleshoot](../troubleshoot/SKILL.md).
