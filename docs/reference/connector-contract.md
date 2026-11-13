# Connector contract

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

Over TLS, the connector must present a client certificate that the Control Plane verifies, so a
Control Plane that serves connectors or Gateways requires client certificates
(`SUPERTAG_TLS_CLIENT_CA_FILE`). Without one, the Control Plane refuses the Gateway token with
`PERMISSION_DENIED`. Over loopback cleartext, no certificate is needed. Every call also carries
the bearer credential below.

## Protocol negotiation

Before any other call, the connector calls `ProtocolNegotiation.Negotiate` with role
`SERVICE_ROLE_GATEWAY` and the protocol versions it speaks. The Control Plane answers with role
`SERVICE_ROLE_CONTROL_PLANE` and the selected version. Every later call sends that version in the
`x-supertag-protocol` header. A call without it fails with `FAILED_PRECONDITION`.

## Credentials

Every call carries two headers:

| Header | Value |
| --- | --- |
| `authorization` | `Bearer` and the deployment's Gateway token (`SUPERTAG_GATEWAY_TOKEN`) |
| `x-supertag-principal` | `connector:ACCOUNT`, where `ACCOUNT` is the account the call acts for |

The Control Plane takes the principal as the connector names it. `AcceptEvent` refuses an
`account_id` that differs from the principal's account with `PERMISSION_DENIED`, but that only
checks the request against its own header: whoever holds the Gateway token can name any account,
and any operator for the operator notification calls. The Gateway token is shared by every Gateway
and connector of a deployment. Give it only to processes you trust with every account, and keep it
as private as the Control Plane's database credential.

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
