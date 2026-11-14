# Write a harness adapter

Bring your own agent system to SuperTag by writing a **harness adapter**: a program that a
**Worker Host**, the machine that runs work, starts for each **Task Attempt**, one execution of a
Task, and that drives your agent through the harness protocol. A Tag, a persistent AI actor with
its own responsibilities and permissions, then runs on your agent exactly as it runs on Codex or
Claude Code. See the [glossary](../reference/glossary.md) for other terms.

The built-in harnesses are adapters too. Read one before you start:

| Adapter | Language | Source |
| --- | --- | --- |
| OpenAI Agents | Python | [`sdks/python/src/supertag/openai_agents_adapter.py`](../../sdks/python/src/supertag/openai_agents_adapter.py) |
| Claude Code | TypeScript | [`packages/runtime/harnesses/claude-code/src/rust-adapter/`](../../packages/runtime/harnesses/claude-code/src/rust-adapter/entry.ts) |
| Cursor | TypeScript | [`packages/runtime/harnesses/cursor/src/rust-adapter/`](../../packages/runtime/harnesses/cursor/src/rust-adapter/entry.ts) |
| OpenCode | TypeScript | [`packages/runtime/harnesses/opencode/src/rust-adapter/`](../../packages/runtime/harnesses/opencode/src/rust-adapter/entry.ts) |

## How an adapter runs

```text
Worker Host ── claims Task ── starts adapter ── writes bootstrap to its stdin
     ▲                                              │
     └── Harness service on loopback ◄──── Attach, Publish, Complete
```

1. The Worker Host claims a Task, prepares its Workspace checkout, and starts your executable
   with the arguments you configured. The working directory is the Task's checkout.
2. It writes one `AdapterBootstrap` message to the adapter's standard input and closes it: a
   loopback `endpoint` and a `token`, at most 4096 bytes.
3. The adapter connects to that endpoint with gRPC and sends the token as a bearer credential
   on every call to the `supertag.runtime.v2.Harness` service.
4. `Attach` returns a `HarnessRun`: the Task and its prompt, the Session checkpoint to resume
   from, earlier turns of the Session, the Skills its Context Sets resolved, and what the Task may
   do.
5. While the agent works, the adapter sends progress text with `Publish`, token usage with
   `ReportUsage`, and the limits it enforces with `ConfirmExecutionLimits`.
6. `Complete` ends the Task Attempt with the result text, whether it succeeded, and a new Session
   checkpoint so the next turn can resume.

The Worker Host supervises the adapter's process group. It stops the adapter when the Task is
cancelled or reaches its time limit, and it cleans up processes the adapter leaves behind.

Further services on the same endpoint let an adapter ask the operator a question
(`HarnessQuestions`), post to a Team's Workstream (`HarnessWorkstreams`), send Mailbox messages
(`HarnessMailbox`), start or continue work Sessions (`HarnessWorkSessions`), capture artifacts
(`HarnessArtifacts`), use MCP servers the host offers (`HarnessMcp`), and record external effects
so a retry does not repeat them (`HarnessEffects`). The run's capabilities say which of these the
Task may use. The messages are defined in
[`runtime.proto`](../../rust/proto/supertag/runtime/v2/runtime.proto) and its siblings.

## Write one in Python

The `supertag` Python package connects an adapter for you:

```python
import asyncio
import sys

from supertag.harness_adapter import open_harness, runtime


async def main() -> None:
    async with open_harness(sys.stdin.buffer) as harness:
        run = await harness.client.Attach(runtime.HarnessAttachRequest())
        answer = await my_agent(run.task.prompt)
        await harness.client.Publish(runtime.HarnessPublishRequest(sequence=1, text="Done."))
        await harness.client.Complete(runtime.HarnessCompleteRequest(result=answer, succeeded=True))


asyncio.run(main())
```

Install its runtime extra, `supertag[runtime]`, from the [Python package](../../sdks/python/README.md).

## Write one in another language

Generate a gRPC client from the protos, or use the generated Go, TypeScript, or Python bindings
in [`rust/bindings`](../../rust/bindings/README.md). Read the whole bootstrap from standard input,
refuse an endpoint that is not loopback, and send `authorization: Bearer TOKEN` on each call.

## Run it

Point a Worker Host at the executable:

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --adapter /usr/local/bin/my-adapter --adapter-arg=--verbose
```

Or, in a host service of `supertag.yaml`, use `adapter` and `adapter-args` in place of
`harnesses`:

```yaml
services:
  studio:
    type: host
    adapter: /usr/local/bin/my-adapter
    adapter-args: [--verbose]
    workspaces:
      app: ~/code/app
```

A host runs either built-in harnesses or one adapter. For an adapter written in Node.js or
Python, `--harness-runtime` names the interpreter and `--harness-entrypoint` the script.

## Check that it worked

Send a Task to a Tag the host may run, then read its events and result:

```sh
supertag task submit --tag lead --session adapter-check "Say hello." --state-directory ~/.supertag
supertag task events TASK_ID --state-directory ~/.supertag
supertag describe task TASK_ID --state-directory ~/.supertag
```

## Rules

- Never print the bootstrap token or pass it to the agent.
- Keep each `Publish` text short; send long output in pieces with increasing sequence numbers.
- Send a checkpoint with `Complete` if your agent can resume a conversation; the next Task in the
  Session receives it, possibly on another host.
- Report failures through `Complete` with `succeeded: false` and a result safe to show to people.

## Next

- [Worker Host reference](../reference/worker.md)
- [Run Worker Hosts](workers.md)
