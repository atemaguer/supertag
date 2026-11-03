import type { SessionStateRef, ToolInput } from "@supertag/worker-sdk";
import { type InMemorySessionStateStore, ToolProviderRegistry } from "@supertag/worker-sdk";
import { repositoryAttempt } from "../../../../tests/support/repository-execution.js";
import { type CursorRunner, createCursorWorker } from "./src/index.js";

export function cursorLiveTool(script: string): ToolInput {
  return {
    id: "supertag-probe",
    kind: "tool",
    required: true,
    capability: {
      id: "supertag",
      provider: "supertag",
      operations: [{ name: "probe", effect: "read", actions: ["supertag/probe"] }],
      authorization: {
        provider: "supertag",
        resources: [{ surfaceAccountId: "supertag-live", scope: "supertag/probe" }],
      },
    },
    binding: {
      kind: "mcp-stdio",
      name: "supertag",
      command: process.execPath,
      args: [script],
      runtimeEnvironment: {},
    },
  };
}

// Operator-selected live model, confirmed in Cursor.models.list for the dogfood account.
// https://cursor.com/docs/sdk/typescript.md
export const CURSOR_LIVE_MODEL = "claude-sonnet-5-5";

export function cursorLiveAttempt(input: {
  id: string;
  prompt: string;
  actions?: readonly string[];
  session?: { id: string; sessionState?: SessionStateRef };
  tool?: ToolInput;
}) {
  const attempt = repositoryAttempt(input.id);
  return {
    ...attempt,
    workerProfile: { id: "cursor-live", revision: "1" },
    execution: { model: CURSOR_LIVE_MODEL },
    authorization: {
      ...attempt.authorization,
      runtimeActions: [...(input.actions ?? ["files:write", "commands:execute"])],
      ...(input.tool ? { mcp: [{ action: "supertag/probe" }] } : {}),
    },
    input: {
      ...attempt.input,
      messages: [{ id: "prompt", role: "requester" as const, text: input.prompt }],
    },
    ...(input.session ? { session: input.session } : {}),
  };
}

export function cursorLiveWorker(input: {
  directory: string;
  runner: CursorRunner;
  store?: InMemorySessionStateStore;
  tool?: ToolInput;
}) {
  return createCursorWorker({
    workspace: input.directory,
    profileId: "cursor-live",
    model: CURSOR_LIVE_MODEL,
    timeoutMs: 90_000,
    // Cursor's sandbox is not an enforced command boundary, so shell access needs the opt-in.
    allowUnsandboxedCommands: true,
    ...(input.store ? { sessionStateStore: input.store } : {}),
    ...(input.tool
      ? {
          toolProviders: new ToolProviderRegistry([
            {
              provider: "supertag",
              resolve: async () => ({ provider: "supertag", inputs: [input.tool as ToolInput] }),
            },
          ]),
        }
      : {}),
    runner: input.runner,
  });
}
