# Collaboration surface guides

Connect an external work tool so a **Tag** can receive requests and reply there. A Tag is a
persistent AI identity with its own responsibilities and permissions. A **collaboration surface** is
how SuperTag meets people in a tool such as Slack or GitHub: it receives events at a Tag's locations
and replies there. See the [glossary](../reference/glossary.md) for other terms.

Tags work in Teams under a lead. Together, your Teams of Tags make up an **autonomous
organization**: Teams may pursue different goals but share one Control Plane, its rules,
and its record of the work.
The **Control Plane** is the SuperTag service that stores your organization and schedules work.
Its **Gateway** carries traffic to and from collaboration surfaces. Connecting a surface lets
the Gateway receive requests and deliver replies. It does **not** give every
Tag access to every resource in the connected account.

| Collaboration surface | Best first setup | Guide |
| --- | --- | --- |
| Slack | Socket Mode for a local Gateway | [Connect Slack](slack.md) |
| GitHub | Fine-grained token and repository webhook | [Connect GitHub](github.md) |
| Lark / Feishu | App bot with outbound long connection | [Connect Lark](lark.md) |
| Linear | Personal API key and signed webhook | [Connect Linear](linear.md) |
| Microsoft Teams | Single-tenant Entra app and Teams bot | [Connect Teams](teams.md) |

After connecting an account, return to the root [README](../../README.md#next-add-your-teams-chat) to add a channel, repository, or team to a Tag's `locations`.

If the first invocation does not reply, follow the
[first-reply troubleshooting checklist](../guides/troubleshooting.md).

<a id="add-another-surface"></a>

## Add another collaboration surface

An existing Tag can serve more than one collaboration surface. Keep the Control Plane running; it
picks up new collaboration surface setup without a restart. For example, to add a Slack channel to the
`engineering` Tag:

```sh
supertag setup surface slack
supertag update tag engineering --add-location slack --channel-id C0123456789
supertag get tag engineering
```

The `get tag` output lists every location under `status.locations`. Each guide above gives the
setup and location flags for its provider.

## Declare a Surface Account in a manifest

A **Surface Account** is one connected account, such as a Slack workspace. `supertag setup
Surface` creates one by asking for its tokens. A shared Control Plane, managed from files in
version control, can declare the account in a manifest instead. The manifest names where each
secret comes from; it never holds the value:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-slack
spec:
  provider: slack
  configuration:
    transport: socket
  secrets:
    botToken: { env: SLACK_BOT_TOKEN }
    appToken: { env: SLACK_APP_TOKEN }
```

```sh
supertag apply -f acme-slack.yaml
```

Apply reads the values, checks them with the provider as setup does, and stores them in the
credential vault. A Tag location can then name the account with `account: acme-slack`, in the same
input or later. The rules, including rotation and deletion, are in
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

Each provider takes these options and secrets. The setup variable is the environment variable
`supertag setup surface` reads for the same value.

| Provider | `configuration` | `secrets` (setup variable) |
| --- | --- | --- |
| `slack` | `transport`: `socket` (default) or `http` | `botToken` (`SLACK_BOT_TOKEN`); with `socket`, `appToken` (`SLACK_APP_TOKEN`); with `http`, `signingSecret` (`SLACK_SIGNING_SECRET`) |
| `github` | `auth`: `token` (default) or `app`; `apiBaseUrl`; with `app`, `appId` and `installationId` | with `token`, `token` (`SUPERTAG_GITHUB_TOKEN`) and optional `webhookSecret` (`GITHUB_WEBHOOK_SECRET`); with `app`, `privateKey` (the file at `GITHUB_PRIVATE_KEY_PATH`) and `webhookSecret` |
| `lark` | `appId`; `domain`: `lark` (default) or `feishu` | `appSecret` (`LARK_APP_SECRET`) |
| `linear` | `apiBaseUrl` | `apiKey` (`LINEAR_API_KEY`), `webhookSecret` (`LINEAR_WEBHOOK_SECRET`) |
| `teams` | `appId`, `tenantId` | `appSecret` (`TEAMS_APP_SECRET`) |

Write each secret as `{ env: VARIABLE }`, `{ file: PATH }`, or `{ secretRef: NAME }`. The optional
`displayName` replaces the name the provider reports; for Teams it is the tenant's display name.
The [SurfaceAccount schema](../../spec/surface-account-manifest.schema.json) gives the exact
shape.

## Credentials

Gateway credentials for ingress and replies, whether from setup or a manifest, are configured
separately from **Worker** credentials for optional provider MCP tools. A Worker is the code that
completes a **Task**, one accepted request. See
[credential storage](../reference/credential-storage.md). Neither grants authority by itself: the
Tag's active **Permission Sets**, its allowed actions, still decide what a Task may use.

Most users can stop here. If a **harness**, the connection between a Worker and an agent system, must read collaboration surface data beyond its originating thread, continue to [Worker-side collaboration surface tools](worker-tools.md).
