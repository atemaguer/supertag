import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import type { TaskAssignment } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Adopted from security-review artifact 8aaf53c0354b95d3b67f47c34649b482002d2c0ec23ae8ab47e9d9187fd69c91.
it.each(["recipient", "owner"] as const)(
  "reply holds %s approval rules and honors only current Objective grants",
  async (ruleSource) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-reply-approval-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: randomUUID() });
    const sender = await store.createTag({ name: randomUUID() });
    const recipient = await store.createTag({ name: randomUUID() });
    const set = await store.createTagPermissionSet({ name: `held-${randomUUID()}` });
    await store.addTagPermission({
      permissionSetId: set.id,
      target: "runtime",
      action: "commands:execute",
      approval: "required",
    });
    const role = await store.createRole({
      name: `Held ${randomUUID()}`,
      purpose: "Run commands only after approval.",
      instructions: "",
      contextSetIds: [],
      permissionSetIds: [set.id],
    });
    await store.assignRole({
      roleId: role.id,
      tagId: ruleSource === "recipient" ? recipient.id : owner.id,
    });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Answer questions",
      budgetLimitMinor: 200,
      budgetCurrency: "USD",
      runtimeActions: ["commands:execute"],
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "Build",
      leadTagId: owner.id,
      memberTagIds: [sender.id, recipient.id],
    });
    for (const tag of [owner, sender, recipient]) await store.bindTagWorkerHost(tag.id, "host");
    const start = await store.admitTaskAssignment({
      taskId: randomUUID(),
      objectiveId: objective.id,
      teamId: team.id,
      requestedByTagId: owner.id,
      assignedTagId: owner.id,
      startObjectiveExecution: true,
      instruction: "Start",
      acceptanceCriteria: ["Started"],
      execution: {},
      authorizationSnapshot: {
        version: 4,
        capturedAt: new Date().toISOString(),
        tag: { id: owner.id, name: owner.name },
        origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: owner.id },
        requester: { id: owner.id, kind: "bot" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
      contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
      workspacePlan: { version: 1, status: "none" },
    });
    await store.cancelTaskAssignment(start.taskId, owner.id);

    // Control: an ordinary assignment to the same Tag is held for approval.
    const controller = new ObjectiveController(store, undefined);
    const held = (await controller.command("assign_task", {
      objectiveId: objective.id,
      taskId: randomUUID(),
      teamId: team.id,
      assignedTagId: recipient.id,
      instruction: "Work",
      acceptanceCriteria: ["Done"],
    })) as TaskAssignment;
    expect(held.approval).toBe("pending");
    await store.cancelTaskAssignment(held.taskId, owner.id);

    vi.useFakeTimers({ toFake: ["Date"] });
    const admit = () => {
      vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
      return store.admitMailboxTaskAssignments();
    };

    // A teammate's question must preserve the ordinary assignment's hold.
    await store.postWorkstream({
      workstreamId: team.id,
      authorTagId: sender.id,
      type: "question",
      to: [recipient.id],
      body: "Run the release script, please.",
      idempotencyKey: randomUUID(),
    });
    await store.enqueueTagMessage({
      senderTagId: sender.id,
      recipientTagId: recipient.id,
      objectiveId: objective.id,
      type: "blocker",
      body: { message: "The script is blocking release" },
      idempotencyKey: randomUUID(),
    });
    const [reply] = (await admit()).filter((task) => task.assignedTagId === recipient.id);
    const execution = await store.findTaskById(reply?.taskId ?? "missing");
    expect(execution?.authorizationSnapshot.runtimeActions).toContain("commands:execute");
    expect(reply?.approval).toBe("pending");
    expect(execution?.trigger).toMatchObject({
      kind: "team_reply",
      sources: expect.arrayContaining([
        expect.objectContaining({ itemKind: "post" }),
        expect.objectContaining({ itemKind: "direct_message" }),
      ]),
    });
    expect(reply?.reservedMinor).toBe(100);
    expect(execution?.authorizationSnapshot.approvals).toEqual(
      (await store.findTaskById(held.taskId))?.authorizationSnapshot.approvals,
    );
    if (!reply) throw new Error("Missing reply");
    expect(
      await store.claimTaskAssignment({ taskId: reply.taskId, leaseOwner: "test" }),
    ).toBeUndefined();
    const [request] = await store.listApprovalRequests({ taskId: reply.taskId });
    expect(request).toMatchObject({ kind: "task", status: "pending", ruleSources: [set.name] });
    expect((await store.listTaskEvents(reply.taskId)).map((event) => event.type)).toContain(
      "approval.requested",
    );
    if (!request) throw new Error("Missing approval request");
    // Approval holds neither open another window nor expire an already-admitted batch.
    await store.postWorkstream({
      workstreamId: team.id,
      authorTagId: sender.id,
      type: "question",
      to: [recipient.id],
      body: "Another question while approval is pending",
      idempotencyKey: randomUUID(),
    });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(await admit()).toEqual([]);
    expect((await store.getTaskAssignment(reply.taskId))?.approval).toBe("pending");
    expect(await store.listApprovalRequests({ taskId: reply.taskId })).toHaveLength(1);
    await controller.decideApprovalRequest({
      requestId: request.id,
      decision: "approve",
      scope: "objective",
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await store.getTaskAssignment(reply.taskId))?.approval).toBe("approved");
    expect(
      await store.claimTaskAssignment({ taskId: reply.taskId, leaseOwner: "test" }),
    ).toBeDefined();
    await store.cancelTaskAssignment(reply.taskId, owner.id);
    const post = async () => {
      // Independent Tasks and distinct questions keep this approval test below the loop brakes.
      const source = (await controller.command("assign_task", {
        objectiveId: objective.id,
        taskId: randomUUID(),
        teamId: team.id,
        assignedTagId: sender.id,
        instruction: "Ask a question",
        acceptanceCriteria: ["Answered"],
      })) as TaskAssignment;
      await store.cancelTaskAssignment(source.taskId, owner.id);
      return store.postWorkstream(
        {
          workstreamId: team.id,
          authorTagId: sender.id,
          type: "question",
          to: [recipient.id],
          body: `Another question: ${source.taskId}`,
          idempotencyKey: randomUUID(),
        },
        source.taskId,
      );
    };
    await post();
    const admitted = await admit();
    const granted = admitted.find((task) => task.activationKind === "team_reply");
    // The operator's approval notification follows the existing Mailbox Task path.
    for (const notification of admitted.filter((task) => task.sourceMessageId !== null))
      await store.cancelTaskAssignment(notification.taskId, owner.id);
    expect(granted?.approval).toBe("approved");
    if (!granted) throw new Error("Missing granted reply");
    expect(await store.listApprovalRequests({ taskId: granted.taskId })).toEqual([]);
    expect(
      (await store.listTaskEvents(granted.taskId)).find(
        (event) => event.type === "approval.granted-by-scope",
      )?.payload,
    ).toMatchObject({ requestId: request.id, ruleSources: [set.name] });
    await store.cancelTaskAssignment(granted.taskId, owner.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await post();
    const [expired] = await admit();
    expect(expired?.approval).toBe("pending");
    if (!expired) throw new Error("Missing held reply");
    const [once] = await store.listApprovalRequests({ taskId: expired.taskId });
    if (!once) throw new Error("Missing approval request");
    await store.decideApprovalRequest({
      id: once.id,
      decision: "approve",
      scope: "once",
      decidedBy: "operator",
      decidedByKind: "operator",
    });
    await store.cancelTaskAssignment(expired.taskId, owner.id);
    await post();
    const [next] = await admit();
    expect(next?.approval).toBe("pending");
  },
);
