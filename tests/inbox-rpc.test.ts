import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Code } from "@connectrpc/connect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inboxService } from "../apps/cli/src/inbox-rpc.ts";
import { inboxClient } from "../apps/cli/src/operator-client.ts";
import { createOperatorRpcHandler } from "../apps/cli/src/operator-rpc.ts";
import type { OperatorAuthentication } from "../apps/cli/src/operator-rpc-context.ts";
import { objectiveMessageDeliveryId } from "../packages/core/src/index.ts";
import {
  ApprovalStatus,
  InboxService,
  ObjectiveStatus,
} from "../packages/operator-api/src/index.ts";

const ADMIN = "inbox-rpc-admin";
const OBJECTIVE = "repair";
const SESSION = "session-owner";

/** The Objective's own Session: its Tasks, oldest first, and their inbound events. */
interface Turn {
  readonly id: string;
  readonly status: string;
  readonly question?: string;
  readonly deliveryId?: string;
}

describe("InboxService", () => {
  let url = "";
  let server: Server | undefined;
  let turns: Turn[] = [];
  let objectiveStatus = "working";
  const sent: Record<string, unknown>[] = [];
  const listed: Record<string, unknown>[] = [];

  const task = (turn: Turn) => ({
    id: turn.id,
    objectiveId: OBJECTIVE,
    sessionId: SESSION,
    status: turn.status,
    outcome: turn.question === undefined ? {} : { question: turn.question },
    inboundEventId: turn.deliveryId === undefined ? null : `inbound-${turn.id}`,
  });
  const store = {
    findTaskById: async (id: string) => {
      const turn = turns.find((candidate) => candidate.id === id);
      return turn === undefined ? undefined : task(turn);
    },
    getObjective: async (id: string) => {
      if (id !== OBJECTIVE) throw new Error("missing");
      return { id, status: objectiveStatus, ownerTagId: "owner-id" };
    },
    findTagById: async () => ({ id: "owner-id", name: "planner" }),
    findSessionById: async () => ({ id: SESSION, sessionKey: `objective:${OBJECTIVE}` }),
    listSessionTaskIds: async () => turns.map((turn) => turn.id),
    findInboundEventById: async (id: string) => {
      const turn = turns.find((candidate) => `inbound-${candidate.id}` === id);
      return turn?.deliveryId === undefined ? undefined : { event: { eventId: turn.deliveryId } };
    },
  };
  const request = (id: string, createdAt: string) => ({
    id,
    objectiveId: OBJECTIVE,
    taskId: "turn-1",
    attemptId: null,
    requestingTagId: "owner-id",
    kind: "surface-action" as const,
    actions: [],
    argumentsDigest: null,
    summary: "Deploy",
    ruleSources: [],
    approvers: [],
    status: "pending" as const,
    scope: null,
    validUntil: null,
    decidedBy: null,
    decidedByKind: null,
    decidedAt: null,
    reason: null,
    consumedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  const objectives = {
    messageObjective: async (input: Record<string, unknown>) => {
      sent.push(input);
      turns.push({
        id: `turn-${turns.length + 1}`,
        status: "pending",
        deliveryId: objectiveMessageDeliveryId(OBJECTIVE, String(input["idempotencyKey"])),
      });
      return { taskId: turns.at(-1)?.id, duplicate: false, statusChange: "blocked" };
    },
    listApprovalRequests: async (input: Record<string, unknown>) => {
      listed.push(input);
      return input["before"] === undefined
        ? {
            requests: [request("second", "2026-11-08T00:00:02.000Z")],
            next: { createdAt: "2026-11-08T00:00:02.000Z", id: "second" },
          }
        : { requests: [request("first", "2026-11-08T00:00:01.000Z")] };
    },
  };

  beforeAll(async () => {
    const principals: Record<string, OperatorAuthentication> = {
      [`Bearer ${ADMIN}`]: {
        kind: "break-glass",
        principal: { operatorId: "control-plane-break-glass", scopes: { actions: ["*"] } },
      },
      "Bearer elsewhere": {
        kind: "coordination",
        principal: {
          operatorId: "elsewhere",
          scopes: { actions: ["message_objective"], objectiveIds: ["other"] },
        },
      },
    };
    const handler = createOperatorRpcHandler(
      {
        auditTrail: { record: async () => {} },
        authenticate: async (authorization) =>
          authorization === undefined ? undefined : principals[authorization],
        accepting: () => true,
      },
      (router) =>
        router.service(
          InboxService,
          inboxService({
            store: store as never,
            queries: { listApprovalRequests: objectives.listApprovalRequests } as never,
            control: {
              accepting: async () => true,
              messageObjective: objectives.messageObjective,
            } as never,
          }),
        ),
    );
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  beforeEach(() => {
    turns = [{ id: "turn-1", status: "completed", question: "Raise the budget to 2000?" }];
    objectiveStatus = "working";
    sent.length = 0;
    listed.length = 0;
  });

  const inbox = (token = ADMIN) => inboxClient({ url, token });

  it("answers a waiting question as the owner's next turn, once per idempotency key", async () => {
    const answer = { key: "question:turn-1", text: "  Yes, to 2000.  ", idempotencyKey: "a-1" };
    expect(await inbox().answerQuestion(answer)).toMatchObject({
      taskId: "turn-2",
      tag: "planner",
      duplicate: false,
      statusChange: ObjectiveStatus.BLOCKED,
    });
    expect(sent).toEqual([
      { objectiveId: OBJECTIVE, text: "Yes, to 2000.", idempotencyKey: "a-1" },
    ]);
    // The answer took the owner's next turn, so the question no longer waits; a retry with the
    // same key returns that turn and sends nothing.
    expect(await inbox().answerQuestion(answer)).toMatchObject({
      taskId: "turn-2",
      duplicate: true,
    });
    await expect(
      inbox().answerQuestion({ ...answer, idempotencyKey: "a-2" }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(sent).toHaveLength(1);
  });

  it("gives a keyless answer its own idempotency key, so the control call is safe to retry", async () => {
    await inbox().answerQuestion({ key: "question:turn-1", text: "Yes" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.["idempotencyKey"]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses a key that names no question, empty text, and a closed Objective", async () => {
    for (const key of ["approval:request-1", "question:missing", "turn-1"])
      await expect(inbox().answerQuestion({ key, text: "Yes" })).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
    await expect(
      inbox().answerQuestion({ key: "question:turn-1", text: "   " }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    objectiveStatus = "completed";
    await expect(
      inbox().answerQuestion({ key: "question:turn-1", text: "Yes" }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    // A scoped coordination credential reaches only its own Objectives.
    objectiveStatus = "working";
    await expect(
      inbox("elsewhere").answerQuestion({ key: "question:turn-1", text: "Yes" }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(sent).toEqual([]);
  });

  it("pages approval requests with an opaque token", async () => {
    const first = await inbox().listApprovals({ status: ApprovalStatus.PENDING, pageSize: 1 });
    expect(first.approvals.map((approval) => approval.id)).toEqual(["second"]);
    expect(first.nextPageToken).not.toBe("");
    const second = await inbox().listApprovals({ pageToken: first.nextPageToken });
    expect(second.approvals.map((approval) => approval.id)).toEqual(["first"]);
    expect(second.nextPageToken).toBe("");
    expect(listed).toEqual([
      { status: "pending", limit: 1 },
      {
        status: "all",
        before: { createdAt: "2026-11-08T00:00:02.000Z", id: "second" },
        limit: 100,
      },
    ]);
    await expect(inbox().listApprovals({ pageToken: "not-a-token" })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(inbox().listApprovals({ pageSize: -1 })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
  });
});
