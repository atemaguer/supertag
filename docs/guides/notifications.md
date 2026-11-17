# Set up operator notifications

An operator notification alerts you when an item needs attention in the SuperTag inbox. For
example, a **Task**, one assignment accepted for an AI agent, can wait for approval and alert
your Slack or a webhook. Use notifications when you do not want to keep checking
`supertag get inbox-item`.

The desktop app and the terminal UI notify on their own device when a Tag replies or asks you a
question, with no setup; see
[Notifications in the apps](talk-to-a-tag.md#notifications-in-the-apps). The destinations below
reach people away from the apps.

## Choose destinations

A local `supertag up` configures no destination until you set one. Set `notify` on the
`control-plane` service in `supertag.yaml` to choose one or more:

```yaml
secrets:
  webhook-token:
    environment: SUPERTAG_WEBHOOK_TOKEN
services:
  control-plane:
    type: control-plane
    notify: ["webhook:https://hooks.example/x#webhook-token", slack:U0123456789]
```

The local **Gateway**, which `supertag up` runs beside the Control Plane, delivers to these
destinations. The webhook receives a JSON POST. Its `authorization` header carries `Bearer`
followed by the value of `webhook-token`. The secret comes from the environment or a file named under `secrets:`;
it does not go in the URL. A Slack destination is a channel or user ID, posted with an enrolled Slack **Surface Account**,
the record of one connected Slack workspace whose credentials stay in a vault. Use
`slack:WORKSPACE_ID/CHANNEL_OR_USER_ID` if you enrolled several Slack workspaces.

Run `supertag up` after changing the file so the **Control Plane**, the SuperTag service that
stores and schedules work, and the Gateway pick it up. Send a sample through every
configured destination with `supertag test notification`. A Gateway you run yourself takes the
same destinations as repeated `--notify` options; pass `--gateway URL` to test it. Add `--objective ID` to include a
specific **Objective**, an outcome owned by a [Tag](../reference/glossary.md#tag), in its link
back. The command reports `delivered`, `not configured`, or `failed` for each destination. It sends immediately without creating an
inbox item. Use `supertag get inbox-item` to inspect a notification's delivery status. A notification points to
`supertag describe objective ID` for one item or `supertag get inbox-item --objective ID` for a
digest.

SuperTag sends one alert per operator inbox item: approval requests, an Objective's questions,
budget warnings, deadline and budget limits, uncertain **Task Attempts** (single executions of a
Task), and MCP logins a Task waits on. It groups ordinary alerts for
60 seconds; a digest shows an `…and N more` line when it omits items. A blocking approval goes
out immediately. There are no quiet hours. Progress reports and ordinary reviews do not send an
alert. Failed deliveries retry in the background, up to five attempts.

The webhook JSON body includes `objectiveId`, `kinds`, `count`, `title`, `text`, `command`, and
`itemKeys`. The `command` points back to the relevant Objective or inbox view. Notification text
redacts configured secrets and URLs before delivery.

See the [`notify` reference](../reference/supertag-yaml.md#control-plane-service) for exact forms.
