# Collaboration surface guides

Connect an external work tool so a **Tag** can receive requests and reply there. A Tag is a
persistent AI actor with its own responsibilities and permissions. A **collaboration surface** is
how SuperTag meets people in a tool such as Slack or GitHub: it receives events at a Tag's
locations and replies there. See the [glossary](../reference/glossary.md) for other terms.

The **Gateway** is the SuperTag service that carries collaboration surface traffic. It holds the
surface credentials, receives events, and delivers replies, and it connects to the **Control
Plane**, the service that stores your organization, as a client. `supertag up` runs a local
Gateway; a deployment runs its own. Connecting a surface does **not** give every Tag access to
every resource in the connected account.

| Collaboration surface | How events arrive | Guide |
| --- | --- | --- |
| Slack | HTTPS webhook to the Gateway | [Connect Slack](slack.md) |
| GitHub | HTTPS webhook to the Gateway | [Connect GitHub](github.md) |
| Lark / Feishu | Outbound long connection; no public URL needed | [Connect Lark](lark.md) |
| Linear | HTTPS webhook to the Gateway | [Connect Linear](linear.md) |
| Microsoft Teams | HTTPS webhook to the Gateway | [Connect Teams](teams.md) |

Webhook listeners bind to loopback. Forward a public HTTPS URL to them with a tunnel on a laptop,
or a reverse proxy beside a hosted Gateway.

If the first invocation does not reply, follow the
[first-reply troubleshooting checklist](../guides/troubleshooting.md).

## Connect a surface in two steps

Every surface follows the same pattern. For example, Slack and the `lead` Tag:

```sh
supertag setup surface slack
supertag tag update lead --add-location slack --channel-id C0123456789
supertag get surface-location --state-directory ~/.supertag
```

1. `setup surface PROVIDER` checks the credentials with the provider, stores them in the
   credential vault, and records a **Surface Account**, the connected account, in the Control
   Plane and in `supertag.yaml`.
2. `tag update TAG --add-location PROVIDER` adds a **surface location**, such as a channel or a
   repository, where the Tag admits work.

Both default to this machine's local services. Name a shared Control Plane with
`--control-plane`, and the Gateway that serves the account with `--gateway`.

## Declare accounts and locations in manifests

A shared Control Plane managed from files can declare Surface Accounts and locations. A manifest
names the account's identity, never a secret; credentials still come from `setup surface` or
`supertag gateway credential store` on the Gateway's machine:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata: { name: acme-slack }
spec:
  identity: { provider: slack, team_id: T0123456789 }
  enabled: true
  gateway: local
---
apiVersion: supertag/v1
kind: SurfaceLocation
metadata: { name: eng-channel }
spec:
  account_id: acme-slack
  connector_account_id: T0123456789
  tag_id: lead
  scope: { provider: slack, channel_id: C0123456789 }
  enabled: true
  permission_set_ids: [local-tools]
```

A location may also activate Permission Sets and Context Sets there, with `permission_set_ids`
and `context_set_ids`, or later with `supertag permission-set activate` and `supertag context-set
activate`. See [Manage Control Plane resources](../operations/resources.md).

## Credentials

Gateway credentials, for events and replies, are separate from the credentials a Worker Host uses
for optional provider MCP tools. Neither grants authority by itself: the Tag's active Permission
Sets still decide what a Task may use. See [credential storage](../reference/credential-storage.md).

If a Tag's agent must read collaboration surface data beyond its originating thread, continue to
[MCP tools for GitHub, Slack, Linear, Teams, and Lark](worker-tools.md).
