import { defaultTaskResult } from "supertag-ai";

/**
 * A deterministic Harness that turns the requester message into one result.
 * Replace its planning and execution logic with an agent SDK, CLI, or service.
 */
export class ExampleHarness {
  id = "example-harness";

  async describe() {
    return {
      id: this.id,
      version: "1",
      inputKinds: [],
      streaming: false,
      cancellation: true,
      sessionPersistence: "none",
      sessions: { resume: false, export: false, scope: "none" },
      runtimePlacements: ["local"],
    };
  }

  async plan(context) {
    const requesterMessage = context.attempt.input.messages.findLast(
      (message) => message.role === "requester",
    );
    if (requesterMessage === undefined) throw new Error("Task has no requester message");

    return {
      runtime: {
        files: [],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      },
      execution: {
        files: [{ path: "request.txt", content: requesterMessage.text }],
        mounts: [],
        environmentVariables: {},
        secretBindings: [],
        network: { mode: "none" },
      },
    };
  }

  async start(_plan, { execution }) {
    return {
      async *run(signal) {
        if (signal?.aborted === true) return;
        const request = await execution.read("request.txt");
        const text = `Example Harness received: ${request}`;
        yield { type: "output.message", text };
        yield { type: "result", result: defaultTaskResult(text) };
      },
      async close() {},
    };
  }
}
