# Set up operator notifications

An operator notification alerts you when an item needs attention in the SuperTag inbox. For
example, a **Task**, one assignment accepted for an AI agent, can wait for approval and alert the
computer running `supertag up`. Use
notifications when you do not want to keep checking `supertag list inbox`.

## Choose destinations

On macOS and Linux, a local `supertag up` enables desktop notifications when `notify` is unset.
macOS uses Notification Center through `osascript`. Linux uses `notify-send` when installed.
The inbox records `unavailable` when the desktop notifier cannot run.

Set `notify` on the `control-plane` service in `supertag.yaml` to choose one or more destinations:

```yaml
secrets:
  webhook-token:
    environment: SUPERTAG_WEBHOOK_TOKEN
services:
  control-plane:
    type: control-plane
    notify: [desktop, "webhook:https://hooks.example/x#webhook-token", slack:U0123456789]
```

The webhook receives a JSON POST. Its `authorization` header carries `Bearer` followed by the
value of `webhook-token`. The secret comes from the environment or a file named under `secrets:`;
it does not go in the URL. A Slack destination uses an enrolled Slack **Surface Account**, the record of one connected Slack
workspace whose credentials stay in a vault. Use
`slack:WORKSPACE_ID/USER_ID` if you enrolled several Slack workspaces.

Restart the **Control Plane**, the SuperTag service that stores and schedules work, with
`supertag up` after changing the file. Send a sample through every
configured destination with `supertag test notification`. Add `--objective ID` to include a
specific **Objective**, an outcome owned by a [Tag](../reference/glossary.md#tag), in its link
back. The command reports `delivered`, `unavailable`,
`not configured`, or `failed` for each destination. It sends immediately without creating an
inbox item. Use `supertag list inbox` to inspect a notification's delivery status. A notification points to
`supertag describe objective ID` for one item or `supertag list inbox --objective ID` for a
digest.

SuperTag sends owner decision requests, open high-severity review findings, stalled Objectives,
uncertain **Task Attempts** (single executions of a Task), and budget and deadline limits. It groups ordinary alerts for
60 seconds; a digest shows an `…and N more` line when it omits items. A blocking approval goes
out immediately. There are no quiet hours. Progress reports and ordinary reviews do not send an
alert. Failed deliveries retry in the background; desktop has three attempts, while webhook and
Slack have five.

The webhook JSON body includes `objectiveId`, `kinds`, `count`, `title`, `text`, `command`, and
`itemKeys`. The `command` points back to the relevant Objective or inbox view. Notification text
redacts configured secrets and URLs before delivery.

See the [`notify` reference](../reference/supertag-yaml.md#control-plane-service) for exact forms.
