---
name: connect-a-surface
description: Connect Slack, GitHub, Lark/Feishu, Linear, or Microsoft Teams to SuperTag and place a Tag at a channel, repository, chat, or team. Read when adding a collaboration surface.
---

# Connect a collaboration surface

A collaboration surface is where people reach a Tag: a Slack channel, a GitHub repository, a
Lark chat, a Linear team, or a Teams channel. The Gateway, a SuperTag service separate from the
Control Plane, holds the surface credentials, receives events, and delivers replies. Each surface
has its own guide under [`docs/surfaces/`](../../docs/surfaces/README.md); follow it for the
provider's app settings.

## Choose

| Collaboration surface | Events arrive by | Public URL needed |
| --- | --- | --- |
| Lark / Feishu | An outbound long connection | No |
| Slack | An outbound Socket Mode connection (default), or an HTTPS webhook to `/slack/events` with `--transport http` | Only for HTTP |
| GitHub | HTTPS webhook to `/github/events` | Yes |
| Linear | HTTPS webhook to `/linear/events` | Yes |
| Microsoft Teams | HTTPS webhook to `/microsoft-teams/messages` | Yes |

Webhook listeners bind to loopback (Slack `127.0.0.1:3480`, GitHub `3481`, Linear `3482`, Teams
`3483` by default). On a laptop, forward a public HTTPS URL to them with a tunnel; on a server, a
reverse proxy beside the Gateway. Slack Socket Mode needs an app-level token (`SLACK_APP_TOKEN`)
with `connections:write` instead of the signing secret.

## Credentials

```sh
supertag setup surface slack
```

Setup reads secrets from masked prompts or the environment variables each command lists in
`supertag setup surface PROVIDER --help`, never from flags. It verifies them with the provider,
stores them in the credential vault, records a Surface Account in the Control Plane, and records
the account and its listener in `supertag.yaml`, so the local Gateway serves it. Never construct a
command that puts a secret in argv, and never ask the user to paste a secret into chat.

For a shared deployment, add `--control-plane NAME` and `--gateway NAME` for the enrolled Gateway
that serves the account. That Gateway's machine holds the credentials.

## Place a Tag

```sh
supertag tag update lead --add-location slack --channel-id C0123456789
supertag tag update lead --add-location github --repo owner/repository
supertag tag update lead --add-location lark --chat-id oc_0123456789
supertag tag update lead --add-location linear --team-id TEAM_UUID
supertag tag update lead --add-location teams --team-id TEAM_ID --channel-id CHANNEL_ID
```

Use stable IDs, not display names. `--allowed-user ID` limits who may ask the Tag for work there.
`--account NAME` picks the Surface Account when several of one provider exist. The local Gateway
serves one location per Surface Account; remove one with `--remove-location PROVIDER` before
adding another.

## Two credential boundaries

Gateway credentials authenticate events and replies only. Tools the Tag's agent uses on the
provider, such as reading channel history or opening a pull request, come from a separate MCP
catalog on the Worker Host and a Permission Set grant. See
[MCP tools](../../docs/surfaces/worker-tools.md).

## Verify

```sh
supertag get surface-account
supertag get surface-location
supertag logs gateway
```

Mention `@SuperTag` (`@supertag` on GitHub and Linear) at the location. The reply arrives in the
same thread or conversation. If not, follow [troubleshoot](../troubleshoot/SKILL.md).
