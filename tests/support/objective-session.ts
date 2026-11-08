import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCoordinationRequest } from "../../apps/cli/src/coordination-http.ts";
import { ControlPlane } from "../../packages/control-plane/src/index.ts";
import {
  type CreateObjectiveInput,
  type DeliveryReason,
  type InternalTurn,
  inboxSessionKey,
  type Objective,
  type Store,
  type Tag,
  type TagMessage,
  type Task,
  type Team,
} from "../../packages/core/src/index.ts";
import {
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.ts";

type SessionReport = Extract<InternalTurn, { readonly kind: "session_report" }>;

/** A Task of a Session, with the turn SuperTag admitted it for; absent for a person's turn. */
export interface SessionTurn {
  readonly task: Task;
  readonly turn?: InternalTurn;
}

export interface ObjectiveSessionOptions {
  readonly store: Store;
  readonly controlPlane: Pick<ControlPlane, "startObjective">;
  readonly ownerTagId: string;
  /** The Team's other members; the owner is always one. */
  readonly memberTagIds?: readonly string[];
  readonly maxConcurrency?: number;
  /** Objective fields; the outcome defaults to a short statement. */
  readonly objective?: Partial<Omit<CreateObjectiveInput, "id" | "teamId">>;
  /** How long each wait polls before it fails. Default 20 seconds. */
  readonly timeoutMs?: number;
}

export interface WaitForTurnOptions {
  /** Only a `delivery` turn for this reason. */
  readonly reason?: DeliveryReason;
  /** Only a `delivery` turn from this kind of sender, such as SuperTag's own notices. */
  readonly from?: "person" | "supertag" | "tag";
  /** Return the Task while it is still pending or running. By default a wait returns it settled. */
  readonly unsettled?: true;
}

export interface ObjectiveSession {
  readonly objective: Objective;
  readonly team: Team;
  /** The Task of the Objective's first turn. */
  readonly startTaskId: string;
  /**
   * The next turn of the Objective's own Session that no earlier wait returned, oldest first. Each
   * call returns a later turn.
   */
  waitForOwnerTurn(options?: WaitForTurnOptions): Promise<SessionTurn>;
  /** The next report turn of the Objective's own Session, for one work Session when named. */
  waitForReport(
    workSessionId?: string,
    options?: Pick<WaitForTurnOptions, "unsettled">,
  ): Promise<SessionTurn & { readonly report: SessionReport }>;
  /** The next turn of the Tag's inbox that no earlier wait returned. */
  waitForInboxTurn(tagId: string, options?: WaitForTurnOptions): Promise<SessionTurn>;
  /**
   * Stores a Mailbox message for the recipient's inbox, as `send_message` does after its checks.
   * The Control Plane's Session sweep admits the inbox turn that takes it.
   */
  deliverMessage(input: {
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly hops?: number;
  }): Promise<TagMessage>;
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

/**
 * Creates a Team of the owner and members and an Objective that names it, then starts the
 * Objective through the Control Plane. The Control Plane must be running.
 */
export async function startObjectiveSession(
  options: ObjectiveSessionOptions,
): Promise<ObjectiveSession> {
  const { store, ownerTagId } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const team = await store.createTeam({
    id: randomUUID(),
    name: `objective-${randomUUID()}`,
    memberTagIds: [...new Set([ownerTagId, ...(options.memberTagIds ?? [])])],
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
  });
  const objective = await store.createObjective({
    outcome: "Finish the test Objective",
    ...options.objective,
    id: randomUUID(),
    ownerTagId,
    teamId: team.id,
  });
  const { taskId: startTaskId } = await options.controlPlane.startObjective(objective.id);
  /** Task ids each Session's waits already returned. */
  const returned = new Map<string, Set<string>>();

  const turnOf = async (task: Task): Promise<SessionTurn> => {
    if (task.inboundEventId === null) return { task };
    const internal = (await store.findInboundEventById(task.inboundEventId))?.event.internal;
    return internal === undefined ? { task } : { task, turn: internal };
  };

  const nextTurn = async (
    findSession: () => Promise<{ readonly id: string } | undefined>,
    label: string,
    matches: (turn: SessionTurn) => boolean,
    unsettled: boolean,
  ): Promise<SessionTurn> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const session = await findSession();
      if (session !== undefined) {
        const seen = returned.get(session.id) ?? new Set<string>();
        returned.set(session.id, seen);
        const tasks = (await store.listTasks({ sessionId: session.id }))
          .filter((task) => !seen.has(task.id))
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        for (const task of tasks) {
          const turn = await turnOf(task);
          if (!matches(turn)) continue;
          if (!unsettled && !SETTLED.has(task.status)) break;
          seen.add(task.id);
          return turn;
        }
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const delivered = (wait: WaitForTurnOptions) => (turn: SessionTurn) => {
    if (wait.reason === undefined && wait.from === undefined) return true;
    if (turn.turn?.kind !== "delivery") return false;
    return (
      (wait.reason === undefined || turn.turn.reason === wait.reason) &&
      (wait.from === undefined || turn.turn.from.kind === wait.from)
    );
  };
  const ownerSession = () => store.findObjectiveOwnerSession(objective.id);

  return {
    objective,
    team,
    startTaskId,
    waitForOwnerTurn: (wait = {}) =>
      nextTurn(
        ownerSession,
        `a turn of Objective ${objective.id}${wait.reason ? ` (${wait.reason})` : ""}${
          wait.from ? ` from ${wait.from}` : ""
        }`,
        delivered(wait),
        wait.unsettled === true,
      ),
    async waitForReport(workSessionId, wait = {}) {
      const found = await nextTurn(
        ownerSession,
        `a report to Objective ${objective.id}${workSessionId ? ` from ${workSessionId}` : ""}`,
        (turn) =>
          turn.turn?.kind === "session_report" &&
          (workSessionId === undefined || turn.turn.workSessionId === workSessionId),
        wait.unsettled === true,
      );
      return { ...found, report: found.turn as SessionReport };
    },
    waitForInboxTurn: (tagId, wait = {}) =>
      nextTurn(
        () => store.findSessionByTagAndKey(tagId, inboxSessionKey(tagId)),
        `an inbox turn of Tag ${tagId}${wait.reason ? ` (${wait.reason})` : ""}`,
        delivered(wait),
        wait.unsettled === true,
      ),
    async deliverMessage(input) {
      const { message } = await store.deliverTagMessage({
        senderTagId: input.from,
        recipientTagId: input.to,
        text: input.text,
        hops: input.hops ?? 0,
        objectiveId: objective.id,
      });
      return message;
    },
  };
}

/** What one tool call returned: the raw result, its text block, and that text parsed as JSON. */
export interface ToolCallResult {
  readonly isError: boolean;
  readonly text: string;
  /** The text parsed as JSON, when it is JSON. */
  readonly json: unknown;
}

/** What kind of turn a Task is, as the Control Plane's tool router decides it. */
export type TurnKind = "objective" | "inbox" | "conversation" | "report" | "work_session";

/** One turn a scripted Tag answers, with everything it needs to act and assert. */
export interface ScriptedTurn {
  readonly spec: TaskAttemptSpec;
  readonly taskId: string;
  readonly sessionId: string;
  readonly sessionKey: string;
  readonly tagId: string;
  readonly tagName: string;
  readonly kind: TurnKind;
  readonly objectiveId?: string;
  /** The turn SuperTag admitted, when it admitted one itself. */
  readonly internal?: InternalTurn;
  /** The system messages of the turn's input, joined. */
  readonly system: string;
  /** The turn's requester text. */
  readonly request: string;
  /** The tools this turn was offered, in the order the Control Plane advertised them. */
  readonly tools: readonly string[];
  /** Calls one coordination tool as the running Attempt. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
}

/** A turn the harness answered, with the calls it made. */
export interface RecordedTurn extends ScriptedTurn {
  readonly calls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly result: ToolCallResult;
  }[];
  /** The final reply text the script gave. */
  readonly reply?: string;
}

/** What a scripted turn did: its reply, and the cost it reports for the Attempt. */
export interface ScriptedAnswer {
  readonly reply?: string;
  /** Reported in `currency` (USD by default), as a Worker reports what its turn cost. */
  readonly reportedCostMinor?: number;
  readonly currency?: string;
}

export interface SessionHarnessOptions {
  /**
   * Answers one turn and returns its final reply, or an answer with the cost it reports.
   * Throwing fails the Task's Attempt. Every turn of every Tag comes here; branch on
   * `turn.kind`, `turn.tagName` and `turn.request`.
   */
  readonly respond: (
    turn: ScriptedTurn,
  ) => Promise<string | ScriptedAnswer | undefined> | string | ScriptedAnswer | undefined;
  /** Attempts per Task. Default 1, so a failing turn fails at once. */
  readonly maxAttempts?: number;
  /** Turns the one Worker runs at once. Default 10. */
  readonly workerConcurrency?: number;
}

export interface SessionHarness {
  readonly store: DrizzleStore;
  readonly controlPlane: ControlPlane;
  /** The Worker Host every Tag of this harness is bound to. */
  readonly workerHostId: string;
  /** Every turn the script answered, oldest first. */
  readonly turns: readonly RecordedTurn[];
  /** Dispatch errors the Control Plane reported. */
  readonly errors: readonly unknown[];
  /** Creates an active Tag bound to the harness's Worker Host. */
  tag(name: string): Promise<Tag>;
  /** The turns of one Session, oldest first. */
  turnsOf(sessionId: string): readonly RecordedTurn[];
  close(): Promise<void>;
}

const HOST_ID = "session-host";

/**
 * A Control Plane with one scripted Worker and a coordination endpoint, for the behaviour of
 * Objective, inbox and work Sessions end to end. Every Tag it creates is bound to its one Worker
 * Host, so every turn runs.
 */
export async function startSessionHarness(options: SessionHarnessOptions): Promise<SessionHarness> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-session-harness-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const turns: RecordedTurn[] = [];
  const errors: unknown[] = [];
  const concurrency = options.workerConcurrency ?? 10;
  let active = 0;
  let coordinationUrl = "";

  const call = async (
    spec: TaskAttemptSpec,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    const coordination = spec.coordination;
    if (!coordination) throw new Error(`Task ${spec.taskId} has no coordination endpoint`);
    const response = await fetch(`${coordination.controlPlaneUrl}/internal/v1/coordination/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${coordination.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
      error?: { message?: string };
    };
    const text = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: body.result?.isError === true || body.error !== undefined, text, json };
  };

  const listTools = async (spec: TaskAttemptSpec): Promise<readonly string[]> => {
    if (!spec.coordination) return [];
    const response = await fetch(
      `${spec.coordination.controlPlaneUrl}/internal/v1/coordination/mcp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${spec.coordination.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
    );
    const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
    return (body.result?.tools ?? []).map((tool) => tool.name);
  };

  const describe = async (spec: TaskAttemptSpec) => {
    const task = await store.findTaskById(spec.taskId);
    const session = task ? await store.findSessionById(task.sessionId) : undefined;
    const tag = task ? await store.findTagById(task.tagId) : undefined;
    const internal = task?.inboundEventId
      ? (await store.findInboundEventById(task.inboundEventId))?.event.internal
      : undefined;
    const sessionKey = session?.sessionKey ?? "";
    const kind: TurnKind = sessionKey.startsWith("objective:")
      ? "objective"
      : sessionKey.startsWith("inbox:")
        ? "inbox"
        : internal?.kind === "work_session"
          ? "work_session"
          : internal?.kind === "session_report"
            ? "report"
            : "conversation";
    return {
      taskId: spec.taskId,
      sessionId: task?.sessionId ?? "",
      sessionKey,
      tagId: task?.tagId ?? "",
      tagName: tag?.name ?? "",
      kind,
      ...(session?.objectiveId == null ? {} : { objectiveId: session.objectiveId }),
      ...(internal === undefined ? {} : { internal }),
    };
  };

  const worklet: Worklet = {
    id: "session-worklet",
    describe: async () => ({
      id: "session-worklet",
      protocolVersion: 1,
      host: {
        id: HOST_ID,
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [SURFACE_COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
            id: "session-worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            capabilities: [SURFACE_COORDINATION_CAPABILITY],
            contextTypes: [],
            maxConcurrency: concurrency,
          },
        ],
      },
    }),
    async selectPlacement(_requirements, _contextPlan, placement) {
      if (active >= concurrency + (placement?.coordinationSlot ? 1 : 0)) return undefined;
      return {
        workerHostId: HOST_ID,
        workletId: "session-worklet",
        workerId: "session-worker",
        workerProfile: { id: "default", revision: "1" },
      };
    },
    controlCapabilities: async () => ({ version: 1, operations: ["input"], inputMode: "queue" }),
    control: async (command) => ({
      id: command.id,
      taskId: command.taskId,
      attemptId: command.attemptId,
      status: "accepted",
    }),
    async *execute(spec): AsyncIterable<TaskAttemptEvent> {
      active += 1;
      try {
        yield* run(spec);
      } finally {
        active -= 1;
      }
    },
  };

  async function* run(spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> {
    const at = new Date().toISOString();
    const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
    yield { ...identity, type: "execution.started", workerId: "session-worker" };
    const calls: {
      name: string;
      arguments: Record<string, unknown>;
      result: ToolCallResult;
    }[] = [];
    const turn: ScriptedTurn = {
      spec,
      ...(await describe(spec)),
      system: spec.input.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n"),
      request: spec.input.messages.findLast((message) => message.role === "requester")?.text ?? "",
      tools: await listTools(spec),
      call: async (name, args = {}) => {
        const result = await call(spec, name, args);
        calls.push({ name, arguments: args, result });
        return result;
      },
    };
    let answer: ScriptedAnswer;
    try {
      const given = await options.respond(turn);
      answer = typeof given === "string" ? { reply: given } : (given ?? {});
    } catch (error) {
      turns.push({ ...turn, calls });
      yield {
        ...identity,
        type: "execution.failed",
        error: {
          name: "ExecutionBudgetExceededError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      return;
    }
    const reply = answer.reply || "Done.";
    turns.push({ ...turn, calls, reply });
    if (answer.reportedCostMinor !== undefined)
      yield {
        ...identity,
        type: "usage.updated",
        usage: {
          inputTokens: answer.reportedCostMinor,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: answer.reportedCostMinor,
          complete: true,
          reportedCost: {
            amountMinor: answer.reportedCostMinor,
            currency: answer.currency ?? "USD",
          },
        },
      };
    yield { ...identity, type: "output.message", message: { role: "teammate", text: reply } };
    yield {
      ...identity,
      type: "result",
      result: {
        summary: reply,
        decisions: [],
        changes: [],
        unresolved: [],
        findings: [],
        references: [],
        artifacts: [],
      },
    };
    yield { ...identity, type: "execution.completed" };
  }

  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet,
    reply: async () => {},
    dispatch: {
      pollIntervalMs: 10,
      leaseDurationMs: 30_000,
      retryBaseMs: 10,
      maxAttempts: options.maxAttempts ?? 1,
      onDispatchError: (error: unknown) => errors.push(error),
    },
  });
  const server = createServer((request, response) => {
    void handleCoordinationRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://127.0.0.1"),
      controlPlane.objectives,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No coordination address");
  coordinationUrl = `http://127.0.0.1:${address.port}`;
  controlPlane.objectives.activateCoordination({ url: coordinationUrl });
  await controlPlane.start();

  return {
    store,
    controlPlane,
    workerHostId: HOST_ID,
    turns,
    errors,
    async tag(name) {
      const tag = await store.createTag({ name });
      await store.bindTagWorkerHost(tag.id, HOST_ID);
      return tag;
    },
    turnsOf: (sessionId) => turns.filter((turn) => turn.sessionId === sessionId),
    async close() {
      await controlPlane.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
