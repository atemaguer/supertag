# Connect Linear

Connect a Linear workspace so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in an issue or comment. The Linear collaboration
surface uses a personal API key for actions and a signing secret for incoming webhooks.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the part of the **Control Plane**, the SuperTag service, that
receives Linear webhooks. See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create API keys and webhooks in Linear.
- The `supertag` CLI installed.
- A Gateway that Linear can reach over HTTPS.

## 1. Create a personal API key

In Linear, open **Settings → Security & access → API**. Create a personal API key limited to the
teams SuperTag should serve.

## 2. Create the webhook

Create a webhook for `Issue` and `Comment` events:

```text
https://YOUR_GATEWAY/webhooks/linear
```

Copy its signing secret.

## 3. Enroll the workspace

```sh
supertag setup surface linear
```

The CLI verifies the key, stores non-secret workspace metadata in the database, and keeps
credentials behind the Control Plane's secret boundary. For non-interactive setup, provide
`LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET`.

### Or declare the workspace in a manifest

On a shared Control Plane managed from files, declare the workspace instead of running setup. The
manifest says where each secret comes from, never the value:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-linear
spec:
  provider: linear
  secrets:
    apiKey: { env: LINEAR_API_KEY }
    webhookSecret: { env: LINEAR_WEBHOOK_SECRET }
```

Run `supertag apply -f acme-linear.yaml`. Apply verifies the key with Linear, as setup does. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

## 4. Add a team to a Tag and start

```sh
supertag create tag engineering
supertag update tag engineering --add-location linear --team ENG
supertag start control-plane
```

SuperTag resolves the team key or name to its stable UUID. If you already know it, use
`--team-id UUID`. If several workspaces are enrolled, add `--account WORKSPACE_ID`.

## Check that it worked

Mention `@supertag` in an issue description or comment in that team. The result appears as an issue
comment. Personal API key replies are attributed to the key's owner.

## Change the mention trigger

Override the trigger with `--linear-mention @NAME` on `supertag start control-plane` when needed.

### Check that it worked

Mention `@NAME` in an issue in that team. The result appears as an issue comment.

## Rules

- Linear credentials stay behind the Control Plane's secret boundary. See
  [credential storage](../reference/credential-storage.md).
- OAuth enrollment can later provide a dedicated integration identity without changing Tag routing.

## If something goes wrong

- **No reply.** Follow the [first-reply checklist](../guides/troubleshooting.md). Confirm that
  Linear reaches the Gateway over HTTPS and that the webhook sends `Issue` and `Comment` events.
- **The team is not found.** Use `--team-id UUID`, or add `--account WORKSPACE_ID` when several
  workspaces are enrolled. See
  [Check the Tag locations](../guides/troubleshooting.md#3-check-the-tag-locations).

## Next

- [Add your team's chat](../../README.md#next-add-your-teams-chat)
- [Worker-side collaboration surface tools](worker-tools.md#linear) for permission-scoped Linear tools
  available to a [harness](../reference/glossary.md#runtime)
- [collaboration surface guides](README.md)
