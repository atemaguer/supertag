# Connect Linear

Connect a Linear workspace so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in an issue or comment. The Linear collaboration
surface uses a personal API key for actions and a signing secret for incoming webhooks.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the SuperTag service that
receives Linear webhooks and posts replies. See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create API keys and webhooks in Linear.
- The `supertag` CLI installed.
- A public HTTPS URL that forwards to the Gateway's Linear listener, `127.0.0.1:3482` by default:
  a tunnel on a laptop, or a reverse proxy beside a hosted Gateway.

## 1. Create a personal API key

In Linear, open **Settings → Security & access → API**. Create a personal API key limited to the
teams SuperTag should serve.

## 2. Create the webhook

Create a webhook for `Issue` and `Comment` events:

```text
https://YOUR_GATEWAY/linear/events
```

Copy its signing secret.

## 3. Enroll the workspace

```sh
supertag setup surface linear
```

Setup verifies the key with Linear, stores the key and signing secret in the credential vault, and
records the workspace in `supertag.yaml` with its listener; `--listen` chooses another. For non-interactive setup, provide
`LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET`.

## 4. Add a team to a Tag

```sh
supertag tag update lead --add-location linear --team-id TEAM_UUID
```

Use the team's UUID, which Linear shows in the team's settings and API responses. If several
workspaces are enrolled, add `--account NAME` with the Surface Account name from setup.

## Check that it worked

Mention `@supertag` in an issue description or comment in that team. The result appears as an issue
comment. Personal API key replies are attributed to the key's owner. The trigger is `@supertag`,
in any letter case.

## Rules

- Linear credentials stay with the Gateway. See
  [credential storage](../reference/credential-storage.md).

## If something goes wrong

- **No reply.** Follow the [first-reply checklist](../guides/troubleshooting.md). Confirm that
  Linear reaches the Gateway over HTTPS and that the webhook sends `Issue` and `Comment` events.
- **The location is refused.** Check the team UUID, and add `--account NAME` when several
  workspaces are enrolled. See
  [Check the Tag locations](../guides/troubleshooting.md#3-check-the-tag-locations).

## Next

- [Add your team's chat](../../README.md#next-add-your-teams-chat)
- [Worker-side collaboration surface tools](worker-tools.md#linear) for permission-scoped Linear tools
  available to a [harness](../reference/glossary.md#harness)
- [collaboration surface guides](README.md)
