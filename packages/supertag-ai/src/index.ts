/**
 * SuperTag's small, Beta SDK kernel.
 *
 * Extension-specific contracts live behind focused entry points such as
 * `supertag-ai/worker`, `supertag-ai/surfaces`, and `supertag-ai/control-plane`.
 * Keeping this entry point deliberate lets those extension surfaces evolve
 * without turning every internal helper into a compatibility promise.
 */

export type {
  CapabilityIdentifier,
  TaskAttemptEvent,
  TaskAttemptSessionContext,
  TaskAttemptSpec,
  TaskInput,
  TaskMessage,
  TaskOrigin,
  TaskProgress,
  TaskProgressItemStatus,
  TaskResult,
  Worker,
  WorkerDescriptor,
  WorkerHostDescriptor,
  WorkerOptions,
  WorkerProfile,
  WorkerProfileRef,
  Worklet,
  WorkletDescriptor,
} from "../../runtime/sdk/src/index.js";
export {
  collectTaskAttemptEvents,
  createWorker,
  defaultTaskResult,
  executeToTerminalOutput,
  LOCAL_PROCESS_CAPABILITY,
  LocalExecutionEnvironmentProvider,
  LocalHarnessRuntimeProvider,
  LocalWorklet,
  normalizeTaskProgress,
  TASK_ATTEMPT_CANCELLATION_CAPABILITY,
  TASK_ATTEMPT_EVENT_STREAM_CAPABILITY,
  terminalOutputText,
  terminalTaskResult,
} from "../../runtime/sdk/src/index.js";
export type {
  WorkletClientMessage,
  WorkletConnectionOptions,
  WorkletProtocolVersion,
  WorkletServerMessage,
} from "../../runtime/transport/src/index.js";
export {
  connectWorklet,
  SUPPORTED_WORKLET_PROTOCOL_VERSIONS,
  WORKLET_PROTOCOL_VERSION,
  WorkletConnection,
} from "../../runtime/transport/src/index.js";
