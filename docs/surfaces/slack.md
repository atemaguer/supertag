# Connect Slack

Connect a Slack workspace so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in a channel. Use Socket Mode for the shortest local
setup, and HTTP ingress only when SuperTag already has a stable public HTTPS URL.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the part of the **Control Plane**, the SuperTag service, that
receives and sends collaboration surface traffic. Each mention becomes a **Task**, one request
accepted for a Tag. See the [glossary](../reference/glossary.md) for other terms.

| Gateway | Setup command | Credentials |
| --- | --- | --- |
| Local | `supertag setup surface slack` | bot token + app-level token |
| Hosted | `supertag setup surface slack --transport http` | bot token + signing secret |

## Before you start

- Permission to create and install apps in the Slack workspace.
- The `supertag` CLI installed.
- A public Slack channel for the Tag. The starter manifest supports public channels only.

## 1. Create the Slack app

Open [Slack API Apps](https://api.slack.com/apps) and create an app from a manifest. Paste
[`slack-app-manifest.yaml`](slack-app-manifest.yaml) and install the app to the workspace.

The manifest grants `app_mentions:read`, `channels:history`, and `chat:write`; subscribes to
`app_mention` and `message.channels`; and enables Socket Mode. The history scope lets Slack deliver
ordinary public-channel thread replies to the app. It does not expose Slack history to the
**Worker**, the code that completes a Task.

## 2. Copy the two tokens

Copy the Bot User OAuth Token (`xoxb-…`) from **OAuth & Permissions** after installing. Then, under
**Basic Information** > **App-Level Tokens**, create an app-level token (`xapp-…`) with
`connections:write`.

## 3. Start the Control Plane

If you ran `supertag init`, the local Control Plane is already running in the background, and
the next commands use it from any directory. Otherwise, start a local Control Plane in one terminal
and keep it running:

```sh
supertag start control-plane
```

## 4. Enroll the Slack credentials

From any terminal, run:

```sh
supertag setup surface slack
```

Setup asks for both tokens. For non-interactive setup, provide `SLACK_BOT_TOKEN` plus either
`SLACK_APP_TOKEN` or `SLACK_SIGNING_SECRET`.

### Or declare the account in a manifest

On a shared Control Plane managed from files, declare the workspace instead of running setup. The
manifest says where each token comes from, never the token itself:

```yaml
apiVersion: supertag/v1
kind: SurfaceAccount
metadata:
  name: acme-slack
spec:
  provider: slack
  configuration:
    transport: socket        # or http, with signingSecret instead of appToken
  secrets:
    botToken: { env: SLACK_BOT_TOKEN }
    appToken: { env: SLACK_APP_TOKEN }
```

Run `supertag apply -f acme-slack.yaml`. Apply checks the tokens with Slack, as setup does, and
stores them in the credential vault. A Tag location can then use `account: acme-slack`. See
[Declare Surface Accounts](../operations/resources.md#declare-surface-accounts).

## 5. Add a channel to a Tag

Invite the Slack app to the channel, then find its stable channel ID. In Slack, open the channel,
select the channel name at the top, and find **Channel ID** at the bottom of the **About** tab. You
can also choose **Copy link** from the channel menu; the ID is the `C…` or `G…` value at the end
of that link.

Declare the channel as one of the Tag's locations in a manifest, such as `tag.yaml`, and apply it
with `supertag apply -f tag.yaml`. For the `lead` Tag that `supertag init` creates:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: lead
spec:
  roles: [Lead]
  locations:
    - provider: slack
      channelId: C0123456789
      workspaces: [app]
```

Or create a Tag and add the channel from the CLI:

```sh
supertag create tag engineering
supertag update tag engineering --add-location slack --channel-id C0123456789
```

## Check that it worked

Mention `@SuperTag` in that channel to start a thread. The Tag replies in the same thread.

To check the connection before any **Worker Host**, a machine or sandbox that runs work, serves the
Tag, use a Control Plane started with `supertag start control-plane` and no **Worklet**, the program
that connects a Worker Host to the Control Plane. Its built-in smoke-test responder answers every
mention with a fixed reply. That reply proves Slack delivery, Tag routing, and reply delivery
without a model sign-in. Connect a [Worker](../guides/workers.md) for real answers.

After that first mention, human replies in the thread continue the same **Session**, the group of
Tasks from one conversation, without another mention. This holds after a Control Plane restart and
for ordinary requests and for conversations about an **Objective**, an outcome a Tag owns with
success criteria.

A completed [work Session](../concepts/tasks.md#session) can show a result card beside its
reply. The card shows the branch that holds its changes and links to any GitHub pull request
recorded for the work.

## Link a channel to a repository

To have `@SuperTag objective ...` in a channel work in a repository, name a **Workspace**, a named
repository that an Objective's Tasks work in, on that location in the Tag manifest:

```yaml
apiVersion: supertag/v1
kind: Tag
metadata:
  name: engineering
spec:
  locations:
    - provider: slack
      channelId: C0123456789
      workspaces: [app]
```

Every Objective created from that channel then names `app`. The message itself needs no extra
syntax. See [Start from Slack or GitHub](../guides/workspaces.md#start-from-slack-or-github).

## Use hosted HTTP ingress

For a Gateway with a stable public HTTPS URL, run:

```sh
supertag setup surface slack --transport http
```

Then set Slack's Request URL:

```text
https://YOUR_GATEWAY/webhooks/slack/WORKSPACE_ID
```

The Gateway checks Slack's timestamp and signature. The Control Plane stores the event before
acknowledging it.

### Check that it worked

Mention `@SuperTag` in the added channel. The Tag replies in the thread, as with Socket Mode.

## Send inbox items to an operator channel

The operator inbox lists what needs a person, such as approval requests and questions from an
Objective owner. An Objective created in Slack reports these in its own thread. For Objectives
started elsewhere, the Control Plane can post them to one Slack channel or to one person.

1. Pick the destination. For a channel, invite the Slack app to it and copy its channel ID. For a
   person, copy their member ID: open their profile, choose **More**, then **Copy member ID**.
   A direct message appears in the app's **Messages** tab; enable that tab under **App Home** if it
   is off.
2. Add the setting to the Control Plane's environment and restart it:

   ```sh
   SUPERTAG_OPERATOR_CHANNEL=slack:C0123456789
   ```

   If more than one Slack workspace is connected, name the workspace:
   `slack:T0123456789/C0123456789`.

The app uses its existing bot token and `chat:write`; no new scope is needed.

### Check that it worked

Create an Objective from the CLI whose owner needs an approval or asks you a question. Within a few
seconds, a short message appears in the channel. It ends with the command to act, such as:

```text
Objective usage-dashboard needs you: Approval 5c1e9a40-2b7d-4f0e-9a51-3d6c8e2f1b07 (work is waiting): Merge pull request 42 (requested by Tag reviewer)
supertag approve request 5c1e9a40-2b7d-4f0e-9a51-3d6c8e2f1b07
```

Batching and retry rules are in
[Operator channel](../operations/control-plane.md#operator-channel).

## Give a harness broader Slack reads

Adding a Tag to a channel does not give its **harness**, the connection between the Worker and an
agent system, the channel history. Grant `slack/slack_read_channel` on `channel:CHANNEL_ID` through
a **Permission Set**, a set of allowed actions, then
configure the Slack MCP preset on the Worker Host. See [MCP tools](worker-tools.md).

## Rules

- A channel without a Tag fails before the Control Plane accepts a Task.
- Bot messages, messages in unrelated threads, and replies in inactive threads do not invoke the Tag.
- Each message still goes through the current channel configuration and authorization.
- The starter manifest does not request `groups:history` or subscribe to `message.groups`, so thread
  replies in a private channel would not reach the app.
- Gateway credentials authenticate only ingress and replies. See
  [credential storage](../reference/credential-storage.md).

## If something goes wrong

If the first mention does not produce a reply, use the shared
[first-reply checklist](../guides/troubleshooting.md). For Slack specifically, confirm that:

- the app is invited to the exact channel;
- Socket Mode is enabled;
- the app has the scopes `app_mentions:read`, `channels:history`, and `chat:write`;
- the app subscribes to the events `app_mention` and `message.channels`.

To check the enrolled account, see
[Check the Surface Account](../guides/troubleshooting.md#2-check-the-surface-account).

## Next

- [Add your team's chat](../../README.md#next-add-your-teams-chat)
- [Add another collaboration surface](README.md#add-another-surface)
- [Slack MCP tools](worker-tools.md#slack)
