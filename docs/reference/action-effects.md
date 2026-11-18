# Reliable external actions

If the execution terms on this page are new, start with
[Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md).

This page uses these SuperTag terms, each defined in the glossary: [Tag](glossary.md#tag),
[Task](glossary.md#task), [Task Attempt](glossary.md#task-attempt), and
[Control Plane](glossary.md#control-plane).

Harnesses can read or change external systems. A retried Task Attempt or a later Task could repeat
a write the provider already performed, so SuperTag offers two ways to make external writes
recoverable, with different guarantees.

In **adapter-managed mode**, a harness adapter supplies a stable idempotency key for the intended
effect and records a durable effect receipt before and after the provider call. It calls the
Worklet's `HarnessEffects` service: `Begin` before the call, then `Complete` with the result or
`Fail`. The Worklet forwards each call with the Task Attempt's authority, and the Control Plane
keeps the receipts, keyed by Tag and idempotency key, so a later Task of the same Tag sees them
too. `Begin` answers with the receipt's state:

- `ACQUIRED`: call the provider once, then `Complete` or `Fail`.
- `COMPLETED`: do not call the provider; replay the recorded result.
- `FAILED`: the earlier call failed without effect, and this `Begin` may acquire it again.
- `IN_FLIGHT`: another running Task Attempt began the effect and may still be calling the provider.
  Do not call the provider; `Begin` again later.
- `IN_DOUBT`: an earlier Task Attempt began the effect and stopped without settling it. SuperTag never
  acquires it again. The integration must reconcile it against the provider, then settle the
  receipt with `Complete` or `Fail`.

Reusing a key for different arguments fails closed. Read operations do not need a receipt. Never
put credentials in a recorded result: later callers receive it as written.

TypeScript adapters get this client as the `effects` of the connection `openHarness` from
`supertag-ai/harness` returns, and Python adapters as `HarnessConnection.effects`. See
[Write a harness adapter](../guides/harness-adapters.md).

In **harness-managed mode**, the harness calls an MCP server through the Worklet's policy
proxy. Before it forwards a call that needs approval, the proxy records a durable dispatch, and it
records the result when the call returns. A dispatch that never recorded a result is unconfirmed:
the provider may already have changed. The proxy refuses to send the same tool call with the same
arguments again in that Tag's Session, so an operator must reconcile the action first. Separately,
a Task whose Task Attempt stopped without reporting is `uncertain`, and SuperTag never retries it on its
own; an operator decides with `supertag task resolve-attempt`. This prevents blind duplication,
but it is not exactly-once execution.

## Inspect an uncertain action

Keep the intended operation ID, exact arguments, and reviewed source artifact with the Task.
Ask the provider whether that operation committed. A matching receipt can establish completion;
a failed lookup cannot establish that nothing happened. If the provider cannot answer reliably,
leave the outcome uncertain for an operator rather than automatically sending the write again.

