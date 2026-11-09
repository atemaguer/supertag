import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import type { SurfaceTagAuthorizationSnapshot } from "@supertag/core";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { inboxClient, objectiveClient } from "../apps/cli/src/operator-client.js";
import { objectiveSessionKey } from "../packages/core/src/index.js";
import { InboxItemKind } from "../packages/operator-api/src/index.js";
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
    const list = (body: unknown, token?: string) =>
      fetch(`${runtime?.url}/supertag.operator.v1.InboxService/ListInboxItems`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });

    // The inbox as `curl` reads it: a JSON POST.
    const response = await list(
      { objectiveId: "inbox-objective", kind: "INBOX_ITEM_KIND_APPROVAL", pageSize: 10 },
      "inbox-admin",
    );
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const page = JSON.parse(responseText) as {
      items: { commands?: string[]; occurrence?: string }[];
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: `approval:${request.id}`,
      occurrence: `approval:${request.id}`,
      kind: "INBOX_ITEM_KIND_APPROVAL",
      objectiveId: "inbox-objective",
      operatorEligible: true,
      approval: {
        requestId: request.id,
        kind: "APPROVAL_KIND_SURFACE_ACTION",
        summary: "Write the report",
        requestingTagId: owner.id,
        requestingTag: "Inbox owner",
        taskId: task.id,
        blocking: true,
      },
    });
    // The approval's own action arguments stay out of the projection.
    expect(responseText).not.toContain("files:write");
    expect(page.items[0]?.commands?.[0]).toBe(`supertag approve request ${request.id}`);

    // An operator without list_approvals may not read approvals at all.
    const reader = inboxClient({ url: runtime.url, token: "inbox-reader-token" });
    await expect(
      reader.listInboxItems({ objectiveId: "inbox-objective", kind: InboxItemKind.APPROVAL }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    const scoped = await reader.listInboxItems({});
    expect(scoped.items.some((item) => item.kind === InboxItemKind.APPROVAL)).toBe(false);
    // Its scope names one Objective, so it reaches no other.
    await expect(reader.listInboxItems({ objectiveId: "other" })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    // Nor any RPC that does not accept scoped coordination credentials.
    await expect(
      objectiveClient({ url: runtime.url, token: "inbox-reader-token" }).listObjectives({}),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });

    expect((await list({ pageToken: "not-a-cursor" }, "inbox-admin")).status).toBe(400);
    expect((await list({ pageSize: -1 }, "inbox-admin")).status).toBe(400);
    expect((await list({})).status).toBe(401);
  } finally {
    await runtime?.close();
    await store.disconnect().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
