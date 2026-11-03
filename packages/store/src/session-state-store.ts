// biome-ignore-all lint/suspicious/noExplicitAny: Shared dialect transactions use different Drizzle query types.
import { isDeepStrictEqual } from "node:util";
import type {
  DatabaseProvider,
  SessionStatePersistence,
  SessionStateRecord,
  SessionStateSummary,
} from "@supertag/core";
import { TagMessagingError } from "@supertag/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { runDialectTransaction } from "./dialect-transaction.js";

type Flow<T> = Generator<any, T, any>;
const maximumPayloadBytes = 16 * 1024 * 1024;

/** Session data stays available for inspection even when execution cannot safely resume. */
export class DrizzleSessionStateStore implements SessionStatePersistence {
  constructor(
    private readonly db: any,
    private readonly tables: any,
    private readonly provider: DatabaseProvider,
  ) {}

  private *owner(tx: any, taskId: string, attemptId: string, promotion = false): Flow<any> {
    const t = this.tables.tasks;
    // Use the same Task lock as retry admission. A superseded Attempt cannot publish new state.
    const [task] = yield tx
      .update(t)
      .set({ updatedAt: sql`${t.updatedAt}` })
      .where(eq(t.id, taskId))
      .returning();
    if (!task) throw new TagMessagingError(404, "Session state Task not found");
    const a = this.tables.taskAttempts;
    const [latest] = yield tx
      .select()
      .from(a)
      .where(eq(a.taskId, taskId))
      .orderBy(desc(a.attemptNumber))
      .limit(1);
    // Terminal updates can lock the Attempt directly; serialize with those too.
    const [attempt] = yield tx
      .update(a)
      .set({ updatedAt: sql`${a.updatedAt}` })
      .where(and(eq(a.id, attemptId), eq(a.taskId, taskId)))
      .returning();
    const allowed = promotion ? ["running", "completed"] : ["running"];
    if (
      !attempt ||
      latest?.id !== attemptId ||
      attempt.id !== attemptId ||
      !allowed.includes(attempt.status) ||
      !allowed.includes(task.status)
    )
      throw new TagMessagingError(409, "Session state requires the current active Task Attempt");
    return task;
  }

  async putSessionState(
    input: Parameters<SessionStatePersistence["putSessionState"]>[0],
  ): Promise<SessionStateRecord> {
    for (const value of [input.taskId, input.attemptId, input.harnessId, input.ref?.id])
      if (typeof value !== "string" || !value.trim() || value.length > 1024)
        throw new TagMessagingError(
          400,
          "Session state identity must be a bounded nonempty string",
        );
    for (const value of [input.ref, input.data])
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TagMessagingError(400, "Session state ref and data must be JSON objects");
    let serialized: string;
    try {
      serialized = JSON.stringify({ ref: input.ref, data: input.data });
    } catch {
      throw new TagMessagingError(400, "Session state must contain serializable JSON");
    }
    if (Buffer.byteLength(serialized, "utf8") > maximumPayloadBytes)
      throw new TagMessagingError(413, "Session state exceeds the 16 MiB limit");
    if (
      input.writeVersion !== undefined &&
      (!Number.isSafeInteger(input.writeVersion) || input.writeVersion < 0)
    )
      throw new TagMessagingError(
        400,
        "Session state writeVersion must be a nonnegative safe integer",
      );
    const self = this;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      const task = yield* self.owner(tx, input.taskId, input.attemptId);
      const s = self.tables.sessionStates;
      const [prior] = yield tx.select().from(s).where(eq(s.id, input.ref.id));
      if (prior) {
        if (
          prior.taskId !== input.taskId ||
          prior.attemptId !== input.attemptId ||
          prior.harnessId !== input.harnessId ||
          !isDeepStrictEqual(prior.ref, input.ref)
        )
          throw new TagMessagingError(
            409,
            "Session state ID belongs to another producer or reference",
          );
        const identical = isDeepStrictEqual(prior.data, input.data);
        if (input.writeVersion !== undefined && input.writeVersion <= prior.writeVersion) {
          if (input.writeVersion === prior.writeVersion && identical) return record(prior);
          throw new TagMessagingError(
            409,
            "Session state writeVersion is stale or conflicts with stored data",
          );
        }
        if (input.writeVersion === undefined && identical) return record(prior);
        if (prior.status === "resumable")
          throw new TagMessagingError(409, "Resumable Session state is immutable");
        const [saved] = yield tx
          .update(s)
          .set({
            data: input.data,
            nativeId: nativeId(input.harnessId, input.data),
            writeVersion: input.writeVersion ?? prior.writeVersion + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(s.id, input.ref.id))
          .returning();
        return record(saved);
      }
      const at = new Date().toISOString();
      const [saved] = yield tx
        .insert(s)
        .values({
          id: input.ref.id,
          sessionId: task.sessionId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          harnessId: input.harnessId,
          ref: input.ref,
          data: input.data,
          nativeId: nativeId(input.harnessId, input.data),
          writeVersion: input.writeVersion ?? 0,
          status: "stored",
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning();
      if (!saved) throw new TagMessagingError(409, "Session state ID belongs to another producer");
      return record(saved);
    });
  }

  async findSessionState(id: string): Promise<SessionStateRecord | undefined> {
    const s = this.tables.sessionStates;
    const [row] = await this.db.select().from(s).where(eq(s.id, id));
    return row ? record(row) : undefined;
  }

  async listSessionStates(
    input: Parameters<SessionStatePersistence["listSessionStates"]>[0],
  ): Promise<readonly SessionStateSummary[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TagMessagingError(400, "Session state limit must be between 1 and 1000");
    const s = this.tables.sessionStates;
    const rows = await this.db
      .select({
        id: s.id,
        sessionId: s.sessionId,
        taskId: s.taskId,
        attemptId: s.attemptId,
        harnessId: s.harnessId,
        nativeId: s.nativeId,
        ref: s.ref,
        status: s.status,
        writeVersion: s.writeVersion,
        compatibility: s.compatibility,
        workerProfile: s.workerProfile,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })
      .from(s)
      .where(
        and(
          eq(s.sessionId, input.sessionId),
          input.taskId === undefined ? undefined : eq(s.taskId, input.taskId),
          input.nativeId === undefined ? undefined : eq(s.nativeId, input.nativeId),
        ),
      )
      .orderBy(desc(s.createdAt), desc(s.id))
      .limit(limit);
    return rows.map(record);
  }

  async promoteSessionState(
    input: Parameters<SessionStatePersistence["promoteSessionState"]>[0],
  ): Promise<void> {
    if (
      !input.compatibility?.trim() ||
      !input.workerProfile?.id?.trim() ||
      !input.workerProfile.revision?.trim()
    )
      throw new TagMessagingError(
        400,
        "Session state compatibility and Worker profile are required",
      );
    const self = this;
    return runDialectTransaction(this.db, this.provider, function* (tx) {
      yield* self.owner(tx, input.taskId, input.attemptId, true);
      const s = self.tables.sessionStates;
      const [prior] = yield tx.select().from(s).where(eq(s.id, input.id));
      if (!prior) throw new TagMessagingError(404, "Session state not found");
      if (prior.taskId !== input.taskId || prior.attemptId !== input.attemptId)
        throw new TagMessagingError(409, "Session state belongs to another Task Attempt");
      if (prior.status === "resumable") {
        if (
          prior.compatibility !== input.compatibility ||
          !isDeepStrictEqual(prior.workerProfile, input.workerProfile)
        )
          throw new TagMessagingError(409, "Resumable Session state is immutable");
        return;
      }
      yield tx
        .update(s)
        .set({
          status: "resumable",
          compatibility: input.compatibility,
          workerProfile: input.workerProfile,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(s.id, input.id))
        .returning();
    });
  }
}

function record(row: any): SessionStateRecord {
  const { compatibility, workerProfile, nativeId, ...rest } = row;
  return {
    ...rest,
    ...(compatibility === null ? {} : { compatibility }),
    ...(workerProfile === null ? {} : { workerProfile }),
    ...(nativeId === null ? {} : { nativeId }),
  };
}

function nativeId(harnessId: string, data: Record<string, unknown>): string | null {
  const candidate =
    data["threadId"] ??
    data["claudeSessionId"] ??
    data["nativeSessionId"] ??
    (harnessId === "opencode" ? data["sessionId"] : undefined) ??
    (harnessId === "cursor" && data["portable"] !== null && typeof data["portable"] === "object"
      ? (data["portable"] as Record<string, unknown>)["agentId"]
      : undefined);
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 1024
    ? candidate
    : null;
}
