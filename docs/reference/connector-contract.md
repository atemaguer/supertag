# Connector contract

<!-- supertag-cli: native -->

A **Connector** links one collaboration surface account to SuperTag. It turns surface events into
[Tasks](glossary.md#task) and delivers each Task's reply back to the surface. The built-in
connectors for Slack, GitHub, Linear, Lark, and Microsoft Teams run inside a
[Gateway](glossary.md#gateway). A connector you write runs as its own process and uses the same
contract.

This page is the exact contract. The messages are defined in
[`rust/proto/supertag/runtime/v2/runtime.proto`](../../rust/proto/supertag/runtime/v2/runtime.proto),
service `supertag.runtime.v2.Connector`.

## Where a connector connects

A connector is a client of the [Control Plane](glossary.md#control-plane). It dials the Control
Plane's public endpoint, the same URL operators and Worker Hosts use:

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
| `ClaimReply { operation_id, connector_lease_token }` | Leases the next due reply for the account. `reply` is empty when none is due. Repeating an `operation_id` returns the same claim |
| `RenewReply { reply_id, lease_token }` | Extends a reply lease while a slow post is in flight |
| `SettleReply { reply_id, lease_token, state, provider_receipt }` | Records the outcome: `REPLY_STATE_DELIVERED` with the surface's receipt, `REPLY_STATE_FAILED`, or `REPLY_STATE_UNCERTAIN` when the surface may have posted it |

Delivery is at least once. A connector that crashes after posting and before settling sees the
reply again once its lease lapses. To post exactly once, record each claimed reply durably before
posting, and settle a reply you might have posted as `REPLY_STATE_UNCERTAIN`. An operator then
resolves it with evidence from the surface.

## Example

[`rust/crates/cli/fixtures/example_connector.rs`](../../rust/crates/cli/fixtures/example_connector.rs)
is a complete connector in one file. It depends only on the protocol crate.
`rust/crates/cli/tests/external_connector_runtime.rs` runs it as a separate process against a real
Control Plane on SQLite and PostgreSQL: it admits an event, replays it, delivers the reply once,
and releases the account.

The example dials cleartext, so it reaches only a Control Plane on loopback. A connector for a
remote Control Plane adds TLS with a client certificate, as described above.

```text
supertag-example-connector accept http://127.0.0.1:3434 discord/acme EVENT TAG SESSION CHANNEL "text"
supertag-example-connector deliver http://127.0.0.1:3434 discord/acme
```
