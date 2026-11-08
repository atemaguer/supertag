import type { JsonRecord, WorkerProfileRef } from "./index.js";

/** Native conversation data owned by a Session and produced by one Task Attempt. */
export interface SessionStateRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly harnessId: string;
  readonly nativeId?: string;
  readonly ref: JsonRecord;
  readonly data: JsonRecord;
  readonly status: "stored" | "resumable";
  readonly writeVersion: number;
  readonly compatibility?: string;
  readonly workerProfile?: WorkerProfileRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Listing metadata excludes potentially large native transcript payloads. */
export type SessionStateSummary = Omit<SessionStateRecord, "data">;

export interface SessionStatePersistence {
  putSessionState(input: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly harnessId: string;
    readonly ref: JsonRecord & { readonly id: string };
    readonly data: JsonRecord;
    /** Monotonic producer sequence; omit only for serialized, trusted in-process writes. */
    readonly writeVersion?: number;
  }): Promise<SessionStateRecord>;
  findSessionState(id: string): Promise<SessionStateRecord | undefined>;
  listSessionStates(input: {
    readonly sessionId: string;
    readonly taskId?: string;
    readonly nativeId?: string;
    readonly limit?: number;
  }): Promise<readonly SessionStateSummary[]>;
  /** Seals native data only after the Control Plane has verified successful execution. */
  promoteSessionState(input: {
    readonly id: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly compatibility: string;
    readonly workerProfile: WorkerProfileRef;
  }): Promise<void>;
}

/** Whether a Session's native transcript may resume after input: not when the input was withdrawn. */
export function canResumeSessionAfterInput(
  taskId: string,
  attemptId: string,
  events: readonly { type: string; taskId: string; attemptId?: string | null }[],
): boolean {
  return !events.some(
    (event) =>
      event.type === "input.withdrawn" && event.taskId === taskId && event.attemptId === attemptId,
  );
}
