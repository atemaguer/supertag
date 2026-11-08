import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { TagContextPlan, TaskExecutionRequirements } from "@supertag/core";
import Database from "better-sqlite3";
import { decodeTaskAttemptEvent } from "./attempt-codec.js";
import { redactDiagnostics, redactEventDiagnostics } from "./event-redaction.js";
import {
  descriptorSupportsCoordination,
  descriptorSupportsExecution,
  descriptorSupportsRequiredContext,
  descriptorSupportsSurfaceCoordination,
  type ExecutionSelectionOptions,
  selectDescriptorExecution,
  type WorkletExecutionPlacement,
  WorkletPlacementReservations,
  workerSlots,
} from "./execution-selection.js";
import {
  type HarnessControlAcknowledgement,
  type HarnessControlCapabilities,
  type HarnessControlCommand,
  type HarnessControlOptions,
  validateHarnessControlCapabilities,
  validateHarnessControlCommand,
} from "./harness-control.js";
import {
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
  WorkletAdmissionRejectedError,
} from "./index.js";
import { ExecutionCleanupError } from "./process-supervision.js";
import { redactText, sensitiveEnvironmentValues, sensitiveFieldValues } from "./redaction.js";
import { probeWorklet } from "./worklet-probe.js";

export type AttemptStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export interface AttemptReceipt {
  /** Actual admission identity, supplied locally or by the authenticated transport. */
  readonly workerHostId?: string;
  readonly workletId?: string;
  readonly workerId?: string;
  /** Authenticated remote connection fence when admission crossed a Control Plane transport. */
  readonly connectionGeneration?: number;
  readonly attemptId: string;
  readonly taskId: string;
  readonly specDigest: string;
  readonly status: AttemptStatus;
}
/** Why a receipt became `unknown`: the execution error, redacted and bounded. */
export interface AttemptUncertainty {
  readonly name: string;
  readonly message: string;
  readonly at: string;
}
export interface AttemptInspection extends AttemptReceipt {
  /** Local journal binding after transient placement reservations are stripped for dispatch. */
  readonly executionSpecDigest?: string;
  readonly control?: HarnessControlCapabilities;
  readonly lastSequence: number;
  readonly cancellationRequested?: boolean;
  /**
   * Set when the receipt became `unknown`, and kept after an operator confirms cleanup. The same
   * error is in the journal's `execution.uncertain` event, which reaches the Control Plane on
   * every transport.
   */
  readonly uncertainty?: AttemptUncertainty;
}
/** An Attempt whose receipt is `unknown`: it may have executed and keeps its Worker's capacity. */
export interface UncertainAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId?: string;
  readonly uncertainty?: AttemptUncertainty;
}
export interface DurableLocalWorkletOptions {
  /**
   * Called with every uncertain Attempt whenever that set may have changed, such as for a host
   * service's status. Errors thrown here are ignored.
   */
  readonly onUncertainAttempts?: (attempts: readonly UncertainAttempt[]) => void;
}
/** Another live (or unverifiable) process, such as a running host service, owns the journal. */
export class AttemptJournalOwnedError extends Error {
  constructor() {
    super("Attempt journal already owned by a live or unverifiable process");
    this.name = "AttemptJournalOwnedError";
  }
}
class InvalidTaskAttemptEventError extends Error {
  constructor(event: TaskAttemptEvent, cause: unknown) {
    super(
      `Invalid Worker event type ${JSON.stringify(event?.type)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "InvalidTaskAttemptEventError";
  }
}
/** Largest journaled event; the gRPC transport refuses larger event documents. */
const MAX_JOURNALED_EVENT_BYTES = 3 * 1024 * 1024;
/** Longest uncertainty message a receipt or event keeps. */
const UNCERTAINTY_MESSAGE_LIMIT = 2000;
function uncertaintyOf(
  error: unknown,
  redact: (text: string, structural?: boolean) => string,
): AttemptUncertainty {
  const at = new Date().toISOString();
  if (!(error instanceof Error))
    return {
      name: "ExecutionOutcomeUnknown",
      message:
        error === undefined
          ? "The Worker's event stream ended without execution.completed or execution.failed."
          : redact(String(error)).slice(0, UNCERTAINTY_MESSAGE_LIMIT),
      at,
    };
  // Only the top-level name and message. Causes, stacks, and other fields can hold values only
  // the Worker knows to redact; a Worker reports those details redacted in its own events.
  const safe = redactDiagnostics(
    { name: error.name || "Error", message: error.message },
    redact,
  ) as {
    name: string;
    message: string;
  };
  return {
    name: safe.name.slice(0, 200),
    message: safe.message.slice(0, UNCERTAINTY_MESSAGE_LIMIT),
    at,
  };
}
export interface AttemptJournalEvent {
  readonly sequence: number;
  readonly event: TaskAttemptEvent;
}
export interface DurableWorklet extends Worklet {
  accept(spec: TaskAttemptSpec): Promise<AttemptReceipt>;
  inspect(attemptId: string): Promise<AttemptInspection | undefined>;
  /** Inspect only the selected connected Worklet; absence there proves it never accepted. */
  inspectOnHost?(
    attemptId: string,
    workerHostId: string,
    workletId: string,
  ): Promise<AttemptInspection | undefined>;
  /** The signal stops observation only; accepted execution survives disconnect or unsubscribe. */
  events(
    attemptId: string,
    after?: number,
    signal?: AbortSignal,
  ): AsyncIterable<AttemptJournalEvent>;
  /** Records cancellation intent. Inspect until terminal to learn whether cleanup completed. */
  cancel(attemptId: string, reason: string): Promise<AttemptInspection>;
}
interface RecordState {
  inspection: AttemptInspection;
  events: AttemptJournalEvent[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function terminal(status: AttemptStatus): boolean {
  return !["accepted", "running"].includes(status);
}
/** A private, single-supervisor journal. Never stores an execution specification. */
export class FileAttemptJournal {
  readonly directory: string;
  #initialized = false;
  #initialization: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #database: Database.Database | undefined;
  #ownershipDatabase: Database.Database | undefined;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  initialize(): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Attempt journal is closing"));
    if (this.#initialization) return this.#initialization;
    if (this.#initialized) return Promise.reject(new Error("Attempt journal already open"));
    this.#initialization = this.#initialize().finally(() => {
      this.#initialization = undefined;
    });
    return this.#initialization;
  }
  async #initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Attempt journal must be a private directory");
    const guard = join(this.directory, "acquiring.lock");
    let ownsGuard = false;
    try {
      // Acquire kernel ownership before touching an acquisition marker. A crash releases
      // this lock even when the process used a different PID namespace.
      const ownershipPath = join(this.directory, "owner.sqlite");
      try {
        const file = await open(ownershipPath, "wx", 0o600);
        await file.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const ownershipStat = await lstat(ownershipPath);
      if (
        !ownershipStat.isFile() ||
        ownershipStat.isSymbolicLink() ||
        (ownershipStat.mode & 0o077) !== 0
      )
        throw new Error("Unsafe journal ownership database");
      this.#ownershipDatabase = new Database(ownershipPath, { timeout: 0 });
      try {
        this.#ownershipDatabase.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_BUSY")
          throw new AttemptJournalOwnedError();
        throw error;
      }
      try {
        // A hard link is an atomic modern marker, with no partially written metadata.
        // Older supervisors create directories here; never reclaim those guards.
        try {
          await link(ownershipPath, guard);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const entry = await lstat(guard);
          if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            entry.dev !== ownershipStat.dev ||
            entry.ino !== ownershipStat.ino
          )
            throw new Error("Journal acquisition guard cannot be verified");
          // Do not open/read this hard link: closing another descriptor for the same
          // inode can release POSIX locks held by SQLite in this process.
        }
        ownsGuard = true;
        const ownerPath = join(this.directory, "owner.lock");
        try {
          const ownerStat = await lstat(ownerPath);
          if (!ownerStat.isFile() || ownerStat.isSymbolicLink())
            throw new Error("Unsafe journal owner lock");
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
            pid: number;
            host: string;
            ownership?: "sqlite";
          };
          if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            throw new Error("Journal owner cannot be verified");
          if (owner.ownership !== "sqlite") {
            if (owner.ownership !== undefined)
              throw new Error("Unknown journal ownership protocol");
            throw new AttemptJournalOwnedError();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const temporaryOwnerPath = join(this.directory, `owner-${randomUUID()}.tmp`);
        try {
          const lock = await open(temporaryOwnerPath, "wx", 0o600);
          try {
            await lock.writeFile(
              JSON.stringify({ pid: process.pid, host: hostname(), ownership: "sqlite" }),
            );
            await lock.sync();
          } finally {
            await lock.close();
          }
          await rename(temporaryOwnerPath, ownerPath);
        } finally {
          await rm(temporaryOwnerPath, { force: true });
        }
      } finally {
        if (ownsGuard) await rm(guard);
      }
    } catch (error) {
      this.#ownershipDatabase?.close();
      this.#ownershipDatabase = undefined;
      throw error;
    }
    this.#initialized = true;
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const path = join(this.directory, `attempts.sqlite${suffix}`);
        try {
          const entry = await lstat(path);
          if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0)
            throw new Error("Unsafe attempt journal database");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const file = await open(join(this.directory, "attempts.sqlite"), "a", 0o600);
      await file.close();
      const database = new Database(join(this.directory, "attempts.sqlite"));
      this.#database = database;
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.exec(`CREATE TABLE IF NOT EXISTS receipts (attempt_id TEXT PRIMARY KEY, inspection TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (attempt_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (attempt_id, sequence));
        CREATE TABLE IF NOT EXISTS controls (attempt_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL, acknowledgement TEXT NOT NULL, PRIMARY KEY (attempt_id, command_id));`);
    } catch (error) {
      await this.#closeOwnedResources();
      throw error;
    }
  }
  #db(): Database.Database {
    if (!this.#database) throw new Error("Attempt journal is not open");
    return this.#database;
  }
  #replace(record: RecordState): void {
    if (!Array.isArray(record.events) || record.inspection.lastSequence !== record.events.length)
      throw new Error("Invalid attempt journal sequence");
    for (const [index, entry] of record.events.entries()) {
      if (
        entry.sequence !== index + 1 ||
        entry.event.attemptId !== record.inspection.attemptId ||
        entry.event.taskId !== record.inspection.taskId
      )
        throw new Error("Invalid attempt journal event");
    }
    const db = this.#db();
    db.prepare("INSERT OR REPLACE INTO receipts VALUES (?, ?)").run(
      record.inspection.attemptId,
      JSON.stringify(record.inspection),
    );
    db.prepare("DELETE FROM events WHERE attempt_id = ?").run(record.inspection.attemptId);
    const insert = db.prepare("INSERT INTO events VALUES (?, ?, ?)");
    for (const entry of record.events)
      insert.run(record.inspection.attemptId, entry.sequence, JSON.stringify(entry.event));
  }
  /** Compatibility snapshot API. Streaming callers should use readEvents instead. */
  async readAll(): Promise<RecordState[]> {
    if (this.#initialization || !this.#initialized) await this.initialize();
    const records: RecordState[] = [];
    for (const inspection of this.inspections()) {
      const events: AttemptJournalEvent[] = [];
      let after = 0;
      while (true) {
        const page = this.readEvents(inspection.attemptId, after);
        if (page.length === 0) break;
        events.push(...page);
        after = page.at(-1)?.sequence ?? after;
      }
      records.push({ inspection, events });
    }
    return records;
  }
  /** Compatibility snapshot replacement; not used by DurableLocalWorklet. */
  async write(record: RecordState): Promise<void> {
    this.#db().transaction(() => this.#replace(record))();
  }
  inspections(): AttemptInspection[] {
    return (
      this.#db().prepare("SELECT inspection FROM receipts").all() as { inspection: string }[]
    ).map((row) => JSON.parse(row.inspection) as AttemptInspection);
  }
  putInspection(inspection: AttemptInspection): void {
    this.#db()
      .prepare("INSERT OR REPLACE INTO receipts VALUES (?, ?)")
      .run(inspection.attemptId, JSON.stringify(inspection));
  }
  /** Requires exclusive journal ownership. Never treats unknown work as successful. */
  confirmStopped(attemptId: string, taskId: string, evidence: string): AttemptInspection {
    if (!evidence.trim() || evidence.length > 4000)
      throw new Error("Cleanup evidence is required (maximum 4000 characters)");
    const inspection = this.inspections().find((entry) => entry.attemptId === attemptId);
    if (!inspection || inspection.taskId !== taskId)
      throw new Error("Task and Attempt identity do not match this journal");
    if (!["unknown", "running", "accepted"].includes(inspection.status))
      throw new Error(
        "Attempt already has a terminal receipt, so there is nothing to recover; start the host again so the Control Plane records it",
      );
    return this.append(
      { ...inspection, status: "failed" },
      {
        taskId,
        attemptId,
        at: new Date().toISOString(),
        type: "execution.failed",
        error: {
          name: "InterruptedExecutionOutcomeUnknown",
          message: `Execution cleanup confirmed. Task outcome remains unknown; do not automatically replay. ${evidence}`,
        },
      },
    );
  }
  readControl(
    attemptId: string,
    commandId: string,
  ): { digest: string; acknowledgement: HarnessControlAcknowledgement } | undefined {
    const row = this.#db()
      .prepare(
        "SELECT digest, acknowledgement FROM controls WHERE attempt_id = ? AND command_id = ?",
      )
      .get(attemptId, commandId) as { digest: string; acknowledgement: string } | undefined;
    return row
      ? { digest: row.digest, acknowledgement: JSON.parse(row.acknowledgement) }
      : undefined;
  }
  putControl(
    command: HarnessControlCommand,
    digest: string,
    acknowledgement: HarnessControlAcknowledgement,
  ): void {
    this.#db()
      .prepare("INSERT OR REPLACE INTO controls VALUES (?, ?, ?, ?)")
      .run(command.attemptId, command.id, digest, JSON.stringify(acknowledgement));
  }
  controlCount(attemptId: string): number {
    return (
      this.#db()
        .prepare("SELECT count(*) AS count FROM controls WHERE attempt_id = ?")
        .get(attemptId) as { count: number }
    ).count;
  }
  /**
   * Marks a receipt `unknown` and keeps why: the receipt records `uncertainty`, and an
   * `execution.uncertain` event carries the same error to observers, in one transaction.
   */
  markUnknown(inspection: AttemptInspection, uncertainty: AttemptUncertainty): AttemptInspection {
    return this.append(
      { ...inspection, status: "unknown", uncertainty },
      {
        taskId: inspection.taskId,
        attemptId: inspection.attemptId,
        at: uncertainty.at,
        type: "execution.uncertain",
        error: { name: uncertainty.name, message: uncertainty.message },
      },
    );
  }
  append(inspection: AttemptInspection, event: TaskAttemptEvent): AttemptInspection {
    // Journal only what the Worklet transports can deliver: a known event type with its
    // required fields (extra fields are kept), within the gRPC event document limit.
    try {
      decodeTaskAttemptEvent(event);
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_JOURNALED_EVENT_BYTES)
        throw new Error(`Event exceeds ${MAX_JOURNALED_EVENT_BYTES} bytes`);
    } catch (error) {
      throw new InvalidTaskAttemptEventError(event, error);
    }
    const next = { ...inspection, lastSequence: inspection.lastSequence + 1 };
    this.#db().transaction(() => {
      this.#db()
        .prepare("INSERT INTO events VALUES (?, ?, ?)")
        .run(inspection.attemptId, next.lastSequence, JSON.stringify(event));
      this.putInspection(next);
    })();
    return next;
  }
  readEvents(attemptId: string, after = 0, limit = 100): AttemptJournalEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid event cursor or limit");
    return (
      this.#db()
        .prepare(
          "SELECT sequence, event FROM events WHERE attempt_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        )
        .all(attemptId, after, limit) as { sequence: number; event: string }[]
    ).map((row) => ({ sequence: row.sequence, event: JSON.parse(row.event) as TaskAttemptEvent }));
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      // Initialization failure releases its own resources. Successful initialization
      // must finish before close can remove the owner record and kernel lock.
      await this.#initialization?.catch(() => undefined);
      await this.#closeOwnedResources();
    })().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }
  async #closeOwnedResources(): Promise<void> {
    this.#database?.close();
    this.#database = undefined;
    try {
      if (this.#initialized) {
        await rm(join(this.directory, "owner.lock"));
        this.#initialized = false;
      }
    } finally {
      this.#ownershipDatabase?.close();
      this.#ownershipDatabase = undefined;
    }
  }
}
/** Admission outlives observers; only explicit cancellation reaches execution. */
export class DurableLocalWorklet implements DurableWorklet {
  readonly id: string;
  readonly #worklet: Worklet;
  readonly #journal: FileAttemptJournal;
  readonly #records = new Map<string, { inspection: AttemptInspection }>();
  readonly #active = new Map<string, { controller: AbortController; workerId: string }>();
  readonly #ready: Promise<void>;
  readonly #runs = new Set<Promise<void>>();
  readonly #controls = new Set<Promise<HarnessControlAcknowledgement>>();
  readonly #placementReservations = new WorkletPlacementReservations();
  readonly #options: DurableLocalWorkletOptions;
  #closing = false;
  #lock: Promise<unknown> = Promise.resolve();
  constructor(
    worklet: Worklet,
    journal: FileAttemptJournal,
    options: DurableLocalWorkletOptions = {},
  ) {
    this.id = worklet.id;
    this.#worklet = worklet;
    this.#journal = journal;
    this.#options = options;
    this.#ready = (async () => {
      await journal.initialize();
      for (const inspection of journal.inspections()) {
        // An Attempt still accepted or running in the journal was interrupted with this process.
        const recovered = terminal(inspection.status)
          ? inspection
          : journal.markUnknown(inspection, {
              name: "WorkletInterrupted",
              message:
                "The Worklet stopped while this Attempt was accepted or running, so whether its execution finished is unknown.",
              at: new Date().toISOString(),
            });
        this.#records.set(inspection.attemptId, { inspection: recovered });
      }
      this.#publishUncertain();
    })();
    void this.#ready.catch(() => {});
  }
  /** Reports every uncertain Attempt to `onUncertainAttempts`. */
  #publishUncertain(): void {
    const report = this.#options.onUncertainAttempts;
    if (!report) return;
    const attempts = [...this.#records.values()]
      .map(({ inspection }) => inspection)
      .filter(
        (inspection) => inspection.status === "unknown" && !this.#active.has(inspection.attemptId),
      )
      .map((inspection) => ({
        attemptId: inspection.attemptId,
        taskId: inspection.taskId,
        ...(inspection.workerId === undefined ? {} : { workerId: inspection.workerId }),
        ...(inspection.uncertainty === undefined ? {} : { uncertainty: inspection.uncertainty }),
      }));
    try {
      report(attempts);
    } catch {
      /* Status reporting never affects execution. */
    }
  }
  async shutdown(reason: string): Promise<void> {
    await this.#ready;
    await this.#exclusive(async () => {
      this.#closing = true;
    });
    await Promise.all([...this.#active.keys()].map((id) => this.cancel(id, reason)));
    await Promise.all([...this.#runs]);
    await this.close();
  }
  async close(): Promise<void> {
    await this.#ready;
    await this.#exclusive(async () => {
      if (this.#active.size) throw new Error("Cannot close while attempts are active");
      this.#closing = true;
    });
    await Promise.allSettled([...this.#controls]);
    await this.#exclusive(async () => {
      await this.#journal.close();
    });
  }
  async describe() {
    await this.#ready;
    return {
      ...(await probeWorklet(() => this.#worklet.describe())),
      durableProtocolVersion: 1 as const,
      controlProtocolVersion: 1 as const,
    };
  }
  async controlCapabilities(
    taskId: string,
    attemptId: string,
  ): Promise<HarnessControlCapabilities | undefined> {
    await this.#ready;
    const record = this.#records.get(attemptId)?.inspection;
    const active = this.#active.get(attemptId);
    if (
      this.#closing ||
      record?.taskId !== taskId ||
      record.status !== "running" ||
      active === undefined ||
      active.controller.signal.aborted
    )
      return undefined;
    const capabilities = await probeWorklet(() =>
      this.#worklet.controlCapabilities?.(taskId, attemptId),
    );
    if (
      this.#closing ||
      this.#active.get(attemptId) !== active ||
      active.controller.signal.aborted ||
      this.#records.get(attemptId)?.inspection.status !== "running"
    )
      return undefined;
    if (capabilities) validateHarnessControlCapabilities(capabilities);
    return capabilities;
  }
  control(
    command: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    const pending = this.#control(validateHarnessControlCommand(command), options);
    this.#controls.add(pending);
    void pending.finally(() => this.#controls.delete(pending)).catch(() => {});
    return pending;
  }
  async #control(
    command: HarnessControlCommand,
    options?: HarnessControlOptions,
  ): Promise<HarnessControlAcknowledgement> {
    await this.#ready;
    const identity = { id: command.id, taskId: command.taskId, attemptId: command.attemptId };
    const digest = hash(canonical(command));
    // Probe extensions outside journal serialization so a stalled adapter cannot stop
    // unrelated event appends or cancellation. Revalidate ownership before committing.
    const previous = this.#journal.readControl(command.attemptId, command.id);
    if (previous)
      return previous.digest === digest
        ? previous.acknowledgement
        : {
            ...identity,
            status: "rejected",
            reason: "Control command ID conflicts with an earlier command",
          };
    const active = this.#active.get(command.attemptId);
    const capabilities = await this.controlCapabilities(command.taskId, command.attemptId).catch(
      () => undefined,
    );
    const reserved = await this.#exclusive(async () => {
      const existing = this.#journal.readControl(command.attemptId, command.id);
      if (existing)
        return {
          dispatch: false,
          acknowledgement:
            existing.digest === digest
              ? existing.acknowledgement
              : {
                  ...identity,
                  status: "rejected" as const,
                  reason: "Control command ID conflicts with an earlier command",
                },
        };
      if (!this.#records.has(command.attemptId))
        return {
          dispatch: false,
          acknowledgement: { ...identity, status: "rejected" as const, reason: "Unknown Attempt" },
        };
      const record = this.#records.get(command.attemptId)?.inspection;
      const allowed =
        !this.#closing &&
        active !== undefined &&
        !active.controller.signal.aborted &&
        this.#active.get(command.attemptId) === active &&
        record?.status === "running" &&
        record.taskId === command.taskId &&
        !!this.#worklet.control &&
        capabilities?.operations.includes(command.type);
      if (this.#journal.controlCount(command.attemptId) >= 1024)
        return {
          dispatch: false,
          acknowledgement: {
            ...identity,
            status: "rejected" as const,
            reason: "Control history limit reached",
          },
        };
      const acknowledgement: HarnessControlAcknowledgement = {
        ...identity,
        status: allowed ? "unknown" : "rejected",
        reason: allowed
          ? "Native control outcome is not yet confirmed"
          : "Attempt has no supported active control channel",
      };
      // Commit uncertainty before any native side effect. Recovered uncertainty is never dispatched.
      this.#journal.putControl(command, digest, acknowledgement);
      return { dispatch: !!allowed, acknowledgement };
    });
    if (!reserved.dispatch) return reserved.acknowledgement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledgement: HarnessControlAcknowledgement;
    try {
      const result = await Promise.race([
        this.#worklet.control?.(command, options),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Control timed out")), 5000);
          timer.unref();
        }),
      ]);
      if (
        !result ||
        result.id !== command.id ||
        result.taskId !== command.taskId ||
        result.attemptId !== command.attemptId ||
        !["accepted", "rejected", "unknown"].includes(result.status)
      )
        throw new Error("Invalid native control acknowledgement");
      acknowledgement = { ...identity, status: result.status };
    } catch {
      acknowledgement = {
        ...identity,
        status: "unknown",
        reason: "Native control outcome could not be confirmed; do not redispatch",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    await this.#exclusive(async () => {
      this.#journal.putControl(command, digest, acknowledgement);
    });
    return acknowledgement;
  }
  async selectExecution(
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions = {},
  ) {
    const placement = await this.selectPlacement(requirements, contextPlan, options);
    if (placement?.reservation) this.#placementReservations.release(placement.reservation);
    return placement?.workerProfile;
  }
  async selectPlacement(
    requirements: TaskExecutionRequirements,
    contextPlan: TagContextPlan,
    options: ExecutionSelectionOptions = {},
  ): Promise<WorkletExecutionPlacement | undefined> {
    await this.#ready;
    if (this.#closing) return undefined;
    if (
      options.allowedWorkerHostIds !== undefined &&
      !options.allowedWorkerHostIds.includes((await this.describe()).host.id)
    )
      return undefined;
    const descriptor = await this.describe();
    const active = (workerId: string) =>
      [...this.#active.values()].filter((entry) => entry.workerId === workerId).length +
      [...this.#records.values()].filter(
        ({ inspection }) =>
          inspection.status === "unknown" &&
          !this.#active.has(inspection.attemptId) &&
          (inspection.workerId === undefined || inspection.workerId === workerId),
      ).length +
      this.#placementReservations.count(workerId);
    const workerProfile = selectDescriptorExecution(
      descriptor.host.workers,
      requirements,
      contextPlan,
      options,
      active,
    );
    if (!workerProfile) return undefined;
    const worker = descriptor.host.workers
      .filter(
        (candidate) =>
          active(candidate.id) < workerSlots(candidate, options.coordinationSlot) &&
          candidate.profiles.some(
            (profile) =>
              profile.id === workerProfile.id && profile.revision === workerProfile.revision,
          ),
      )
      .toSorted(
        (left, right) =>
          active(left.id) / (left.maxConcurrency ?? 1) -
            active(right.id) / (right.maxConcurrency ?? 1) || left.id.localeCompare(right.id),
      )[0];
    if (!worker) return undefined;
    return {
      workerHostId: descriptor.host.id,
      workletId: descriptor.id,
      workerId: worker.id,
      workerProfile,
      reservation: this.#placementReservations.reserve(worker.id, workerProfile),
    };
  }
  releasePlacement(placement: WorkletExecutionPlacement): void {
    if (placement.reservation) this.#placementReservations.release(placement.reservation);
  }
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(work);
    this.#lock = result.catch(() => {});
    return result;
  }
  async accept(spec: TaskAttemptSpec): Promise<AttemptReceipt> {
    await this.#ready;
    if (this.#closing) throw new Error("Durable Worklet is closing");
    if (
      spec.placement !== undefined &&
      (!spec.placement.allowedWorkerHostIds.includes((await this.describe()).host.id) ||
        (spec.placement.workerHostId !== undefined &&
          spec.placement.workerHostId !== (await this.describe()).host.id) ||
        (spec.placement.workletId !== undefined &&
          spec.placement.workletId !== (await this.describe()).id))
    )
      throw new WorkletAdmissionRejectedError(`Worker Host is not bound to Tag ${spec.tag.name}`);
    const specDigest = hash(canonical(spec));
    const previous = this.#records.get(spec.attemptId);
    if (previous) {
      if (previous.inspection.specDigest !== specDigest)
        throw new Error("Attempt specification conflict");
      return { ...previous.inspection };
    }
    const descriptor = await this.describe();
    return this.#exclusive(async () => {
      if (this.#closing) throw new Error("Durable Worklet is closing");
      const existing = this.#records.get(spec.attemptId);
      if (existing) {
        if (existing.inspection.specDigest !== specDigest)
          throw new Error("Attempt specification conflict");
        return { ...existing.inspection };
      }
      if (descriptor.host.workers.length > 1 && !hasWorkerDispatch(this.#worklet))
        throw new Error("Durable multi-Worker admission requires executeOnWorker");
      if (spec.placement?.reservation !== undefined) {
        if (spec.placement.workerId === undefined)
          throw new WorkletAdmissionRejectedError("Reserved placement has no selected Worker");
        const consumed = this.#placementReservations.consume(
          spec.placement.reservation,
          spec.placement.workerId,
          spec.workerProfile,
        );
        if (consumed !== "accepted")
          throw new WorkletAdmissionRejectedError(`Placement reservation ${consumed}`);
      }
      const worker = descriptor.host.workers.find(
        (d) =>
          (spec.placement?.workerId === undefined || d.id === spec.placement.workerId) &&
          d.profiles.some(
            (p) => p.id === spec.workerProfile.id && p.revision === spec.workerProfile.revision,
          ) &&
          descriptorSupportsExecution(d, spec.workerProfile, spec.execution) &&
          descriptorSupportsRequiredContext(d, spec.contextPlan, spec.workerProfile) &&
          (!(spec.coordination || spec.authorization.version === 4) ||
            descriptorSupportsCoordination(d, spec.workerProfile)) &&
          (spec.coordination?.scope !== "surface" ||
            descriptorSupportsSurfaceCoordination(d, spec.workerProfile)) &&
          [...this.#active.values()].filter((a) => a.workerId === d.id).length +
            [...this.#records.values()].filter(
              ({ inspection }) =>
                inspection.status === "unknown" &&
                !this.#active.has(inspection.attemptId) &&
                (inspection.workerId === undefined || inspection.workerId === d.id),
            ).length +
            this.#placementReservations.count(d.id) <
            workerSlots(d, spec.placement?.coordinationSlot),
      );
      if (!worker) throw new Error("No eligible Worker capacity");
      const controller = new AbortController();
      this.#active.set(spec.attemptId, { controller, workerId: worker.id });
      const record = {
        inspection: {
          workerHostId: descriptor.host.id,
          workletId: descriptor.id,
          workerId: worker.id,
          attemptId: spec.attemptId,
          taskId: spec.taskId,
          specDigest,
          status: "accepted" as const,
          lastSequence: 0,
        },
      };
      try {
        this.#journal.putInspection(record.inspection);
      } catch (error) {
        this.#active.delete(spec.attemptId);
        throw error;
      }
      this.#records.set(spec.attemptId, record);
      const run = this.#run(spec, record, controller).catch(() => {
        /* Failed journal writes remain unfinished and recover as unknown. */
      });
      this.#runs.add(run);
      void run.finally(() => this.#runs.delete(run));
      return { ...record.inspection };
    });
  }
  async #run(
    spec: TaskAttemptSpec,
    record: { inspection: AttemptInspection },
    controller: AbortController,
    recoveredEvents?: AsyncIterable<TaskAttemptEvent>,
  ): Promise<void> {
    const secrets = [...sensitiveEnvironmentValues(process.env), ...sensitiveFieldValues(spec)];
    const redact = (text: string, structural = false): string =>
      redactText(text, secrets, structural);
    let finalStatus: AttemptStatus = "unknown";
    let terminalEvent:
      | Extract<TaskAttemptEvent, { type: "execution.completed" | "execution.failed" }>
      | undefined;
    let terminalThrow: TaskAttemptEvent | undefined;
    // Why execution ended without a terminal event; kept when the receipt becomes `unknown`.
    let failure: unknown;
    try {
      await this.#exclusive(async () => {
        const inspection = {
          ...record.inspection,
          status: "running" as const,
          executionSpecDigest: hash(canonical(withoutPlacementReservation(spec))),
        };
        this.#journal.putInspection(inspection);
        record.inspection = inspection;
      });
      const workerId = this.#active.get(spec.attemptId)?.workerId;
      const dispatchSpec = withoutPlacementReservation(spec);
      const execution =
        recoveredEvents ??
        (hasWorkerDispatch(this.#worklet) && workerId !== undefined
          ? this.#worklet.executeOnWorker(workerId, dispatchSpec, controller.signal)
          : this.#worklet.execute(dispatchSpec, controller.signal));
      for await (const event of execution) {
        if (event.attemptId !== spec.attemptId || event.taskId !== spec.taskId)
          throw new Error("Worker event identity mismatch");
        await this.#exclusive(async () => {
          const sanitized = redactEventDiagnostics(event, redact);
          if (
            event.type === "execution.limits.applied" &&
            sanitized.type === "execution.limits.applied"
          ) {
            const requested = spec.execution.limits ?? {};
            if (canonical(event.requested) !== canonical(requested))
              throw new Error("Worker applied-limit event does not match the Attempt request");
          }
          record.inspection = this.#journal.append(record.inspection, sanitized);
          if (sanitized.type === "execution.completed" || sanitized.type === "execution.failed")
            terminalEvent = sanitized;
        });
      }
      finalStatus = controller.signal.aborted
        ? "cancelled"
        : terminalEvent?.type === "execution.completed"
          ? "completed"
          : terminalEvent?.type === "execution.failed"
            ? "failed"
            : "unknown";
    } catch (error) {
      failure = error;
      // A throw after cancellation is the Worker's cleanup acknowledgment, as when the stream
      // ends after cancellation: the Attempt is cancelled even if a terminal event came first.
      const cancelled =
        controller.signal.aborted &&
        !(error instanceof InvalidTaskAttemptEventError) &&
        !(error instanceof Error && error.name === "ExecutionCleanupError");
      if (terminalEvent && !cancelled) {
        const thrown = uncertaintyOf(error, redact);
        const original =
          terminalEvent.type === "execution.failed" ? terminalEvent.error : undefined;
        const laterError = `${thrown.name}: ${thrown.message}`.slice(0, UNCERTAINTY_MESSAGE_LIMIT);
        const earlierError = original
          ? `${original.message.slice(0, Math.max(0, UNCERTAINTY_MESSAGE_LIMIT - laterError.length - 2))}; `
          : "";
        terminalThrow = {
          type: "execution.failed",
          taskId: spec.taskId,
          attemptId: spec.attemptId,
          at: thrown.at,
          error: {
            name: original?.name ?? thrown.name,
            message: `${earlierError}${laterError}`.slice(0, UNCERTAINTY_MESSAGE_LIMIT),
          },
        };
        finalStatus = "failed";
      } else {
        // Ordinary cancellation follows the Worker cleanup contract. Explicit cleanup
        // uncertainty overrides cancellation and must retain the reservation.
        finalStatus =
          error instanceof InvalidTaskAttemptEventError ||
          (error instanceof ExecutionCleanupError && !error.hostUnsafe)
            ? "failed"
            : controller.signal.aborted &&
                !(error instanceof Error && error.name === "ExecutionCleanupError")
              ? "cancelled"
              : "unknown";
      }
    } finally {
      try {
        await this.#exclusive(async () => {
          if (
            failure instanceof InvalidTaskAttemptEventError ||
            (failure instanceof ExecutionCleanupError && !failure.hostUnsafe)
          )
            record.inspection = this.#journal.append(
              { ...record.inspection, status: "failed" },
              {
                taskId: spec.taskId,
                attemptId: spec.attemptId,
                at: new Date().toISOString(),
                type: "execution.failed",
                error: {
                  name: failure.name,
                  message: redact(failure.message),
                },
              },
            );
          else if (finalStatus === "unknown")
            record.inspection = this.#journal.markUnknown(
              record.inspection,
              uncertaintyOf(failure, redact),
            );
          else if (terminalThrow)
            record.inspection = this.#journal.append(
              { ...record.inspection, status: "failed" },
              terminalThrow,
            );
          else {
            const inspection = { ...record.inspection, status: finalStatus };
            this.#journal.putInspection(inspection);
            record.inspection = inspection;
          }
          this.#active.delete(spec.attemptId);
        });
        if (finalStatus === "completed" && record.inspection.workerId)
          await this.#worklet
            .acknowledgeOutputFinalization?.(
              record.inspection.workerId,
              spec.attemptId,
              record.inspection.executionSpecDigest ?? record.inspection.specDigest,
            )
            .catch(() => {});
      } catch (journalError) {
        // The journal could not record the outcome; keep why in memory for inspection.
        this.#active.delete(spec.attemptId);
        record.inspection = {
          ...record.inspection,
          status: "unknown",
          uncertainty: uncertaintyOf(
            new Error(
              `The Attempt journal could not record the outcome: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
            ),
            redact,
          ),
        };
      }
      this.#publishUncertain();
    }
  }
  async inspect(attemptId: string): Promise<AttemptInspection | undefined> {
    await this.#ready;
    const record = this.#records.get(attemptId);
    if (!record) return undefined;
    if (
      record.inspection.status === "unknown" &&
      record.inspection.workerId &&
      !this.#closing &&
      this.#worklet.recoverOutputFinalization
    ) {
      await this.#exclusive(async () => {
        if (this.#active.has(attemptId) || record.inspection.status !== "unknown" || this.#closing)
          return;
        const workerId = record.inspection.workerId;
        if (!workerId) return;
        const controller = new AbortController();
        const recovered = await this.#worklet.recoverOutputFinalization?.(
          workerId,
          attemptId,
          record.inspection.executionSpecDigest ?? record.inspection.specDigest,
          controller.signal,
        );
        if (!recovered) return;
        if (
          recovered.spec.attemptId !== attemptId ||
          recovered.spec.taskId !== record.inspection.taskId ||
          hash(canonical(recovered.spec)) !==
            (record.inspection.executionSpecDigest ?? record.inspection.specDigest)
        )
          throw new Error("Recovered output identity mismatch");
        this.#active.set(attemptId, { controller, workerId });
        const { uncertainty: _resolved, ...resumed } = record.inspection;
        record.inspection = { ...resumed, status: "running" };
        this.#journal.putInspection(record.inspection);
        const run = this.#run(recovered.spec, record, controller, recovered.events).catch(() => {});
        this.#runs.add(run);
        void run.finally(() => this.#runs.delete(run));
      });
    }
    if (record.inspection.status === "unknown" && record.inspection.workerId && !this.#closing) {
      await this.#exclusive(async () => {
        if (record.inspection.status !== "unknown" || this.#active.has(attemptId) || this.#closing)
          return;
        const workerId = record.inspection.workerId;
        if (
          workerId &&
          (await this.#worklet.recoverExecutionCleanup?.(
            workerId,
            record.inspection.taskId,
            attemptId,
            record.inspection.executionSpecDigest ?? record.inspection.specDigest,
          ))
        )
          record.inspection = this.#journal.confirmStopped(
            attemptId,
            record.inspection.taskId,
            "Worker cleanup recovery verified stopped execution for the dispatched specification.",
          );
      });
      this.#publishUncertain();
    }
    const control = await this.controlCapabilities(record.inspection.taskId, attemptId);
    return { ...record.inspection, ...(control ? { control } : {}) };
  }
  async *events(
    attemptId: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncIterable<AttemptJournalEvent> {
    await this.#ready;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor");
    const record = this.#records.get(attemptId);
    if (!record) throw new Error("Unknown attempt");
    let cursor = after;
    while (!signal?.aborted) {
      const page = this.#journal.readEvents(attemptId, cursor);
      for (const event of page)
        if (event.sequence > cursor) {
          if (signal?.aborted) return;
          cursor = event.sequence;
          yield structuredClone(event);
        }
      if (page.length === 100 || cursor < record.inspection.lastSequence) continue;
      if (terminal(record.inspection.status)) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 10);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
  async cancel(attemptId: string, reason: string): Promise<AttemptInspection> {
    await this.#ready;
    return this.#exclusive(async () => {
      const record = this.#records.get(attemptId);
      if (!record) throw new Error("Unknown attempt");
      if (["accepted", "running", "unknown"].includes(record.inspection.status)) {
        record.inspection = { ...record.inspection, cancellationRequested: true };
        this.#journal.putInspection(record.inspection);
        // Keep the AbortError name Harnesses match on, but record why execution stopped.
        this.#active.get(attemptId)?.controller.abort(new DOMException(reason, "AbortError"));
      }
      return { ...record.inspection };
    });
  }
  /** Observer-only compatibility facade; use cancel() to stop accepted execution. */
  async *execute(spec: TaskAttemptSpec, signal?: AbortSignal): AsyncIterable<TaskAttemptEvent> {
    await this.accept(spec);
    for await (const entry of this.events(spec.attemptId, 0, signal)) yield entry.event;
  }
}

function withoutPlacementReservation(spec: TaskAttemptSpec): TaskAttemptSpec {
  if (spec.placement?.reservation === undefined) return spec;
  const { reservation: _reservation, ...placement } = spec.placement;
  return { ...spec, placement };
}

function hasWorkerDispatch(worklet: Worklet): worklet is Worklet & {
  executeOnWorker(
    workerId: string,
    spec: TaskAttemptSpec,
    signal?: AbortSignal,
  ): AsyncIterable<TaskAttemptEvent>;
} {
  return "executeOnWorker" in worklet && typeof worklet.executeOnWorker === "function";
}
