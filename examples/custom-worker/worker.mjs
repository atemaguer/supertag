import { fileURLToPath } from "node:url";
import { defaultTaskResult, TASK_ATTEMPT_EVENT_STREAM_CAPABILITY } from "supertag-ai";
import { emptyTagContextPlan } from "supertag-ai/core";
import { assertConformance, runWorkerConformance } from "supertag-ai/testing";

export const profile = { id: "example", revision: "1" };

export class ExampleWorker {
  async describe() {
    return {
      id: "example-worker",
      type: "example",
      capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY],
      profiles: [profile],
      profileCapabilities: [
        { profile, capabilities: [TASK_ATTEMPT_EVENT_STREAM_CAPABILITY], contextTypes: [] },
      ],
      contextTypes: [],
    };
  }

  async *execute(spec) {
    const identity = { taskId: spec.taskId, attemptId: spec.attemptId };
    const at = () => new Date().toISOString();
    yield { ...identity, at: at(), type: "execution.started", workerId: "example-worker" };
    if (spec.workerProfile.id !== profile.id || spec.workerProfile.revision !== profile.revision) {
      yield {
        ...identity,
        at: at(),
        type: "execution.failed",
        error: { name: "UnsupportedProfile", message: "Worker Profile is not supported" },
      };
      return;
    }
    const text = `Example Worker received: ${spec.input.messages.at(-1)?.text ?? ""}`;
    yield { ...identity, at: at(), type: "output.message", message: { role: "teammate", text } };
    yield { ...identity, at: at(), type: "result", result: defaultTaskResult(text) };
    yield { ...identity, at: at(), type: "execution.completed" };
  }
}

export function exampleAttempt() {
  const capturedAt = new Date().toISOString();
  return {
    version: 1,
    taskId: "example-task",
    attemptId: "example-attempt",
    tag: { id: "example-tag", name: "Example" },
    input: {
      origin: {
        surface: "example",
        accountId: "example-account",
        scope: "channel:example",
        sessionKey: "example-session",
        occurredAt: capturedAt,
      },
      messages: [{ id: "message-1", role: "requester", text: "Hello" }],
    },
    authorization: {
      version: 5,
      capturedAt,
      tag: { id: "example-tag", name: "Example" },
      origin: {
        tagRouteId: "route-1",
        surfaceAccountId: "example-account",
        provider: "example",
        scope: "channel:example",
      },
      requester: { id: "user-1", kind: "user" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: emptyTagContextPlan(capturedAt),
    workspacePlan: { version: 1, status: "none" },
    execution: {},
    workerProfile: profile,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertConformance(
    await runWorkerConformance({ worker: new ExampleWorker(), attempt: exampleAttempt() }),
  );
  process.stdout.write("External Worker conformance passed\n");
}
