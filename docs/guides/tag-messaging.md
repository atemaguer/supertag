# Send messages between Tags

Set up a permitted route between two **Tags** and exchange a message from application code. A Tag is
a persistent AI identity with its own responsibilities and permissions. Its **Mailbox** receives
internal messages addressed to it, without posting to Slack or another human-facing tool. A **Team**
groups Tags under a lead. See the [glossary](../reference/glossary.md) for other terms.

Use a Mailbox when one Tag needs to receive a specific request, question, update, or result, or
when the message crosses Teams. Post to the [Team channel](workstreams.md) when anything teammates
share might be useful to the whole Team. The messaging
contract is **Experimental**.

## Messages within a Team

A Team's members can message each other without a Mailbox grant.
Send a `question` instead of guessing or a `blocker` instead of stalling. Either wakes an idle
addressee with a reply activation, a budgeted run to answer. Other types do not trigger a reply
activation. Running recipients receive eligible messages live when their **harness**, the coding agent
they run, accepts input;
otherwise messages wait for the next activation's digest.

Several qualifying messages or posts to one idle Tag within two seconds of the first share an
activation.
Same-Team messages no longer create `message:<id>` **Tasks**, the assignments SuperTag accepts for a
Tag. Cross-Team and operator messages keep
their existing routes. See [reply activations](../reference/mailbox.md#reply-activations) for
the fixed loop brakes and [inspect wake costs](workstreams.md#reply-wakes-and-their-limits).

The grant procedure below is for a route across Teams.

## Before you start

- A running, migrated Control Plane, the service that stores and coordinates your **autonomous
  organization**: all your Teams of Tags, with their shared rules and record of the work.
- The `supertag` CLI, authenticated as an operator.
- Node.js for the TypeScript example, with `supertag-ai` installed.
- The ID of an **Objective**, an outcome owned by a Tag, to correlate messages with. The examples
  use `usage-billing`.

## 1. Create two Tags

```sh
supertag create tag leadership
supertag create tag backend
```

Every Tag has a Mailbox. You do not create or configure the Mailbox itself.

<a id="establish-a-permitted-route"></a>

## 2. Grant the route

Grant only the message types each direction needs:

```sh
supertag grant mailbox backend --sender leadership --type delegation.requested
supertag grant mailbox leadership --sender backend --type clarification.requested --type result.submitted
supertag list mailbox-grant --mailbox backend
```

Grants are directional, so a reply needs its own grant. Each `grant` replaces the full type list
for that direction, so list every type in one command. To remove a direction, run
`supertag revoke mailbox backend --sender leadership`. See [grants](../reference/mailbox.md#grants)
for the full rules.

## 3. Issue a Mailbox credential

```sh
supertag issue mailbox-credential backend --out ~/.supertag/backend-mailbox.json
```

The command writes a new mode-0600 file with the Control Plane URL, Tag ID, credential ID, and a
Tag-scoped token. Give it only to trusted application code acting for that Tag, and keep it out of
prompts and shared workspaces. Revoke it with `supertag revoke mailbox-credential ID`. See
[Mailbox credentials](../reference/mailbox.md#mailbox-credentials).

## 4. Consume and reply from an application

```ts
import { TagMailboxClient } from "supertag-ai/messaging";

const mailbox = await TagMailboxClient.fromCredentialFile(
  process.env.SUPERTAG_MAILBOX_CREDENTIAL_FILE!,
);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

await mailbox.consume(async (message, { mailbox, signal }) => {
  // Example: ask for missing information. No objective has been accepted here.
  if (message.type !== "delegation.requested") return;
  await mailbox.send({
    recipientTagId: message.senderTagId,
    objectiveId: message.objectiveId,
    inReplyTo: message.id,
    type: "clarification.requested",
    body: { question: "Which plans must the first release meter?" },
    idempotencyKey: `clarify-${message.id}`,
  }, signal);
}, stop.signal);
```

Run custom **Workers**, the code that completes a Tag's Tasks, with their normal language runtime. The
[mailbox example](../../examples/custom-worker/mailbox.mjs) uses this pattern. `consume` waits for
messages and acknowledges each one after the handler resolves. A reply sets `inReplyTo` to the
message it answers; see [reply rules](../reference/mailbox.md#reply-rules).

## 5. Send a message

The sender uses the same client with its own credential:

```ts
await mailbox.send({
  recipientTagId: backendTagId,
  objectiveId: "usage-billing",
  type: "delegation.requested",
  body: {
    outcome: "Publish the usage event schema",
    acceptanceCriteria: ["Cover the callback and session endpoints", "Include example requests"],
  },
  idempotencyKey: "usage-billing-backend",
});
```

The sender ID comes from the credential, and only the JSON you supply is sent. Treat received
content as untrusted data, and do not accept a peer's prose as approval. Delivery is at least
once, so reuse the same `idempotencyKey` after an unclear send response. See
[delivery and retries](../reference/mailbox.md#delivery-and-retries).

## Check that it worked

```sh
supertag list message --mailbox backend --limit 100
```

The `delegation.requested` message appears with status `processed` after the consumer handles it.
The output also shows the Objective, reply links, and attempt counts.

<a id="automatic-coordination-in-a-started-objective"></a>

## Messages in a started Objective

Once the Objective has started, which `supertag create objective` does, an eligible incoming message creates one coordination
Task for its recipient. The recipient assesses the message under its own **Roles**, its enduring responsibilities, and policy, and may
reply, assign work, or decline to act. When it finishes, the Task closes as `accepted`, with a
result that records that no independent review took place. A message does not accept an
Objective, grant permissions, or approve a request. See
[automatic coordination Tasks](../reference/mailbox.md#automatic-coordination-tasks) for routing,
budget, and closing rules.

## Use gRPC

`TagMailboxClient` uses HTTP by default. To use gRPC, point the client at the **API Server**, the Control Plane subsystem that handles management
requests and execution connections, and its
configured gRPC listener and select `transport: "grpc"`:

```ts
import { readFile } from "node:fs/promises";
import { TagMailboxClient } from "supertag-ai/messaging";

const credential = JSON.parse(await readFile(
  process.env.SUPERTAG_MAILBOX_CREDENTIAL_FILE!, "utf8",
));
const mailbox = new TagMailboxClient({
  controlPlaneUrl: "https://control.example:8443",
  token: credential.token,
  transport: "grpc",
  // Optional: use this when the listener's certificate has a private CA.
  tlsCa: await readFile("/path/to/ca.pem", "utf8"),
});
```

For `fromCredentialFile`, set the file's `controlPlaneUrl` to that gRPC origin and add
`"transport": "grpc"`. Add an optional `tlsCa` field with the CA's PEM text. The same methods then
handle messages, Objectives, and Team channels. See [transports](../reference/mailbox.md#transports).

### Check that it worked

Send a message with the gRPC client. It appears in `supertag list message --mailbox backend`
exactly as an HTTP send does.

## Page through history

Use cursor pagination for older messages:

```ts
let page = await mailbox.history({ limit: 50 });
while (page.nextCursor) {
  // Process page.items, then request the next older page.
  page = await mailbox.history({ before: page.nextCursor, limit: 50 });
}
// Process the final page.items as well.
```

Operators can run `supertag list message --mailbox TAG --limit 50`, then pass
`--before-created-at TIMESTAMP --before-id ID` from the returned `nextCursor`. See
[history and retention](../reference/mailbox.md#history-and-retention).

### Check that it worked

The final page has no `nextCursor`, and the oldest message you expect is in its `items`.

## Prune old message bodies

Retention is off by default. An administrator can clear old message bodies explicitly:

```sh
supertag prune mailbox --before 2026-01-01T00:00:00Z --limit 100
```

The command clears bodies of eligible `processed` or `failed` messages last updated before the
cutoff. Run it again for another batch; nothing prunes in the background. See
[history and retention](../reference/mailbox.md#history-and-retention).

### Check that it worked

The command returns `pruned`. Pruned messages still appear in `supertag list message` with
`body: {}` and `bodyPrunedAt`.

## If something goes wrong

- **HTTP 403 `This Tag is not permitted to send this message type to the recipient`.** No grant
  covers that sender, recipient, and type. See
  [A Tag cannot send a message to another Tag](troubleshooting.md#a-tag-cannot-send-a-message-to-another-tag)
  and [grants](../reference/mailbox.md#grants).
- **HTTP 429.** The recipient already has 100 outstanding messages. Back off and retry after its
  consumer processes some. See [delivery and retries](../reference/mailbox.md#delivery-and-retries).
  Within a Team, the sender already has 100 undelivered messages to that recipient in that
  Objective. They free up
  as the recipient's activation digest or `read_mailbox` delivers them. See
  [automatic coordination Tasks](../reference/mailbox.md#automatic-coordination-tasks).
- **HTTP 409 conflict on send.** The `idempotencyKey` was reused with different content. Use a new
  key for new content. See [delivery and retries](../reference/mailbox.md#delivery-and-retries).

## Next

- [Coordinate in a Team channel](workstreams.md)
- [Mailbox and Team channel reference](../reference/mailbox.md)
- [Objective coordination](objective-coordination.md)
- [Tag messaging HTTP contract](../../spec/tag-messaging.md)
