# Connect Microsoft Teams

Connect a Microsoft Teams tenant so a **Tag**, a persistent AI identity with its own
responsibilities and permissions, replies when someone mentions it in a channel. Teams requires a
single-tenant Entra application, a bot or agent resource, and a Teams app installed in the target
team.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the part of the **Control Plane**, the SuperTag service, that
receives Microsoft Teams messages. See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to register an Entra application and install apps in the target team.
- The `supertag` CLI installed.
- A Gateway endpoint that is publicly reachable over HTTPS. A local Gateway may use a temporary
  tunnel for development.

## 1. Create the Entra app and bot

Create a single-tenant Entra app registration and client secret. Then create the bot or agent
resource for that application ID.

## 2. Set the messaging endpoint

```text
https://YOUR_GATEWAY/webhooks/teams/YOUR_TENANT_ID
```

## 3. Create and install the Teams app

In Teams Developer Portal, create an app using that bot ID. Enable the `team` scope and install it
in the intended team.

The mention and reply flow does not need Microsoft Graph application permissions. Broader reads
belong in explicit Tag permissions.

## 4. Enroll the tenant

```sh
supertag setup surface teams
```

Provide the application ID, client secret, tenant ID, and optional tenant display name. For
non-interactive setup:

```text
TEAMS_APP_ID
TEAMS_APP_SECRET
TEAMS_TENANT_ID
TEAMS_TENANT_NAME       # optional
```

### Or declare the tenant in a manifest

On a shared Control Plane managed from files, declare the tenant instead of running setup. The
application and tenant IDs are not secret; the manifest says where the client secret comes from,
never its value:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-teams
spec:
  provider: teams
  displayName: Acme
  configuration:
    appId: 00000000-0000-0000-0000-000000000000
    tenantId: 11111111-1111-1111-1111-111111111111
  secrets:
    appSecret: { env: TEAMS_APP_SECRET }
```

Run `supertag apply -f acme-teams.yaml`. Apply requests a bot token from Microsoft, as setup does.
`displayName` is the optional tenant display name. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

## 5. Add a channel to a Tag and start

A copied Teams channel link contains the channel ID in its path and the team ID in its `groupId`
query parameter.

```sh
supertag create tag engineering
supertag update tag engineering --add-location teams \
  --team-id '19:TEAM_ID@thread.tacv2' \
  --channel-id '19:CHANNEL_ID@thread.tacv2'
supertag start control-plane
```

If multiple tenants are enrolled, select one with `--account TENANT_ID`.

## Check that it worked

Mention `@SuperTag` in that channel. The Tag replies in the originating thread. The Gateway checks
the Microsoft activity token, and the Control Plane stores the accepted **Task**, one request for the Tag,
before replying through
the Gateway.

## Rules

- This first version supports channel mentions and replies. Personal chat, group chat, proactive
  messages, and files or cards are outside this path.
- New or rotated Teams accounts take effect without restarting the Control Plane.
- Gateway credentials authenticate only ingress and replies. See
  [credential storage](../reference/credential-storage.md).

## If something goes wrong

- **No reply.** Follow the [first-reply checklist](../guides/troubleshooting.md). Confirm that the
  messaging endpoint is publicly reachable over HTTPS and uses the correct tenant ID.
- **The app does not see channel messages.** Confirm that the `team` scope is enabled and the app
  is installed in the intended team.
- **Several tenants are enrolled.** Add `--account TENANT_ID`. See
  [Check the Surface Account](../guides/troubleshooting.md#2-check-the-surface-account).

## Next

- [Add your team's chat](../../README.md#next-add-your-teams-chat)
- [Worker-side collaboration surface tools](worker-tools.md#teams) for Microsoft's preview Agent 365 Teams MCP
  read tool
- [collaboration surface guides](README.md)
