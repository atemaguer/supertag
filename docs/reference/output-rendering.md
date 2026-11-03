# Output rendering

If the execution terms on this page are new, start with
[Worker Hosts, Worklets, Workers, and harnesses](../concepts/workers.md).

This page uses these SuperTag terms, each defined in the glossary: [Task](glossary.md#task),
[Session](glossary.md#session), and [Gateway](glossary.md#gateway).

Harnesses and custom Workers return surface-neutral Markdown. SuperTag preserves that canonical output through execution, stored Task results, bounded Session history, and the durable outbound queue. A collaboration surface renders it only when it delivers a presentation.

```text
harness / Worker Markdown
  -> Task Attempt event
  -> Gateway + durable outbox
  -> SurfacePresentation { kind, markdown }
  -> universal Markdown + GFM parser
  -> surface-neutral Markdown AST
  -> surface-specific surface render.ts
  -> provider-native payload
```

This boundary keeps collaboration formatting out of harnesses and keeps provider payloads out of the Gateway's durable domain model. Rendering is deterministic, so an outbound retry produces the same provider payload from the same canonical presentation.

The Markdown AST is an internal rendering representation, not another public SuperTag abstraction. Workers return Markdown and collaboration surface authors receive a parsed document they can traverse, adapt, and serialize. Parsing once provides consistent treatment of links, code, lists, tables, and nested formatting without building a different regular-expression parser for every surface.

## Current renderers

| Collaboration surface | Native output |
| --- | --- |
| Slack | Markdown converted to escaped `mrkdwn`; links use Slack link syntax and raw `<mention>` syntax is suppressed |
| GitHub | normalized native Markdown issue/PR comment |
| Linear | normalized native Markdown issue comment |
| Microsoft Teams | message activity with `textFormat: markdown`; unsupported headings become bold text |
| Lark / Feishu | interactive card containing bounded `lark_md` elements |

The semantic presentation kind—acknowledgement, status, final result, or error—is available to each renderer. Each reply collaboration surface declares whether it can replace a message that it created. Slack, GitHub, Linear, Microsoft Teams, and Lark/Feishu currently support replacement. The Gateway uses that capability rather than checking provider names.

On a replacement-capable surface, the acknowledgement returns an opaque provider message ID. Structured harness progress becomes a short summary and checklist by updating that same message. Rapid snapshots share one revisioned delivery key, so only the newest pending state matters. The final result, error, or cancellation replaces progress permanently. A create-only collaboration surface receives an acknowledgement and final reply but no intermediate progress messages. Adding replacement to a collaboration surface therefore requires only its capability declaration and create/update delivery implementation; Worker output and Gateway orchestration do not change.

## Invariants

- Harnesses never emit Slack blocks, Teams activities, Lark cards, or provider API payloads.
- The Gateway does not rewrite Markdown for a particular provider.
- Renderers must not allow model-authored text to synthesize native mentions or interactive actions.
- collaboration surface credentials are applied after rendering and never appear in the canonical presentation.
- Platform limits are enforced at rendering time without splitting Unicode code points.
- Provider delivery failures retry the canonical presentation; rendered payloads are not persisted as authority-bearing state.
- Provider message identifiers are delivery receipts, not Task identity. They may be stored only so a collaboration surface can safely update a message it previously created.
- A collaboration surface must not declare replacement unless its create operation returns a stable message ID and its update operation is scoped to messages created by that collaboration surface.
- Progress is bounded plain text. It never renders private reasoning, raw tool input, execution logs, Task IDs, Worker details, or model-authored interactive actions.

Add a new surface renderer beside its collaboration surface's `reply.ts`, export it from that collaboration surface package, and make `reply.ts` the only place that combines the rendered payload with provider credentials and callback routing.
