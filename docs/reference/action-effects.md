# Reliable external actions

If the execution terms on this page are new, start with
[Worker Hosts and harnesses](../concepts/workers.md).

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt), and
[Control Plane](glossary.md#control-plane).

Harnesses can read or change external systems through any supported tool mechanism. The authorization model is independent of that mechanism: MCP, a native SDK, HTTP, and future adapters all receive the same Task-scoped capability.

External writes have two execution modes with different recovery guarantees.

In **adapter-managed mode**, a harness adapter supplies a stable idempotency key for the intended
effect and records a durable effect receipt before and after the provider call. It calls the
Worker Host's `HarnessEffects` service: `Begin` before the call, then `Complete` with the result or
`Fail`. The Worker Host forwards each call with the Task Attempt's authority, and the Control Plane
keeps the receipts, keyed by Tag and idempotency key, so a later Task of the same Tag sees them
too.

- A completed receipt replays the recorded result instead of calling the provider twice.
- Reusing a key for different arguments fails closed.
- A crash after provider execution but before receipt completion leaves an **in-doubt** effect. SuperTag does not blindly retry it; an integration must reconcile it against the provider first.
- Read operations do not require an effect receipt.

TypeScript adapters get this client as the `effects` of the connection `openHarness` from
`supertag-ai/harness` returns, and Python adapters as `HarnessConnection.effects`. See
[Write a harness adapter](../guides/harness-adapters.md).

In **harness-managed mode**, Codex or Claude Code calls an MCP server through the Worker Host's
policy proxy, which records a durable dispatch before it forwards a call that needs approval. If
the Task fails after a write starts, the Control Plane stops automatic retries because the provider may already
have changed. An operator must reconcile that action before retrying. This prevents blind
duplication, but it is not exactly-once execution.

Permission evaluation produces a structured decision that records the Tag, resource, action, matching sources, and denial reason. Credentials and raw secret values never appear in decisions, Task events, or receipts.

## Inspect an uncertain action

Keep the intended operation ID, exact arguments, and reviewed source artifact with the Task.
Ask the provider whether that operation committed. A matching receipt can establish completion;
a failed lookup cannot establish that nothing happened. If the provider cannot answer reliably,
leave the outcome uncertain for an operator rather than automatically sending the write again.

The [ongoing support example](../../examples/ongoing-support/README.md) includes a small provider
that commits its state and receipt together. Its manager inspects that receipt after a lost response
and on later Task Attempts. This is an application example of provider-specific recovery, not a new
SuperTag resource or a general guarantee for all MCP servers.
