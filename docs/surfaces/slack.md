# Connect Slack

Connect a Slack workspace so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in a channel. The **Gateway**, the SuperTag service
that carries collaboration surface traffic, receives Slack's events over HTTPS and replies in the
thread. Each mention becomes a **Task**, one request accepted for a Tag. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create and install apps in the Slack workspace.
- SuperTag running, from `supertag init` or a [deployment](../guides/self-hosting.md).
- A public HTTPS URL that forwards to the Gateway's Slack listener. Slack delivers events only to
  a public URL. Locally, use a tunnel such as `cloudflared` or `ngrok` to `127.0.0.1:3480`; on a
  server, a reverse proxy beside the Gateway.
- A public Slack channel for the Tag. The starter manifest supports public channels only.

## 1. Create the Slack app

Open [Slack API Apps](https://api.slack.com/apps) and create an app from a manifest. Paste
[`slack-app-manifest.yaml`](slack-app-manifest.yaml), replace `YOUR_PUBLIC_HOST` with your public
host, and install the app to the workspace.

The manifest grants `app_mentions:read`, `channels:history`, and `chat:write`, and subscribes to
`app_mention` and `message.channels`. The history scope lets Slack deliver ordinary thread replies
to the app. It does not give the Tag's agent Slack history.

Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**, and the **Signing
Secret** from **Basic Information**.

## 2. Enroll the account

```sh
supertag setup surface slack
```

Setup asks for both values with masked prompts, or reads `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET`. It checks the token with Slack, stores both in the credential vault, and
records the account in `~/.supertag/supertag.yaml` with its listener, `127.0.0.1:3480` by default
(`--listen` chooses another). The local Gateway restarts to serve it.

Point your tunnel or proxy at the listener. Slack's Request URL is
`https://YOUR_PUBLIC_HOST/slack/events`; Slack verifies it when you save the app's event settings.

## 3. Add a channel to a Tag

Invite the Slack app to the channel, then find its stable channel ID: open the channel, select
its name, and find **Channel ID** at the bottom of the **About** tab.

```sh
supertag tag update lead --add-location slack --channel-id C0123456789
```

`--allowed-user U0123456789` limits who may ask the Tag for work there; repeat it for more users.
The local Gateway serves one location per Surface Account; remove a location with
`--remove-location slack` before adding another.

## Check that it worked

Mention `@SuperTag` in the channel. The Tag replies in a thread. Later replies in the thread
continue the same **Session**, one thread of the Tag's work, without another mention.

## Use a hosted Gateway

On a shared deployment, enroll the account against the Control Plane and name the Gateway that
serves it:

```sh
supertag setup surface slack --control-plane team --gateway local
```

Then start that Gateway with `--slack-listen 127.0.0.1:3480 --slack-state-directory
/var/lib/supertag/slack`, behind a reverse proxy that forwards `/slack/events`. See
[Self-host SuperTag](../guides/self-hosting.md).

## Send inbox items to Slack

The Gateway can tell you about operator inbox items, such as questions and approvals, in a
channel or a direct message. Set `notify: slack:C0123456789` on the `control-plane` service in
`supertag.yaml`, or `--notify slack:C0123456789` on a hosted Gateway. Use a member ID, such as
`slack:U0123456789`, for a direct message. See [Set up operator notifications](../guides/notifications.md).

## Give a Tag's agent Slack tools

A channel location does not give the Tag's agent channel history or other Slack tools. Grant
them through a **Permission Set**, a set of allowed actions, and the Slack MCP preset on the
Worker Host. See [MCP tools](worker-tools.md).

## Rules

- A channel without a Tag location starts no Task.
- Bot messages, messages in unrelated threads, and replies in inactive threads do not invoke the
  Tag.
- Each message goes through the channel's current location and authorization.
- The Gateway checks Slack's timestamp and signature, and the Control Plane stores the event
  before the Gateway acknowledges it.
- The starter manifest does not subscribe to private channel messages.

## If something goes wrong

Use the [first-reply checklist](../guides/troubleshooting.md). For Slack, also confirm that:

- the Request URL reaches the Gateway's listener, and Slack shows it as verified;
- the app is invited to the exact channel;
- the app has the scopes and events listed in step 1.

## Next

- [Add another collaboration surface](README.md)
- [Slack MCP tools](worker-tools.md#slack)
