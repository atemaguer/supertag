# Connect Slack

Connect a Slack workspace so a **Tag**, a persistent AI actor with its own responsibilities and
permissions, replies when someone mentions it in a channel. The **Gateway**, the SuperTag service
that carries collaboration surface traffic, receives Slack's events and replies in the thread. By
default it opens an outbound Socket Mode connection to Slack, so it needs no public URL. Each mention becomes a **Task**, one request accepted for a Tag. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create and install apps in the Slack workspace.
- SuperTag running, from `supertag init` or a [deployment](../guides/self-hosting.md).
- A public Slack channel for the Tag. The starter manifest supports public channels only.

## 1. Create the Slack app

Open [Slack API Apps](https://api.slack.com/apps) and create an app from a manifest. Paste
[`slack-app-manifest.yaml`](slack-app-manifest.yaml), which turns on Socket Mode, and install the
app to the workspace.

The manifest grants `app_mentions:read`, `channels:history`, and `chat:write`, and subscribes to
`app_mention` and `message.channels`. The history scope lets Slack deliver ordinary thread replies
to the app. It does not give the Tag's agent Slack history.

Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**. Under **Basic
Information**, generate an **App-Level Token** with the `connections:write` scope and copy it
(`xapp-…`).

## 2. Enroll the account

```sh
supertag setup surface slack
```

Setup asks for both tokens with masked prompts, or reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
It checks the bot token with Slack and the app-level token by opening a Socket Mode connection,
stores both in the credential vault, and records the account in `~/.supertag/supertag.yaml` with
`transport: socket`. The local Gateway restarts and connects to Slack.

### Receive events over HTTP instead

Slack can instead deliver events as signed webhooks to a public HTTPS URL. Set
`socket_mode_enabled: false` and `request_url: https://YOUR_PUBLIC_HOST/slack/events` in the app
manifest, copy the **Signing Secret** from **Basic Information**, and enroll with:

```sh
supertag setup surface slack --transport http
```

Setup reads the signing secret from a masked prompt or `SLACK_SIGNING_SECRET`, and records
`transport: http` with the listener, `127.0.0.1:3480` by default (`--listen` chooses another).
Forward the public URL to the listener with a tunnel such as `cloudflared` or `ngrok`, or a
reverse proxy on a server. Slack verifies the Request URL when you save the app's event settings.

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

Then start that Gateway with `--slack-socket-mode --slack-state-directory
/var/lib/supertag/slack`. It reads the app-level token from `SUPERTAG_SLACK_APP_TOKEN` or the
credential vault, and needs no inbound traffic, so it also runs on Render, Modal, and Cloudflare.
For HTTP events, use `--slack-listen 127.0.0.1:3480` instead, behind a reverse proxy that forwards
`/slack/events`. See [Self-host SuperTag](../guides/self-hosting.md).

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
- The Control Plane stores each event before the Gateway acknowledges it. Over Socket Mode, an
  event the Control Plane did not accept stays unacknowledged, and Slack delivers it again. Over
  HTTP, the Gateway also checks Slack's timestamp and signature.
- Over Socket Mode, the Gateway reconnects when Slack asks it to or the connection drops. It stops
  with an error when Slack refuses the app-level token or Socket Mode is turned off for the app.
- The starter manifest does not subscribe to private channel messages.

## If something goes wrong

Use the [first-reply checklist](../guides/troubleshooting.md). For Slack, also confirm that:

- Socket Mode is on for the app and the app-level token has `connections:write`; or, for HTTP
  events, the Request URL reaches the Gateway's listener and Slack shows it as verified;
- the app is invited to the exact channel;
- the app has the scopes and events listed in step 1.

## Next

- [Add another collaboration surface](README.md)
- [Slack MCP tools](worker-tools.md#slack)
