import { mkdir } from "node:fs/promises";
import { createClaudeCodeWorker } from "../../packages/runtime/harnesses/claude-code/src/index.js";
import {
  collectTaskAttemptEvents,
  type ExecutionEnvironmentProvider,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  type SessionStateRef,
  type SessionStateStore,
  type TaskAttemptSpec,
} from "../../packages/runtime/sdk/src/index.js";
import { FileArtifactStore } from "./file-artifact-store.js";
import { repositoryAttempt } from "./repository-execution.js";

/** Real subscription-backed query; no injected query runner or model response. */
export async function runClaudeSessionPhase(options: {
  directory: string;
  source: string;
  runtime: string;
  phase: string;
  prompt: string;
  sessionStateStore: SessionStateStore;
  priorState?: SessionStateRef;
  executionEnvironment?: ExecutionEnvironmentProvider;
  spec?: TaskAttemptSpec;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  await mkdir(options.runtime, { recursive: true });
  const artifacts = new FileArtifactStore(`${options.directory}/artifacts`);
  const base = options.spec ?? repositoryAttempt(`claude-live-${options.phase}`);
  const worker = createClaudeCodeWorker({
    workspace: options.source,
    profileId: base.workerProfile.id,
    model: "haiku",
    maxTurns: 8,
    timeoutMs: options.timeoutMs ?? 120_000,
    artifactStore: artifacts,
    sessionStateStore: options.sessionStateStore,
    executionEnvironment:
      options.executionEnvironment ??
      new LocalExecutionEnvironmentProvider({ temporaryDirectory: options.runtime }),
    ...(options.executionEnvironment
      ? { harnessRuntime: new LocalHarnessRuntimeProvider({ temporaryDirectory: options.runtime }) }
      : {}),
    outputs: [{ path: "effects.log", name: "effects.log" }],
  });
  const events = await collectTaskAttemptEvents(
    worker.execute(
      {
        ...base,
        authorization: {
          ...base.authorization,
          runtimeActions: ["files:write", "commands:execute", "web:fetch"],
        },
        session: {
          ...base.session,
          id: base.session?.id ?? "claude-live-session",
          history: [],
          ...(options.priorState ? { sessionState: options.priorState } : {}),
        },
        input: {
          ...base.input,
          messages: [{ id: options.phase, role: "requester", text: options.prompt }],
        },
      },
      options.signal,
    ),
  );
  return { events, artifacts };
}
