import { isDeepStrictEqual } from "node:util";
import type { Store } from "@supertag/core";
import { TagMessagingError } from "@supertag/core";
import type { SessionStateRef, StoredHarnessSessionState } from "@supertag/worker-sdk";
import type { ObjectiveController } from "./objective-controller.js";
import { SessionContinuity } from "./session-continuity.js";

/** Execution-only persistence. Native state never enters artifact discovery or model tools. */
export class SessionPersistence {
  constructor(
    readonly store: Store,
    readonly authority: Pick<ObjectiveController, "authenticateExecution"> &
      Partial<Pick<ObjectiveController, "authenticateSessionExecution">>,
  ) {}

  async execution(token: string | undefined) {
    const caller = await (
      this.authority.authenticateSessionExecution ?? this.authority.authenticateExecution
    ).call(this.authority, token);
    const task = await this.store.findTaskById(caller.taskId);
    if (!task) throw new TagMessagingError(401, "Session execution unavailable");
    const attempts = await this.store.listTaskAttempts(task.id);
    const attempt = attempts.find(
      (item) => item.status === "running" && item.id === caller.attemptId,
    );
    if (!attempt) throw new TagMessagingError(401, "Session execution unavailable");
    return { task, attempt };
  }

  async command(operation: string, input: unknown, token: string | undefined): Promise<unknown> {
    const { task, attempt } = await this.execution(token);
    if (
      !record(input) ||
      !record(input["ref"]) ||
      typeof input["ref"]["id"] !== "string" ||
      typeof input["ref"]["format"] !== "string" ||
      typeof input["ref"]["uri"] !== "string"
    )
      throw new TagMessagingError(400, "Invalid native Session state");
    const ref = input["ref"] as unknown as SessionStateRef;
    if (operation === "save") {
      if (
        typeof input["harnessId"] !== "string" ||
        !record(input["data"]) ||
        Object.keys(input).some(
          (key) => !["ref", "harnessId", "data", "writeVersion"].includes(key),
        )
      )
        throw new TagMessagingError(400, "Invalid native Session state");
      if (!Number.isSafeInteger(input["writeVersion"]) || (input["writeVersion"] as number) < 1)
        throw new TagMessagingError(400, "Session writes require an ordered version");
      await this.store.putSessionState({
        writeVersion: input["writeVersion"] as number,
        taskId: task.id,
        attemptId: attempt.id,
        harnessId: input["harnessId"],
        ref: input["ref"] as Record<string, unknown> & { id: string },
        data: input["data"],
      });
      return null;
    }
    if (operation === "load") {
      const state = await this.store.findSessionState(ref.id);
      if (!state || state.sessionId !== task.sessionId || !isDeepStrictEqual(state.ref, ref))
        return null;
      if (state.attemptId !== attempt.id) {
        const admitted = await new SessionContinuity(this.store).readTask(task, attempt.id);
        if (admitted?.id !== ref.id) return null;
      }
      await this.execution(token);
      return { ref: state.ref, harnessId: state.harnessId, data: state.data } satisfies Omit<
        StoredHarnessSessionState,
        "ref"
      > & { ref: unknown };
    }
    throw new TagMessagingError(404, "Session operation not found");
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
