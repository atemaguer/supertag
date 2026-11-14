---
name: build-a-harness-adapter
description: Bring another agent system to SuperTag by writing a harness adapter that a Worker Host runs for each Task Attempt. Read only when the built-in harnesses do not fit.
---

# Build a harness adapter

A harness adapter is an executable that a Worker Host starts for each Task Attempt. It reads a
bootstrap from standard input, connects to the host's loopback Harness service, receives the
Task, drives the agent, and completes the Task Attempt with a result and a Session checkpoint.
The full guide is [Write a harness adapter](../../docs/guides/harness-adapters.md).

Do not build one when Codex, Claude Code, Cursor, OpenCode, or OpenAI Agents fits; configure a
[Worker Host](../run-a-worker/SKILL.md) instead.

## Contract

1. Read all of standard input: one `supertag.runtime.v2.AdapterBootstrap`, at most 4096 bytes,
   with a loopback `endpoint` and a `token`. Refuse a non-loopback endpoint.
2. Call `Harness.Attach` with `authorization: Bearer TOKEN`. The `HarnessRun` holds the Task and
   its prompt, the Session checkpoint, earlier turns, resolved Skills, and what the Task may do.
3. Work in the current directory, the Task's checkout. Send progress with `Harness.Publish`
   (increasing `sequence`), usage with `Harness.ReportUsage`, and enforced limits with
   `Harness.ConfirmExecutionLimits`.
4. End with `Harness.Complete`: `result`, `succeeded`, and a `checkpoint` if the agent can resume.

Never print the token or pass it to the agent. The messages are in
[`rust/proto/supertag/runtime/v2/runtime.proto`](../../rust/proto/supertag/runtime/v2/runtime.proto).

## Start from an existing adapter

- Python: [`openai_agents_adapter.py`](../../sdks/python/src/supertag/openai_agents_adapter.py),
  and `supertag.harness_adapter.open_harness` for the connection.
- TypeScript: the Claude Code, Cursor, and OpenCode bridges under
  `packages/runtime/harnesses/*/src/rust-adapter/`.
- Other languages: the generated bindings in [`rust/bindings`](../../rust/bindings/README.md).

## Run and verify

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --adapter /usr/local/bin/my-adapter
supertag task submit --tag lead --session adapter-check "Say hello."
supertag task events TASK_ID
```

In `supertag.yaml`, a host service uses `adapter` and `adapter-args` in place of `harnesses`.
The Task's events show the adapter's progress, and `describe task` its result.
