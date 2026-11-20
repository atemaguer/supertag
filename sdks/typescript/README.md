# supertag-ai

**TypeScript SDK for SuperTag.**

SuperTag runs persistent, proactive, multiplayer AI actors for engineering work. A **Tag** is a persistent AI actor with a
stable identity, responsibilities, permissions, and work history; it runs its work on the coding
agents you already use. The `supertag` CLI, the Control Plane, the Gateway, and the Worklet that
connects each Worker Host are native programs; see the
[installation guide](https://github.com/atemaguer/supertag/blob/main/docs/operations/install.md).

This package is the TypeScript SDK. It has two entry points:

- `supertag-ai/gateway-client`: `createGatewayClient` connects an operator application
  to a SuperTag Gateway over gRPC. It negotiates the SuperTag protocol version before its
  first call and names it on every call.
- `supertag-ai/harness`: `openHarness` reads the execution bootstrap a Worklet writes to a
  harness adapter's standard input and connects to the Worklet's private harness service for
  that one Task, including Worker-managed effect receipts. Each event an adapter publishes names
  its `TaskEventKind`: a whole message, an activity line, or a plan.

```sh
npm install supertag-ai
```

```ts
import { createGatewayClient } from "supertag-ai/gateway-client";

const client = createGatewayClient({
  url: "https://gateway.example.com",
  token: process.env.SUPERTAG_OPERATOR_TOKEN!,
});
try {
  const { tags } = await client.operator.listTags({});
  console.log(tags.map((tag) => tag.tagId));
} finally {
  client.close();
}
```

The URL is an `https://` origin, a loopback `http://` origin, or a WebSocket tunnel URL: `wss://`,
or loopback `ws://`, with an optional path. A tunnel carries the same gRPC connection for hosts
whose proxy forwards only HTTP/1.1, and the Gateway's own TLS runs end to end inside a `wss://`
tunnel. The token is an operator token, Operator Token, enrolled credential, or Auth Key. Where
Node.js can read them (`tls.getCACertificates`), the client trusts the operating system's
certificate authorities as well as Node.js's own; pass `ca` for a Gateway with a private
certificate. Connecting times out after 5 seconds, or 30 through a tunnel; `connectTimeoutMs`
changes it.

Besides the operator services, the client has `enrollments` (`whoAmI`, and `enroll` with an
Auth Key), `memories`, `networkLogs`, `schedules`, and `taskFiles`. A Gateway from a SuperTag
release that speaks none of this client's protocol versions (`PROTOCOL_VERSIONS`) rejects every
call with `ProtocolMismatchError`, whose `peerVersions` and `peerBuild` name the Gateway's
release when it gave them. `client.negotiate()` checks this without sending the token, and
`client.negotiation()` also returns the Gateway's release (`gatewayBuild`). `buildVersion` names
your application's release to the Gateway.

Use Node.js 22.13.0 or newer. SuperTag is below version 1.0; the
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md)
describes compatibility.

[Documentation](https://github.com/atemaguer/supertag/blob/main/docs/README.md) ·
[Repository](https://github.com/atemaguer/supertag) ·
[Changelog](https://github.com/atemaguer/supertag/blob/main/CHANGELOG.md)
