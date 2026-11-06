import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { surfaceTools } from "../apps/cli/src/coordination-http.ts";
import { main } from "../apps/cli/src/index.ts";
import {
  runTagConversationCommand,
  type TagMessageRecord,
} from "../apps/cli/src/tag-conversation.ts";
import { SessionContinuity } from "../packages/control-plane/src/session-continuity.ts";
import { tagPortfolio } from "../packages/control-plane/src/tag-sessions.ts";
import { workSessionEvent } from "../packages/control-plane/src/work-sessions.ts";
import { sessionRequesterKey } from "../packages/core/src/index.ts";
import {
  SURFACE_COORDINATION_CAPABILITY,
  type TaskAttemptEvent,
  type TaskAttemptSpec,
  type Worklet,
} from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const ADMIN = "test-administrative-token";

it("advertises start_session with bounded title and instruction", () => {
  const tool = surfaceTools.find((candidate) => candidate.name === "start_session");
  expect(tool?.inputSchema).toEqual({
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120 },
      instruction: { type: "string", minLength: 1, maxLength: 8000 },
    },
    required: ["title", "instruction"],
    additionalProperties: false,
  });
});

/** What one Task Attempt saw, and how the scripted Worker answered it. */
interface Seen {
  readonly spec: TaskAttemptSpec;
  readonly tools: readonly string[];
  readonly kind: "conversation" | "work" | "report";
  readonly calls: readonly { readonly name: string; readonly result: Record<string, unknown> }[];
}

async function mcp(spec: TaskAttemptSpec, method: string, params: Record<string, unknown>) {
  const coordination = spec.coordination;
  if (!coordination) throw new Error("Task has no coordination");
  const response = await fetch(`${coordination.controlPlaneUrl}/internal/v1/coordination/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coordination.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
}

/**
 * A Worker that acts like a Tag: a conversation turn whose message starts with "work:" starts a
 * work Session per "|"-separated title; a work Session answers its instruction, failing on FAIL
 * and waiting on BLOCK until released; a report turn writes the result in its own words.
 */
function scriptedWorklet() {
  const seen: Seen[] = [];
  let release!: () => void;
  let blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  let maxRunningWork = 0;
  const worklet: Worklet = {
    id: "work-worklet",
    describe: async () => ({
      id: "work-worklet",
      protocolVersion: 1,
      host: {
        id: "work-host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [SURFACE_COORDINATION_CAPABILITY],
                contextTypes: [],
              },
            ],
            id: "work-worker",
            type: "deterministic",
            profiles: [{ id: "default", revision: "1" }],
            capabilities: [SURFACE_COORDINATION_CAPABILITY],
            contextTypes: [],
            maxConcurrency: 10,
          },
        ],
      },
    }),
    async *execute(spec): AsyncIterable<TaskAttemptEvent> {
      const at = new Date().toISOString();
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
      yield { ...identity, type: "execution.started", workerId: "work-worker" };
      const system = spec.input.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n");
      const request = spec.input.messages.findLast((message) => message.role === "requester");
      const kind = system.includes("This is work Session")
        ? "work"
        : system.includes("Report its result")
          ? "report"
          : "conversation";
      const listed = spec.coordination ? await mcp(spec, "tools/list", {}) : {};
      const tools = ((listed.result?.["tools"] as { name: string }[] | undefined) ?? []).map(
        (tool) => tool.name,
      );
      const calls: { name: string; result: Record<string, unknown> }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await mcp(spec, "tools/call", { name, arguments: args })).result ?? {};
        calls.push({ name, result });
      };
      let text = "";
      if (kind === "conversation") {
        const message = request?.text ?? "";
        if (message.startsWith("work:")) {
          for (const title of message.slice(5).split("|"))
            await call("start_session", { title, instruction: `Investigate ${title}` });
          text = "On it.";
        } else text = `Answered: ${message}`;
      } else if (kind === "work") {
        // A work Session may not start more work, even when it asks.
        await call("start_session", { title: "nested", instruction: "Go deeper" });
        running += 1;
        maxRunningWork = Math.max(maxRunningWork, running);
        try {
          if (request?.text.includes("BLOCK")) await blocked;
        } finally {
          running -= 1;
        }
        if (request?.text.includes("FAIL")) {
          seen.push({ spec, tools, kind, calls });
          yield {
            ...identity,
            type: "execution.failed",
            // Not retried, so the work Session fails at once.
            error: { name: "ExecutionBudgetExceededError", message: "The probe crashed" },
          };
          return;
        }
        text = `Found the answer to ${request?.text}.`;
      } else {
        const title = /Work Session "([^"]+)"/u.exec(system)?.[1];
        const result = /<work-session-result>\n([\s\S]*)\n<\/work-session-result>/u.exec(
          system,
        )?.[1];
        text = `Report on ${title}: ${result}`;
      }
      seen.push({ spec, tools, kind, calls });
      yield { ...identity, type: "output.message", message: { role: "teammate", text } };
      yield {
        ...identity,
        type: "result",
        result: {
          summary: text,
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: [],
        },
      };
      yield { ...identity, type: "execution.completed" };
    },
  };
  return {
    worklet,
    seen,
    release: () => {
      release();
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    maxRunningWork: () => maxRunningWork,
  };
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `work Sessions (${dialect})`,
    { timeout: 60_000 },
    () => {
      let directory: string;
      let databaseUrl: string;
      let cleanup: (() => Promise<void>) | undefined;
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
      let store: DrizzleStore;
      let script: ReturnType<typeof scriptedWorklet>;
      let output: string[];

      const start = async () => {
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port: 0,
          databaseUrl,
          adminToken: ADMIN,
          worklet: script.worklet,
        });
        vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
        vi.stubEnv("SUPERTAG_ADMIN_TOKEN", ADMIN);
        return runtime;
      };
      const send = async (text: string, token = ADMIN, session = "plan") => {
        if (!runtime) throw new Error("not started");
        return JSON.parse(
          await runTagConversationCommand(
            { url: runtime.url, token },
            ["planner", text, "--session", session, "--output", "json"],
            { intervalMs: 20, timeoutMs: 30_000 },
          ),
        ) as TagMessageRecord;
      };
      const client = (token = ADMIN) => {
        if (!runtime) throw new Error("not started");
        return new ControlPlaneClient({ url: runtime.url, token });
      };

      beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "supertag-work-sessions-"));
        databaseUrl = `file:${join(directory, "supertag.db")}`;
        cleanup = undefined;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          databaseUrl = isolated.url;
          cleanup = isolated.cleanup;
        }
        await migrateDatabase({ url: databaseUrl });
        script = scriptedWorklet();
        store = new DrizzleStore({ url: databaseUrl });
        await store.connect();
        const tag = await store.createTag({ name: "planner" });
        await store.bindTagWorkerHost(tag.id, "work-host");
        await start();
        output = [];
      });

      afterEach(async () => {
        script.release();
        await runtime?.close();
        runtime = undefined;
        await store.disconnect();
        await cleanup?.();
        await rm(directory, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      });

      it("starts a work Session with the conversation's authority and reports its result there", async () => {
        const record = await send("work:billing probe");
        expect(record).toMatchObject({
          status: "replied",
          reply: { text: "On it." },
          startedSessions: [
            {
              title: "billing probe",
              status: "completed",
              reportStatus: "replied",
              report: {
                presentation: "final-result",
                text: "Report on billing probe: Found the answer to Investigate billing probe.",
              },
            },
          ],
        });
        const started = record.startedSessions?.[0];
        if (!started?.taskId || !started.reportTaskId) throw new Error("missing work Session");
        const conversationTurn = script.seen.find((entry) => entry.kind === "conversation");
        expect(conversationTurn?.tools).toContain("start_session");
        expect(conversationTurn?.calls[0]?.result["isError"]).toBeUndefined();
        const returned = JSON.parse(
          (conversationTurn?.calls[0]?.result["content"] as { text: string }[] | undefined)?.[0]
            ?.text ?? "{}",
        );
        expect(returned).toEqual({
          sessionId: started.id,
          title: "billing probe",
          status: "started",
        });
        // The portfolio tells a conversation turn when to start a work Session.
        expect(
          conversationTurn?.spec.input.messages.find((message) => message.role === "system")?.text,
        ).toContain("call start_session {title, instruction}");

        // The work Session: same Tag, parent recorded, audience inherited, its own Task.
        const conversation = await store.findSessionById(record.sessionId);
        const work = await store.findSessionById(started.id);
        expect(work).toMatchObject({
          tagId: conversation?.tagId,
          parentSessionId: record.sessionId,
          audience: "private",
          audienceActorKey: conversation?.audienceActorKey,
          origin: { title: "billing probe", startedByTaskId: record.taskId },
        });
        expect(work?.sessionKey).toMatch(new RegExp(`^work:${record.sessionId}:`, "u"));
        const workTask = await store.findTaskById(started.taskId);
        const startingTask = await store.findTaskById(record.taskId);
        expect(workTask).toMatchObject({
          sessionId: started.id,
          requestText: "Investigate billing probe",
          actor: startingTask?.actor,
          authorizationSnapshot: startingTask?.authorizationSnapshot,
          contextPlan: startingTask?.contextPlan,
          workspacePlan: startingTask?.workspacePlan,
          sessionHistory: [],
        });
        // A work Session has no start_session and no Objective changes, even when it asks.
        const workTurn = script.seen.find((entry) => entry.kind === "work");
        expect(workTurn?.tools).toEqual(
          expect.arrayContaining(["list_sessions", "read_session", "read_objective"]),
        );
        for (const absent of [
          "start_session",
          "create_objective",
          "attach_objective",
          "start_objective",
          "instruct_objective",
        ])
          expect(workTurn?.tools).not.toContain(absent);
        expect(JSON.stringify(workTurn?.calls)).not.toContain("sessionId");
        expect((await store.listWorkSessions(started.id)).length).toBe(0);
        // The instruction is the Tag's text, not a person's message.
        const workRequest = workTurn?.spec.input.messages.find(
          (message) => message.role === "requester",
        );
        expect(workRequest).toEqual({
          id: expect.any(String),
          role: "requester",
          text: "Investigate billing probe",
        });
        // Its reply is recorded, never posted.
        const workInbound = await store.findInboundEventById(workTask?.inboundEventId ?? "");
        await vi.waitFor(async () =>
          expect((await store.findOutboundReply(workInbound?.id ?? "", "final"))?.status).toBe(
            "delivered",
          ),
        );

        // The report turn: a conversation Task that resumes the conversation's harness session and
        // replies where the conversation's turn replied.
        const report = await store.findTaskById(started.reportTaskId);
        expect(report).toMatchObject({
          sessionId: record.sessionId,
          status: "completed",
          authorizationSnapshot: startingTask?.authorizationSnapshot,
        });
        expect(report?.requestText).toBeUndefined();
        const continuity = new SessionContinuity(store);
        expect(await continuity.compatibility(report as never)).toBe(
          await continuity.compatibility(startingTask as never),
        );
        const reportInbound = await store.findInboundEventById(report?.inboundEventId ?? "");
        const startingInbound = await store.findInboundEventById(
          startingTask?.inboundEventId ?? "",
        );
        expect(reportInbound).toMatchObject({
          surfaceAccountId: startingInbound?.surfaceAccountId,
          sessionKey: startingInbound?.sessionKey,
          authorization: startingInbound?.authorization,
          event: {
            callback: startingInbound?.event.callback,
            internal: {
              kind: "session_report",
              workSessionId: started.id,
              workTaskId: started.taskId,
              status: "completed",
            },
          },
        });
        expect(reportInbound?.event.text).toBeUndefined();
        const reportTurn = script.seen.find((entry) => entry.kind === "report");
        expect(reportTurn?.spec.session.id).toBe(record.sessionId);
        for (const absent of ["start_session", "create_objective", "attach_objective"])
          expect(reportTurn?.tools).not.toContain(absent);
        expect(
          reportTurn?.spec.input.messages.find((message) => message.role === "requester"),
        ).not.toHaveProperty("actor");
        // The next message in the conversation sees the report.
        const next = await send("anything new?");
        const nextTask = await store.findTaskById(next.taskId);
        expect(nextTask?.sessionHistory.map((entry) => entry.taskId)).toContain(report?.id);

        // list session shows the parent and the latest Task status.
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          output.push(String(chunk));
          return true;
        });
        if (!runtime) throw new Error("not started");
        await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
        output.length = 0;
        await expect(main(["list", "session"])).resolves.toBe(0);
        const table = output.join("");
        expect(table.split("\n")[0]).toMatch(/ID\s+TAG\s+PARENT\s+STATUS\s+LAST INTERACTION/u);
        const row = table.split("\n").find((line) => line.startsWith(started.id));
        expect(row).toContain(record.sessionId);
        expect(row).toContain("completed");
        const resource = await client().request<{
          spec: Record<string, unknown>;
          status: Record<string, unknown>;
        }>(`/api/v1/sessions/${started.id}`);
        expect(resource.spec["parentSessionId"]).toBe(record.sessionId);
        expect(resource.status["latestTaskStatus"]).toBe("completed");
      });

      it("prints the acknowledgement, then each work Session and its report", async () => {
        if (!runtime) throw new Error("not started");
        const printed = await runTagConversationCommand(
          { url: runtime.url, token: ADMIN },
          ["planner", "work:alpha|beta", "--session", "plan"],
          { intervalMs: 20, timeoutMs: 30_000 },
        );
        const lines = printed.split("\n");
        expect(lines[0]).toBe("On it.");
        expect(lines).toContain("· working: alpha");
        expect(lines).toContain("· working: beta");
        expect(printed).toContain(
          "· done: alpha\nReport on alpha: Found the answer to Investigate alpha.",
        );
        expect(printed).toContain(
          "· done: beta\nReport on beta: Found the answer to Investigate beta.",
        );
        expect(printed.indexOf("On it.")).toBeLessThan(printed.indexOf("· done:"));

        // A plain answer starts nothing and prints only the reply.
        const plain = await runTagConversationCommand(
          { url: runtime.url, token: ADMIN },
          ["planner", "quick question", "--session", "plan"],
          { intervalMs: 20, timeoutMs: 30_000 },
        );
        expect(plain).toBe("Answered: quick question\n");
      });

      it("runs at most four work Sessions per conversation and reports failure and cancellation once", async () => {
        if (!runtime) throw new Error("not started");
        const waiting = client().request<TagMessageRecord>("/api/v1/tags/planner/messages", {
          method: "POST",
          body: JSON.stringify({
            text: "work:BLOCK one|BLOCK two|BLOCK three|BLOCK four|FAIL five|BLOCK six",
            session: "plan",
          }),
        });
        const posted = await waiting;
        const read = () =>
          client().request<TagMessageRecord>(`/api/v1/tags/planner/messages/${posted.taskId}`);
        await vi.waitFor(async () => expect((await read()).startedSessions).toHaveLength(6), {
          timeout: 10_000,
        });
        await vi.waitFor(
          async () =>
            expect(
              (await read()).startedSessions?.filter((session) => session.status === "running"),
            ).toHaveLength(4),
          { timeout: 10_000 },
        );
        // The fifth and sixth wait while four run.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const queued = (await read()).startedSessions ?? [];
        expect(queued.map((session) => session.status)).toEqual([
          "running",
          "running",
          "running",
          "running",
          "pending",
          "pending",
        ]);
        // Cancelling the queued sixth reports it as cancelled.
        const sixth = queued[5];
        if (!sixth?.taskId) throw new Error("missing sixth work Session");
        await client().request(`/api/v1/tasks/${sixth.taskId}/cancel`, { method: "POST" });
        script.release();
        await vi.waitFor(
          async () =>
            expect(
              (await read()).startedSessions?.every(
                (session) => session.reportStatus === "replied",
              ),
            ).toBe(true),
          { timeout: 20_000 },
        );
        expect(script.maxRunningWork()).toBe(4);
        const done = (await read()).startedSessions ?? [];
        expect(done.map((session) => session.status)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
          "failed",
          "cancelled",
        ]);
        expect(done[4]?.report?.text).toContain("Report on FAIL five: ");
        expect(done[4]?.report?.text).toContain("The probe crashed");
        expect(done[5]?.report?.text).toBe("Report on BLOCK six: I stopped working on this.");
        const reports = script.seen.filter((entry) => entry.kind === "report");
        expect(reports).toHaveLength(6);
        expect(
          reports.map(
            (entry) =>
              entry.spec.input.messages.find((m) => m.id.endsWith(":session_report"))?.text,
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.stringContaining("has failed"),
            expect.stringContaining("has been cancelled"),
          ]),
        );

        // A restart does not report again.
        await runtime.close();
        await start();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(script.seen.filter((entry) => entry.kind === "report")).toHaveLength(6);
        expect(await store.listUnreportedWorkTasks(20)).toEqual([]);
      });

      it("reports a work Session that finished before a restart once, after the restart", async () => {
        const record = await send("hello");
        if (!runtime) throw new Error("not started");
        await runtime.close();
        runtime = undefined;
        // A crash between the work Task's outcome and its report: the report was never admitted.
        const startingTask = await store.findTaskById(record.taskId);
        const starting = await store.findInboundEventById(startingTask?.inboundEventId ?? "");
        if (!startingTask || !starting) throw new Error("missing conversation turn");
        const event = workSessionEvent(
          starting,
          startingTask.id,
          startingTask.sessionId,
          { title: "crashed probe", instruction: "Investigate the crash" },
          new Date().toISOString(),
        );
        const admitted = await store.admitInboundEvent({
          surfaceAccountId: starting.surfaceAccountId,
          tagRouteId: starting.tagRouteId,
          tagId: starting.tagId,
          authorization: starting.authorization,
          contextPlan: starting.contextPlan,
          event,
        });
        const at = new Date().toISOString();
        const session = await store.openSession({
          tagId: starting.tagId,
          sessionKey: event.sessionKey,
          origin: { provider: "cli", title: "crashed probe", startedByTaskId: startingTask.id },
          audienceActorKey: (await store.findSessionById(startingTask.sessionId))?.audienceActorKey,
          parentSessionId: startingTask.sessionId,
          at,
        });
        const workTask = await store.openTask({
          inboundEventId: admitted.work.id,
          tagId: starting.tagId,
          sessionId: session.id,
          execution: starting.execution,
          actor: starting.event.actor,
          trigger: { kind: "message" },
          requestText: "Investigate the crash",
          workspacePlan: startingTask.workspacePlan,
          sessionHistory: [],
          authorizationSnapshot: starting.authorization,
          contextPlan: starting.contextPlan,
          createdAt: at,
        });
        await store.cancelPendingSurfaceTask({ taskId: workTask.id, cancelledAt: at });
        expect(await store.listUnreportedWorkTasks(20)).toEqual([workTask.id]);

        await start();
        await vi.waitFor(
          async () => {
            const found = await store.findWorkSessionReport(workTask.id);
            expect(found?.taskId).toBeDefined();
            expect((await store.findTaskById(found?.taskId ?? ""))?.status).toBe("completed");
          },
          { timeout: 10_000 },
        );
        const report = await store.findWorkSessionReport(workTask.id);
        expect(await store.findOutboundReply(report?.inboundEventId ?? "", "final")).toMatchObject({
          text: "Report on crashed probe: I stopped working on this.",
        });
        // And not again after another restart.
        await runtime?.close();
        await start();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(script.seen.filter((entry) => entry.kind === "report")).toHaveLength(1);
      });

      it("keeps a private conversation's work Sessions private to its person", async () => {
        const issued = await client().request<{ secret: string }>("/api/v1/operator-tokens", {
          method: "POST",
          body: JSON.stringify({ kind: "OperatorToken", metadata: { name: "alice" } }),
        });
        const mine = await send("work:secret plan");
        const started = mine.startedSessions?.[0];
        if (!started?.taskId) throw new Error("missing work Session");
        const hers = await send("what is the admin working on?", issued.secret);
        const work = await store.findSessionById(started.id);
        expect(work?.audience).toBe("private");
        const herTask = await store.findTaskById(hers.taskId);
        const herInbound = await store.findInboundEventById(herTask?.inboundEventId ?? "");
        const alice = {
          tagId: herTask?.tagId ?? "",
          sessionId: hers.sessionId,
          requesterKey: sessionRequesterKey(
            "cli",
            herInbound?.surfaceAccountId ?? "",
            herTask?.actor.id ?? "",
          ),
        };
        expect(await store.findVisibleSession(alice, started.id)).toBeUndefined();
        expect(
          (await store.listVisibleSessions(alice, { limit: 20 })).map((s) => s.sessionId),
        ).not.toContain(started.id);
        const admin = { ...alice, requesterKey: work?.audienceActorKey ?? "" };
        expect(await store.findVisibleSession(admin, started.id)).toMatchObject({ id: started.id });
        // Only the conversation's operator reads the work Session's Task.
        await expect(
          client(issued.secret).request(`/api/v1/tags/planner/messages/${started.taskId}`),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          client().request(`/api/v1/tags/planner/messages/${started.taskId}`),
        ).resolves.toMatchObject({ taskId: started.taskId });
      });
    },
  );
}

describe("portfolio work Sessions", () => {
  it("lists running work Sessions and offers start_session only to conversation turns", async () => {
    const store = {
      listVisibleOpenObjectives: async () => ({ objectives: [], total: 0 }),
    };
    const viewer = { tagId: "t", sessionId: "s", requesterKey: "k" };
    const workSessions = [
      {
        sessionId: "w1",
        title: "running probe",
        createdAt: "",
        task: { id: "a", status: "running" as const },
      },
      {
        sessionId: "w2",
        title: "queued probe",
        createdAt: "",
        task: { id: "b", status: "pending" as const },
      },
      {
        sessionId: "w3",
        title: "finished probe",
        createdAt: "",
        task: { id: "c", status: "completed" as const },
      },
    ];
    const portfolio = await tagPortfolio(store, viewer, { workSessions, startSessions: true });
    expect(portfolio).toContain("- w1 [working] running probe");
    expect(portfolio).toContain("- w2 [waiting] queued probe");
    expect(portfolio).not.toContain("finished probe");
    expect(portfolio).toContain("start_session");
    expect(await tagPortfolio(store, viewer, { workSessions })).not.toContain("start_session");
    expect(await tagPortfolio(store, viewer)).not.toContain("Work Sessions");
  });
});
