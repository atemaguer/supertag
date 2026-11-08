import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinationInboxPage, SurfaceTagAuthorizationSnapshot } from "@supertag/core";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { objectiveSessionKey } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

it("serves the redacted operator inbox through the authenticated Control Plane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-inbox-control-plane-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  const store = new DrizzleStore({ url: databaseUrl });
  try {
    await migrateDatabase({ url: databaseUrl });
    await store.connect();
    const owner = await store.createTag({ name: "Inbox owner" });
    await store.bindTagWorkerHost(owner.id, "control-plane-static-host");
    const team = await store.createTeam({
      id: "inbox-team",
      name: "Inbox Team",
      memberTagIds: [owner.id],
      maxConcurrency: 1,
    });
    await store.createObjective({
      id: "inbox-objective",
      ownerTagId: owner.id,
      outcome: "Review pending coordination",
      teamId: team.id,
    });

    // The Objective's own Session turn, held on an approval it requested.
    const at = new Date().toISOString();
    const account = await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: "T0INBOX",
      displayName: "Slack",
      authMethod: "test",
      credentialId: "test",
      status: "connected",
      configuration: {},
      verifiedAt: at,
    });
    const route = await store.addTagRoute({
      tagId: owner.id,
      surfaceAccountId: account.id,
      scope: "channel:inbox",
    });
    const authorization: SurfaceTagAuthorizationSnapshot = {
      version: 5,
      capturedAt: at,
      tag: { id: owner.id, name: owner.name },
      origin: {
        provider: "slack",
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        scope: "channel:inbox",
      },
      requester: { id: "human", kind: "user" },
      roles: [],
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    };
    const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
    const sessionKey = objectiveSessionKey("inbox-objective");
    const event = {
      eventId: randomUUID(),
      logicalEventId: randomUUID(),
      provider: "slack",
      externalAccountId: account.externalAccountId,
      kind: "message",
      scope: "channel:inbox",
      sessionKey,
      actor: { id: "human", kind: "user" },
      text: "Start",
      occurredAt: at,
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: sessionKey,
        target: { channelId: "inbox", threadTs: sessionKey },
      },
      source: {},
      metadata: {},
    } as const;
    const admitted = await store.admitInboundEvent({
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      tagId: owner.id,
      authorization,
      contextPlan,
      event,
    });
    const session = await store.openSession({
      tagId: owner.id,
      sessionKey,
      origin: {},
      at,
      objectiveId: "inbox-objective",
    });
    const task = await store.openTask({
      inboundEventId: admitted.work.id,
      tagId: owner.id,
      sessionId: session.id,
      execution: {},
      actor: event.actor,
      trigger: {},
      workspacePlan: { version: 1, status: "none" },
      sessionHistory: [],
      authorizationSnapshot: authorization,
      contextPlan,
      createdAt: at,
    });
    const request = await store.createApprovalRequest({
      objectiveId: "inbox-objective",
      taskId: task.id,
      requestingTagId: owner.id,
      kind: "surface-action",
      actions: [{ target: "runtime", action: "files:write" }],
      summary: "Write the report",
      ruleSources: [],
      approvers: [],
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

    const response = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&kind=approval&status=pending&limit=10`,
      { headers },
    );
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const page = JSON.parse(responseText) as CoordinationInboxPage;
    expect(page.projectionVersion).toBe(8);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: `approval:${request.id}`,
      kind: "approval",
      objectiveId: "inbox-objective",
      operatorEligible: true,
      approval: {
        requestId: request.id,
        summary: "Write the report",
        requestingTagId: owner.id,
        taskId: task.id,
        blocking: true,
      },
      redaction: { level: "metadata_only" },
    });
    // The approval's own action arguments stay out of the projection.
    expect(JSON.stringify(page)).not.toContain("files:write");
    expect(page.items[0]?.commands?.[0]).toBe(`supertag approve request ${request.id}`);

    // An operator without list_approvals may not read approvals at all.
    const reader = { authorization: "Bearer inbox-reader-token" };
    const forbidden = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective&kind=approval`,
      { headers: reader },
    );
    expect(forbidden.status).toBe(403);
    const unscoped = await fetch(
      `${runtime.url}/api/v1/coordination/inbox?objectiveId=inbox-objective`,
      { headers: reader },
    );
    const unscopedPage = (await unscoped.json()) as CoordinationInboxPage;
    expect(unscopedPage.items.some((item) => item.kind === "approval")).toBe(false);

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
    await store.disconnect().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
