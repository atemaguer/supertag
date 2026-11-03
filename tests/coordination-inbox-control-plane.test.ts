import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinationInboxPage } from "@supertag/core";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

it("serves the redacted operator inbox through the authenticated Control Plane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-inbox-control-plane-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  try {
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const owner = await store.createTag({ name: "Inbox owner" });
    await store.bindTagWorkerHost(owner.id, "control-plane-static-host");
    await store.createObjective({
      id: "inbox-objective",
      ownerTagId: owner.id,
      outcome: "Review pending coordination",
    });
    await store.createTeam({
      id: "inbox-team",
      objectiveId: "inbox-objective",
      name: "Inbox Team",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: "inbox-admin",
      coordinationOperatorCredentials: [
        {
          token: "inbox-reader-token",
          operatorId: "inbox-reader",
          actions: ["read_coordination_inbox"],
          objectiveIds: ["inbox-objective"],
        },
      ],
    });
    const headers = {
      authorization: "Bearer inbox-admin",
      "content-type": "application/json",
    };
    const requested = await fetch(`${runtime.url}/api/v1/coordination/assign_task`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        objectiveId: "inbox-objective",
        taskId: "approval-task",
        teamId: "inbox-team",
        assignedTagId: owner.id,
        instruction: "Sensitive instruction must remain out of the inbox",
        acceptanceCriteria: ["Approved"],
        requiresApproval: true,
      }),
    });
    expect(requested.status, await requested.text()).toBe(200);

    const response = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&kind=task_approval&status=pending&limit=10`,
      { headers },
    );
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const page = JSON.parse(responseText) as CoordinationInboxPage;
    expect(page.projectionVersion).toBe(7);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: "task_approval:approval-task",
      objectiveId: "inbox-objective",
      teamId: "inbox-team",
      operatorEligible: true,
      permittedActions: [
        {
          tool: "update_task",
          arguments: {
            taskId: "approval-task",
            expectedStatus: "queued",
            approval: "approved",
          },
        },
      ],
      redaction: { level: "metadata_only" },
    });
    expect(JSON.stringify(page)).not.toContain("Sensitive instruction");
    // The held Task names its approval request and the command that decides it.
    const requestId = page.items[0]?.approval?.requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(page.items[0]?.commands?.[0]).toBe(`supertag approve request ${requestId}`);

    // An operator without list_approvals sees the Task but not the approval request.
    const reader = { authorization: "Bearer inbox-reader-token" };
    const scoped = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&kind=task_approval`,
      { headers: reader },
    );
    const scopedPage = (await scoped.json()) as CoordinationInboxPage;
    expect(scopedPage.items).toHaveLength(1);
    expect(scopedPage.items[0]?.approval).toBeUndefined();
    const forbidden = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&kind=approval`,
      { headers: reader },
    );
    expect(forbidden.status).toBe(403);

    const unknownQuery = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objective=inbox-objective`,
      { headers },
    );
    expect(unknownQuery.status).toBe(400);
    await expect(unknownQuery.json()).resolves.toMatchObject({
      error: "Unknown coordination inbox query parameter: objective",
    });

    const duplicateQuery = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&objectiveId=other`,
      { headers },
    );
    expect(duplicateQuery.status).toBe(400);

    const unauthorized = await fetch(`${runtime.url}/api/v1/coordination/inbox`);
    expect(unauthorized.status).toBe(401);
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
