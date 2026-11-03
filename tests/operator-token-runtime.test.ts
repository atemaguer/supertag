import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagementAuditEvent } from "../apps/cli/src/control-plane-api.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { runObjectiveCommand } from "../apps/cli/src/objectives.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import type { AdmitTaskAssignmentInput } from "../packages/core/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";

const ADMIN = "operator-token-admin";

interface IssuedToken {
  readonly secret: string;
  readonly metadata: { readonly name: string; readonly createdAt: string };
  readonly status: Record<string, unknown>;
}

describe("Operator Token API", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function runtime() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-operator-token-runtime-"));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const audit: ManagementAuditEvent[] = [];
    const started = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: ADMIN,
      coordinationOperatorCredentials: [],
      audit: (event) => audit.push(event),
      reply: async () => {},
    });
    cleanups.push(async () => {
      await started.close();
      await store.disconnect();
      await rm(directory, { recursive: true, force: true });
    });
    const call = (token: string, path: string, init: RequestInit = {}) =>
      fetch(`${started.url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    const create = (token: string, name: string) =>
      call(token, "/api/v1/operator-tokens", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "OperatorToken",
          metadata: { name },
          spec: {},
        }),
      });
    return { url: started.url, store, audit, call, create, directory };
  }

  it("issues a token once, lists it without the secret, and refuses it once revoked", async () => {
    const { url, call, create, store } = await runtime();
    expect((await fetch(`${url}/api/v1/operator-tokens`)).status).toBe(401);
    expect((await create(ADMIN, "Not Valid")).status).toBe(400);

    const created = await create(ADMIN, "laptop-2");
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const issued = (await created.json()) as IssuedToken;
    expect(issued.secret).toMatch(/^stop_[a-f0-9]{64}$/u);
    expect(issued.status).toMatchObject({ phase: "active", operatorId: "token:laptop-2" });
    expect(
      Date.parse(String(issued.status["expiresAt"])) - Date.parse(issued.metadata.createdAt),
    ).toBe(90 * 24 * 60 * 60_000);
    expect((await create(ADMIN, "laptop-2")).status).toBe(409);

    // The token works for ordinary management and records when it was last used.
    const status = await call(issued.secret, "/api/v1/status");
    expect(status.status).toBe(200);
    const listed = await call(ADMIN, "/api/v1/operator-tokens");
    const listText = await listed.text();
    expect(listText).not.toContain(issued.secret);
    expect(listText).not.toContain("secretDigest");
    const [item] = (JSON.parse(listText) as { items: IssuedToken[] }).items;
    expect(item?.metadata.name).toBe("laptop-2");
    expect(item?.status["lastUsedAt"]).toEqual(expect.any(String));
    expect(item).not.toHaveProperty("secret");
    expect(
      (await (await call(ADMIN, "/api/v1/operator-tokens/laptop-2")).json()) as IssuedToken,
    ).toMatchObject({ metadata: { name: "laptop-2" }, status: { phase: "active" } });

    // Only the hash is stored.
    const [row] = await store.listOperatorTokens();
    expect(JSON.stringify(row)).not.toContain(issued.secret);

    const revoked = await call(ADMIN, "/api/v1/operator-tokens/laptop-2/revoke", {
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as IssuedToken).status["phase"]).toBe("revoked");
    const refused = await call(issued.secret, "/api/v1/status");
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("was revoked");
    expect(
      (await call(ADMIN, "/api/v1/operator-tokens/missing/revoke", { method: "POST" })).status,
    ).toBe(404);
  });

  it("rejects malformed, unknown, and expired tokens without leaking which", async () => {
    const { call, create, store } = await runtime();
    const issued = (await (await create(ADMIN, "expiring")).json()) as IssuedToken;
    expect((await call("stop_not-a-token", "/api/v1/status")).status).toBe(401);
    // A well-formed secret with a valid lookup part but the wrong remainder is invalid.
    const forged = `${issued.secret.slice(0, 21)}${"0".repeat(48)}`;
    const forgedResponse = await call(forged, "/api/v1/status");
    expect(forgedResponse.status).toBe(401);
    expect(await forgedResponse.text()).not.toContain("expired");

    // Expire the token in place: authentication compares against the stored expiry.
    const token = await store.findOperatorTokenByName("expiring");
    expect(token).toBeDefined();
    const authenticated = await store.authenticateOperatorToken({
      lookupId: issued.secret.slice(5, 21),
      secretDigest: digest(issued.secret),
      authenticatedAt: new Date(Date.parse(String(token?.expiresAt)) + 1).toISOString(),
    });
    expect(authenticated.status).toBe("expired");
  });

  it("lets only the admin token manage Operator Tokens", async () => {
    const { call, create } = await runtime();
    const issued = (await (await create(ADMIN, "teammate")).json()) as IssuedToken;
    expect((await create(issued.secret, "another")).status).toBe(403);
    expect((await call(issued.secret, "/api/v1/operator-tokens")).status).toBe(403);
    expect(
      (await call(issued.secret, "/api/v1/operator-tokens/teammate/revoke", { method: "POST" }))
        .status,
    ).toBe(403);
    // Everything else the admin token reaches is open to it, including Auth Keys and applies.
    expect((await call(issued.secret, "/api/v1/auth-keys")).status).toBe(200);
    const tag = await call(issued.secret, "/api/v1/tags", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "builder" },
        spec: {},
      }),
    });
    expect(tag.status, await tag.text()).toBe(201);
  });

  it("attributes approvals, messages, cancellations, and applies to token:NAME", async () => {
    const { url, call, create, store, audit, directory } = await runtime();
    const issued = (await (await create(ADMIN, "laptop-2")).json()) as IssuedToken;
    const owner = await store.createTag({ name: "owner" });
    const objective = await store.createObjective({
      id: "attributed",
      ownerTagId: owner.id,
      outcome: "Ship the export",
    });
    const team = await store.createTeam({
      id: "attributed-team",
      objectiveId: objective.id,
      name: "Export Team",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    await store.admitTaskAssignment(assignment(objective.id, team.id, owner));
    const request = await store.createApprovalRequest({
      objectiveId: objective.id,
      taskId: "attributed-task",
      requestingTagId: owner.id,
      kind: "plan",
      actions: [{ target: "runtime", action: "deploy" }],
      summary: "Deploy after merge",
      ruleSources: ["release"],
      approvers: [],
    });

    const approved = await call(
      issued.secret,
      `/api/v1/coordination/approvals/${request.id}/approve`,
      { method: "POST", body: "{}" },
    );
    expect(approved.status, await approved.text()).toBe(200);
    expect(await store.getApprovalRequest(request.id)).toMatchObject({
      status: "approved",
      decidedBy: "token:laptop-2",
      decidedByKind: "operator",
    });

    const target = { url, token: issued.secret };
    await runObjectiveCommand(target, ["message", objective.id, "Please include CSV"]);
    const messages = await store.listTagMessages(owner.id);
    expect(messages.map((message) => message.operatorId)).toContain("token:laptop-2");

    const cancelled = await call(issued.secret, `/api/v1/objectives/${objective.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Superseded" }),
    });
    expect(cancelled.status, await cancelled.text()).toBe(200);
    const changes = await store.listResourceChanges({
      resourceType: "objective",
      resourceId: objective.id,
    });
    expect(changes.at(-1)?.operatorId).toBe("token:laptop-2");

    const manifest = join(directory, "tag.yaml");
    await writeFile(
      manifest,
      "apiVersion: supertag/v1\nkind: Tag\nmetadata:\n  name: reviewer\nspec: {}\n",
    );
    await runResourceCommand(new ControlPlaneClient(target), "apply", ["-f", manifest]);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "supertag.audit",
        actor: "token:laptop-2",
        method: "POST",
        path: "/api/v1/tags",
        status: expect.any(Number),
      }),
    );
    // Reads are not audited, and the admin token is recorded as break-glass.
    expect(audit.some((event) => event.method === "GET")).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        actor: "control-plane-break-glass",
        path: "/api/v1/operator-tokens",
      }),
    );
  });
});

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function assignment(
  objectiveId: string,
  teamId: string,
  owner: { readonly id: string; readonly name: string },
): AdmitTaskAssignmentInput {
  return {
    taskId: "attributed-task",
    objectiveId,
    teamId,
    requestedByTagId: owner.id,
    assignedTagId: owner.id,
    instruction: "Export the report",
    acceptanceCriteria: ["done"],
    execution: {},
    authorizationSnapshot: {
      version: 4,
      capturedAt: new Date().toISOString(),
      tag: { id: owner.id, name: owner.name },
      origin: { kind: "internal", objectiveId, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "bot" },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    },
    contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
    workspacePlan: { version: 1, status: "none" },
  };
}
