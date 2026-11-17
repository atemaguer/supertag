# supertag-ai

**TypeScript SDK for SuperTag.**

SuperTag runs persistent, proactive, multiplayer AI actors for engineering work. A **Tag** is a persistent AI actor with a
stable identity, responsibilities, permissions, and work history; it runs its work on the coding
agents you already use. The `supertag` CLI, the Control Plane, the Gateway, and Worker Hosts are
native programs; see the
[installation guide](https://github.com/atemaguer/supertag/blob/main/docs/operations/install.md).

This package is the TypeScript SDK. It has two entry points:

- `supertag-ai/gateway-client`: `createGatewayClient` connects an operator application
  to a SuperTag Gateway over gRPC. It negotiates the SuperTag protocol version before its
  first call and names it on every call.
- `supertag-ai/harness`: `openHarness` reads the execution bootstrap a Worker Host writes to a
  harness adapter's standard input and connects to the Worker Host's private harness service for
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

Use Node.js 22.13.0 or newer. SuperTag is below version 1.0; the
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md)
describes compatibility.

[Documentation](https://github.com/atemaguer/supertag/blob/main/docs/README.md) ·
[Repository](https://github.com/atemaguer/supertag) ·
[Changelog](https://github.com/atemaguer/supertag/blob/main/CHANGELOG.md)
