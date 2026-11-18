---
name: build-a-harness-adapter
description: Bring another agent system to SuperTag by writing a harness adapter that a Worker Host's Worklet starts for each Task Attempt. Read only when the built-in harnesses do not fit.
---

# Build a harness adapter

A harness adapter is an executable that a Worker Host's Worklet starts for each Task Attempt. It
reads a bootstrap from standard input, connects to the Worklet's loopback Harness service, receives the
Task, drives the agent, and completes the Task Attempt with a result and a Session checkpoint.
The full guide is [Write a harness adapter](../../docs/guides/harness-adapters.md).

Do not build one when Codex, Claude Code, Cursor, OpenCode, or OpenAI Agents fits; configure a
[Worker Host](../run-a-worker/SKILL.md) instead.

## Contract

1. Read all of standard input: one `supertag.runtime.v2.AdapterBootstrap`, at most 4096 bytes,
   with a loopback `endpoint` and a `token`. Refuse a non-loopback endpoint.
2. Call `Harness.Attach` with `authorization: Bearer TOKEN`. The `HarnessRun` holds the Task and
   its prompt, the Session checkpoint, a recap of earlier turns (`history`), resolved Skills, and
   what the Task may do. Resume the checkpoint, or start fresh with the recap in the first
   message as untrusted history; never both.
3. Work in the current directory, the Task's checkout. Report with `Harness.Publish`
   (increasing `sequence`, and a `kind`: `TASK_EVENT_KIND_MESSAGE` for each whole message the agent
   writes, `TASK_EVENT_KIND_ACTIVITY` for one line from a tool call's input, or
   `TASK_EVENT_KIND_PROGRESS` for `progress.updated` plan JSON), usage with
   `Harness.ReportUsage`, and enforced limits with `Harness.ConfirmExecutionLimits`. Optionally
   stream reply text as it is written with `Harness.PublishText` (`after_sequence` is the last
   published event's sequence); the whole message, published afterwards, replaces it.
4. End with `Harness.Complete`: `result`, `succeeded`, and a `checkpoint` if the agent can resume.
   A checkpoint over 8 MiB is not kept; the next turn starts from the recap.

Never print the token or pass it to the agent. The messages are in
[`proto/supertag/runtime/v2/runtime.proto`](../../proto/supertag/runtime/v2/runtime.proto).

## Start from an existing adapter

- Python: [`openai_agents_adapter.py`](../../sdks/python/src/supertag/openai_agents_adapter.py),
  and `supertag.harness_adapter.open_harness` for the connection.
- TypeScript: the Claude Code, Cursor, and OpenCode bridges under
  `harnesses/*/src/rust-adapter/`.
- Other languages: the generated bindings in [`sdks/`](../../sdks/README.md).

## Run and verify

On a Worker Host enrolled with `supertag host enroll` (see [run-a-worker](../run-a-worker/SKILL.md)):

```sh
supertag worker-host --control-plane https://supertag.example.com \
  --state-directory ~/.supertag-host --adapter /usr/local/bin/my-adapter
supertag task submit --tag lead --session adapter-check "Say hello."
supertag task events TASK_ID
```

In `supertag.yaml`, a host service uses `adapter` and `adapter-args` in place of `harnesses`.
The Task's events show the adapter's progress, and `describe task` its result.
