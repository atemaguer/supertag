# Connector contract

A **Connector** links one collaboration surface account to SuperTag. It turns surface events into
[Tasks](glossary.md#task) and delivers each Task's reply back to the surface. The built-in
connectors for Slack, GitHub, Linear, Lark, and Microsoft Teams run inside a
[Gateway](glossary.md#gateway). A connector you write runs as its own process and uses the same
contract.

This page is the exact contract. The messages are defined in
[`proto/supertag/runtime/v2/runtime.proto`](../../proto/supertag/runtime/v2/runtime.proto),
service `supertag.runtime.v2.Connector`.

## Where a connector connects

A connector is a client of the [Control Plane](glossary.md#control-plane). It dials the Control
Plane's endpoint, the same URL Gateways and Worklets use:

| URL scheme | Transport |
| --- | --- |
| `https://HOST[:PORT]` | Native gRPC over HTTP/2 with TLS |
| `wss://HOST[:PORT][/PATH]` | gRPC inside a WebSocket tunnel; the Control Plane's TLS runs end to end inside it |
| `http://127.0.0.1:PORT` | Cleartext, loopback only |

A connector presents a client certificate only when the Control Plane requires one from every
caller (`SUPERTAG_TLS_CLIENT_CA_FILE`), an optional network filter. Its identity comes from the
bearer credential below.

## Protocol negotiation

Before any other call, the connector calls `ProtocolNegotiation.Negotiate` with role
`SERVICE_ROLE_GATEWAY` and the protocol versions it speaks. The Control Plane answers with role
`SERVICE_ROLE_CONTROL_PLANE` and the selected version. Every later call sends that version in the
`x-supertag-protocol` header. A call without it fails with `FAILED_PRECONDITION`.

## Credentials

A connector is an enrolled Gateway. An operator creates a gateway Auth Key, and the connector
enrolls once. `AcceptEvent` serves accounts no Surface Account names, and those admit work on any
Tag, so the key must trust the connector with every Tag:

```sh
supertag auth-key create discord-acme --role gateway --all-tags
supertag gateway enroll discord-acme --control-plane https://cp.example.com \
  --state-directory /var/lib/discord-acme --auth-key file:/run/secrets/auth-key
```

Enrolling stores the connector's own credential, `stcr_` and 64 hex digits, in its state
directory. The Control Plane keeps only its digest. Every call then carries two headers:

| Header | Value |
| --- | --- |
| `authorization` | `Bearer` and the connector's enrolled credential |
| `x-supertag-connector-account` | `ACCOUNT`, the connector account the call acts for |

The Control Plane authenticates the credential as `gateway:NAME` and checks the account against
it. A Surface Account names the Gateway that serves it (`gateway: NAME`), and calls for its
locations from any other Gateway fail with `PERMISSION_DENIED`. An account no Surface Account
names belongs to the first Gateway enrolled with `--all-tags` that acts for it, until that Gateway
is revoked. A Gateway enrolled without `--all-tags` is refused every such account.
`AcceptEvent` also refuses an `account_id` that differs from the header's account. A Gateway
calls only the Connector, reply progress, and operator notification services. It cannot read the
Inbox, submit work, or administer anything. Rotate its credential with
`supertag gateway rotate-credential`, and revoke it with `supertag gateway revoke NAME`.

## Admitting an event

`AcceptEvent(AcceptEventRequest) returns (Task)` turns one surface event into a Task.

| Field | Meaning |
| --- | --- |
| `account_id` | The connector's account, such as `discord/acme` |
| `event_id` | The surface's ID for this event. One event admits one Task |
| `tag_id` | The Tag that answers |
| `session_id` | The Session the Task continues, such as the surface thread |
| `prompt` | The message text |
| `destination.conversation_id`, `destination.thread_id` | Where the reply goes |
| `requested_execution` | Optional execution choice, checked against the Tag's accepted policy |

Retrying is safe. The same `event_id` with the same content returns the same Task. The same
`event_id` with different content fails with `ALREADY_EXISTS`. An account that has a Surface Account
with location policy must use its provider's `Accept*Event` call instead; `AcceptEvent` refuses it with `PERMISSION_DENIED`.

A Task `AcceptEvent` admits always runs as its own turn. It never joins another turn.

## The built-in chat connectors

The Slack, Microsoft Teams and Lark connectors call their provider's call instead:
`AcceptSlackEvent`, `AcceptMicrosoftTeamsActivity` and `AcceptLarkEvent`. Each stores the event
and answers before the connector acknowledges the event to the provider. They differ from
`AcceptEvent` in three ways:

- **A message can join another turn.** If the thread's Session is running, the Control Plane
  offers the new message to that Task Attempt as live input. If the harness takes it, the
  returned Task settles as `SUCCEEDED` with the result `Input accepted by Task ID.` and gets no
  reply. Otherwise it waits, and the next claim in the Session joins it to the Task it starts:
  `Assignment.joined` lists it, and it settles the same way.
- **A refused message gets one answer and no Task.** When the thread's Objective takes no new work,
  or the message mentions another Tag in a thread that belongs to one, the call returns no Task.
  The Control Plane queues one reply to the thread that says why, and records the refusal with the
  event. A redelivery of the event, or of the same message under another event ID, returns no Task
  and queues nothing.
- **Some errors are final.** `ALREADY_EXISTS`, a known event or message with different content, and
  `INVALID_ARGUMENT`, a malformed event, can never succeed on a retry. The built-in Gateways
  acknowledge such an event to the provider and log it. They leave any other error
  unacknowledged, so the provider delivers the event again.

Slack's acknowledgement message follows the run, not the message. Only a message that starts a
run gets a "Got it" post at admission; a message that waits gets it when its run starts. A message
that joins a run adds "Also reading your follow-up." to that run's acknowledgement.

## Owning an account's delivery

One connector at a time delivers an account's replies. It holds the account with a lease:

| Call | Effect |
| --- | --- |
| `ClaimConnector { owner_id }` | Grants the account to `owner_id` if no one else holds it. `granted` is false with `retry_after_ms` otherwise |
| `RenewConnector { lease_token }` | Extends the lease before `valid_for_ms` runs out |
| `ReleaseConnector { lease_token }` | Hands the account to the next claimant at once, for example on shutdown |

## Delivering replies

| Call | Effect |
| --- | --- |
| `ClaimReply { operation_id, connector_lease_token, wait_ms }` | Leases the next due reply for the account. With `wait_ms`, a claim that finds none is held until one is due, for at most 8 seconds; `reply` is empty when none became due. Repeating an `operation_id` returns the same claim |
| `RenewReply { reply_id, lease_token }` | Extends a reply lease while a slow post is in flight |
| `SettleReply { reply_id, lease_token, state, provider_receipt }` | Records the outcome: `REPLY_STATE_DELIVERED` with the surface's receipt, `REPLY_STATE_FAILED`, or `REPLY_STATE_UNCERTAIN` when the surface may have posted it |

Hold the claim instead of polling: a held claim writes nothing while it waits, answers as soon as
a reply is due, and answers empty at once when the Control Plane shuts down. Keep `wait_ms` short
enough to renew the account's lease on time, and claim again when the answer is empty. Without
`wait_ms` the claim answers at once.

A reply answers one Task, named by `task_id`. A notice the Control Plane posts on its own, such as
the answer to a refused message, has an empty `task_id`; deliver it the same way.

Delivery is at least once. A connector that crashes after posting and before settling sees the
reply again once its lease lapses. To post exactly once, record each claimed reply durably before
posting, and settle a reply you might have posted as `REPLY_STATE_UNCERTAIN`. An operator then
resolves it with evidence from the surface. A reply you never started posting is not uncertain,
for example when the Control Plane restarted before `RenewReply` could confirm a new claim:
repeat `ClaimReply` with the same `operation_id` to get the same claim back and post it then.

## Example

[`core/crates/cli/fixtures/example_connector.rs`](../../core/crates/cli/fixtures/example_connector.rs)
is a complete connector in one file. It depends only on the protocol crate.
`core/crates/cli/tests/external_connector_runtime.rs` runs it as a separate process against a real
Control Plane on SQLite and PostgreSQL: it admits an event, replays it, delivers the reply once,
and releases the account.

The example dials cleartext, so it reaches only a Control Plane on loopback. A connector for a
remote Control Plane adds TLS, and a client certificate only when the Control Plane requires one,
as described above.

```text
supertag-example-connector accept http://127.0.0.1:3434 discord/acme EVENT TAG SESSION CHANNEL "text"
supertag-example-connector deliver http://127.0.0.1:3434 discord/acme
```
