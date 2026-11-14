# Connect Microsoft Teams

Connect a Microsoft Teams tenant so a **Tag**, a persistent AI actor with its own
responsibilities and permissions, replies when someone mentions it in a channel. Teams requires a
single-tenant Entra application, a bot or agent resource, and a Teams app installed in the target
team.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the SuperTag service that
receives Microsoft Teams messages and posts replies. See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to register an Entra application and install apps in the target team.
- The `supertag` CLI installed.
- A public HTTPS URL that forwards to the Gateway's Teams listener, `127.0.0.1:3483` by default:
  a temporary tunnel for development, or a reverse proxy beside a hosted Gateway.

## 1. Create the Entra app and bot

Create a single-tenant Entra app registration and client secret. Then create the bot or agent
resource for that application ID.

## 2. Set the messaging endpoint

```text
https://YOUR_GATEWAY/microsoft-teams/messages
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

## 5. Add a channel to a Tag

A copied Teams channel link contains the channel ID in its path and the team ID in its `groupId`
query parameter.

```sh
supertag tag update lead --add-location teams \
  --team-id '19:TEAM_ID@thread.tacv2' \
  --channel-id '19:CHANNEL_ID@thread.tacv2'
```

If several tenants are enrolled, add `--account NAME`, the Surface Account name from setup.

## Check that it worked

Mention `@SuperTag` in that channel. The Tag replies in the originating thread. The Gateway checks
the Microsoft activity token, and the Control Plane stores the accepted **Task**, one request for the Tag,
before replying through
the Gateway.

## Rules

- This first version supports channel mentions and replies. Personal chat, group chat, proactive
  messages, and files or cards are outside this path.
- Gateway credentials authenticate only ingress and replies. See
  [credential storage](../reference/credential-storage.md).

## If something goes wrong

- **No reply.** Follow the [first-reply checklist](../guides/troubleshooting.md). Confirm that the
  messaging endpoint is publicly reachable over HTTPS and forwards to the Gateway's listener.
- **The app does not see channel messages.** Confirm that the `team` scope is enabled and the app
  is installed in the intended team.
- **Several tenants are enrolled.** Add `--account NAME`. See
  [Check the Surface Account](../guides/troubleshooting.md#2-check-the-surface-account).

## Next

- [Worker-side collaboration surface tools](worker-tools.md#teams) for Microsoft's preview Agent 365 Teams MCP
  read tool
- [collaboration surface guides](README.md)
