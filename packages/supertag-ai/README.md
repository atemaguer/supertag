# supertag-ai

**TypeScript SDK for SuperTag.**

SuperTag runs persistent AI actors for engineering work. A **Tag** is a persistent AI actor with a
stable identity, responsibilities, permissions, and work history; it runs its work on the coding
agents you already use. The `supertag` CLI, the Control Plane, the Gateway, and Worker Hosts are
native programs; see the
[installation guide](https://github.com/atemaguer/supertag/blob/main/docs/operations/install.md).

This package is the TypeScript SDK. It has two entry points:

- `supertag-ai/control-plane-client`: `createControlPlaneClient` connects an operator application
  to a SuperTag Control Plane over gRPC. It negotiates the SuperTag protocol version before its
  first call and names it on every call.
- `supertag-ai/harness`: `openHarness` reads the execution bootstrap a Worker Host writes to a
  harness adapter's standard input and connects to the Worker Host's private harness service for
  that one Task, including Worker-managed effect receipts.

```ts
import { createControlPlaneClient } from "supertag-ai/control-plane-client";

const client = createControlPlaneClient({
  url: "https://control-plane.example.com",
  token: process.env.SUPERTAG_OPERATOR_TOKEN!,
});
try {
  const { tags } = await client.operator.listTags({});
  console.log(tags.map((tag) => tag.tagId));
} finally {
  client.close();
}
```

Use Node.js 22.13.0 or newer. SuperTag is in alpha; the
[API stability policy](https://github.com/atemaguer/supertag/blob/main/docs/reference/api-stability.md)
describes compatibility.

[Documentation](https://github.com/atemaguer/supertag/blob/main/docs/README.md) ·
[Repository](https://github.com/atemaguer/supertag) ·
[Changelog](https://github.com/atemaguer/supertag/blob/main/CHANGELOG.md)
