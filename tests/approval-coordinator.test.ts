import { describe, expect, it } from "vitest";
import { ApprovalCoordinator } from "../packages/control-plane/src/approvals.ts";
import type { ApprovalRequest } from "../packages/core/src/index.ts";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "request-1",
    objectiveId: "objective-a",
    taskId: "task-finished",
    attemptId: null,
    requestingTagId: "tag-a",
    kind: "surface-action",
    actions: [],
    argumentsDigest: null,
    summary: "Merge pull request 42",
    ruleSources: [],
    approvers: [],
    status: "pending",
    scope: null,
    validUntil: null,
    decidedBy: null,
    decidedByKind: null,
    decidedAt: null,
    reason: null,
    consumedAt: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(initial: readonly ApprovalRequest[]) {
  const requests = new Map(initial.map((value) => [value.id, value]));
  const writes: string[] = [];
  const store = {
    async listApprovalRequests(filter: { readonly status?: string }) {
      return [...requests.values()].filter(
        (value) => filter.status === undefined || value.status === filter.status,
      );
    },
    async getApprovalRequest(id: string) {
      return requests.get(id);
    },
    async findTaskById(id: string) {
      return { id, status: id === "task-finished" ? "failed" : "running" };
    },
    async expireApprovalRequest(id: string) {
      writes.push(`expire ${id}`);
      const current = requests.get(id);
      if (current?.status !== "pending") return undefined;
      const expired = { ...current, status: "expired" as const };
      requests.set(id, expired);
      return expired;
    },
    async decideApprovalRequest(input: { readonly id: string }) {
      writes.push(`decide ${input.id}`);
      throw new Error("decided again");
    },
    async appendTaskEvent() {
      writes.push("event");
    },
  };
  return {
    approvals: new ApprovalCoordinator(store as never),
    writes,
    stored: (id: string) => requests.get(id),
  };
}

describe("ApprovalCoordinator", () => {
  it("lists a request whose Task finished as expired without writing, and the sweep expires it", async () => {
    const f = fixture([request(), request({ id: "request-2", taskId: "task-running" })]);
    const page = await f.approvals.list({});
    expect(page.requests.map((value) => [value.id, value.status])).toEqual([
      ["request-1", "expired"],
      ["request-2", "pending"],
    ]);
    expect(
      (await f.approvals.list({ status: "pending" })).requests.map((value) => value.id),
    ).toEqual(["request-2"]);
    expect(f.writes).toEqual([]);
    expect(f.stored("request-1")?.status).toBe("pending");
    await f.approvals.expireFinished();
    expect(f.writes).toEqual(["expire request-1"]);
    expect(f.stored("request-1")?.status).toBe("expired");
  });

  it("returns a decision the same operator already made instead of refusing the repeat", async () => {
    const approved = request({
      taskId: "task-running",
      status: "approved",
      scope: "once",
      decidedBy: "admin",
      decidedByKind: "operator",
      decidedAt: "2026-11-07T00:01:00.000Z",
    });
    const f = fixture([approved]);
    await expect(
      f.approvals.decideAsOperator({ requestId: approved.id, decision: "approve" }, "admin"),
    ).resolves.toEqual(approved);
    expect(f.writes).toEqual([]);
    await expect(
      f.approvals.decideAsOperator(
        { requestId: approved.id, decision: "approve", scope: "objective" },
        "admin",
      ),
    ).rejects.toThrow("decided again");
    await expect(
      f.approvals.decideAsOperator({ requestId: approved.id, decision: "approve" }, "token:ci"),
    ).rejects.toThrow("decided again");
  });
});
