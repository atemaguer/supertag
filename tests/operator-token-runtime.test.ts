import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagementAuditEvent } from "../apps/cli/src/control-plane-api.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { operatorTokenView } from "../apps/cli/src/host-protos.ts";
import {
  accessClient,
  hostClient,
  inboxClient,
  objectiveClient,
  organizationClient,
} from "../apps/cli/src/operator-client.ts";
import {
  getOperatorTokenResource,
  listOperatorTokenResources,
} from "../apps/cli/src/operator-resources.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { objectiveSessionKey } from "../packages/core/src/index.ts";
import {
  ControlPlanePhase,
  ErrorDetailSchema,
  ErrorReason,
} from "../packages/operator-api/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";

const ADMIN = "operator-token-admin";

/** The error GetStatus fails with for this token. */
async function refusal(url: string, token: string): Promise<ConnectError> {
  return organizationClient({ url, token })
    .getStatus({})
    .then(
      () => {
        throw new Error("GetStatus accepted the token");
      },
      (error: unknown) => ConnectError.from(error),
    );
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
    const access = (token: string) => accessClient({ url: started.url, token });
    const create = async (token: string, name: string) => {
      const created = await access(token).createOperatorToken({ name });
      return { secret: created.secret, ...operatorTokenView(created.operatorToken as never) };
    };
    return { url: started.url, store, audit, call, create, access, directory };
  }

  it("issues a token once, lists it without the secret, and refuses it once revoked", async () => {
    const { url, access, create, store } = await runtime();
    await expect(accessClient({ url }).listOperatorTokens({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(create(ADMIN, "Not Valid")).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });

    const issued = await create(ADMIN, "laptop-2");
    expect(issued.secret).toMatch(/^stop_[a-f0-9]{64}$/u);
    expect(issued.status).toMatchObject({ phase: "active", operatorId: "token:laptop-2" });
    expect(
      Date.parse(String(issued.status["expiresAt"])) - Date.parse(issued.metadata.createdAt),
    ).toBe(90 * 24 * 60 * 60_000);
    await expect(create(ADMIN, "laptop-2")).rejects.toMatchObject({ code: Code.AlreadyExists });

    // The token works for ordinary management and records when it was last used.
    await expect(
      organizationClient({ url, token: issued.secret }).getStatus({}),
    ).resolves.toMatchObject({ phase: ControlPlanePhase.ACCEPTING });
    const listed = await listOperatorTokenResources({ url, token: ADMIN });
    const listText = JSON.stringify(listed);
    expect(listText).not.toContain(issued.secret);
    expect(listText).not.toContain("secretDigest");
    const [item] = listed.items;
    expect(item?.metadata.name).toBe("laptop-2");
    expect(item?.status.lastUsedAt).toEqual(expect.any(String));
    expect(item).not.toHaveProperty("secret");
    await expect(
      getOperatorTokenResource({ url, token: ADMIN }, "laptop-2"),
    ).resolves.toMatchObject({ metadata: { name: "laptop-2" }, status: { phase: "active" } });

    // Only the hash is stored.
    const [row] = await store.listOperatorTokens();
    expect(JSON.stringify(row)).not.toContain(issued.secret);

    const revoked = operatorTokenView(
      await access(ADMIN).revokeOperatorToken({ name: "laptop-2" }),
    );
    expect(revoked.status.phase).toBe("revoked");
    // Revoking a revoked token returns it.
    expect(
      operatorTokenView(await access(ADMIN).revokeOperatorToken({ name: "laptop-2" })).status
        .revokedAt,
    ).toBe(revoked.status.revokedAt);
    const refused = await refusal(url, issued.secret);
    expect(refused.code).toBe(Code.Unauthenticated);
    expect(refused.rawMessage).toContain("was revoked");
    expect(refused.findDetails(ErrorDetailSchema)).toMatchObject([
      { reason: ErrorReason.CREDENTIAL_REVOKED },
    ]);
    await expect(access(ADMIN).revokeOperatorToken({ name: "missing" })).rejects.toMatchObject({
      code: Code.NotFound,
    });
  });

  it("rejects malformed, unknown, and expired tokens without leaking which", async () => {
    const { url, create, store } = await runtime();
    const issued = await create(ADMIN, "expiring");
    expect((await refusal(url, "stop_not-a-token")).code).toBe(Code.Unauthenticated);
    // A well-formed secret with a valid lookup part but the wrong remainder is invalid.
    const forged = await refusal(url, `${issued.secret.slice(0, 21)}${"0".repeat(48)}`);
    expect(forged.code).toBe(Code.Unauthenticated);
    expect(forged.rawMessage).not.toContain("expired");
    expect(forged.findDetails(ErrorDetailSchema)).toMatchObject([
      { reason: ErrorReason.UNAUTHENTICATED },
    ]);

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
    const { url, call, create, access } = await runtime();
    const issued = await create(ADMIN, "teammate");
    const denied = { code: Code.PermissionDenied };
    await expect(create(issued.secret, "another")).rejects.toMatchObject(denied);
    await expect(access(issued.secret).listOperatorTokens({})).rejects.toMatchObject(denied);
    await expect(
      access(issued.secret).getOperatorToken({ name: "teammate" }),
    ).rejects.toMatchObject(denied);
    await expect(
      access(issued.secret).revokeOperatorToken({ name: "teammate" }),
    ).rejects.toMatchObject(denied);
    // Everything else the admin token reaches is open to it, including Auth Keys and applies.
    await expect(hostClient({ url, token: issued.secret }).listAuthKeys({})).resolves.toMatchObject(
      { authKeys: [] },
    );
    const tag = await call(issued.secret, "/supertag.operator.v1.ResourceService/ApplyManifests", {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            manifest: {
              apiVersion: "supertag/v1",
              kind: "Tag",
              metadata: { name: "builder" },
              spec: {},
            },
          },
        ],
      }),
    });
    expect(tag.status, await tag.text()).toBe(200);
  });

  it("attributes approvals, messages, cancellations, and applies to token:NAME", async () => {
    const { url, create, store, audit, directory } = await runtime();
    const issued = await create(ADMIN, "laptop-2");
    const owner = await store.createTag({ name: "owner" });
    await store.bindTagWorkerHost(owner.id, "control-plane-static-host");
    const team = await store.createTeam({
      id: "attributed-team",
      name: "Export Team",
      memberTagIds: [owner.id],
      maxConcurrency: 1,
    });
    const objective = await store.createObjective({
      id: "attributed",
      ownerTagId: owner.id,
      outcome: "Ship the export",
      teamId: team.id,
    });
    const task = await ownerTask(store, objective.id, owner);
    const request = await store.createApprovalRequest({
      objectiveId: objective.id,
      taskId: task.id,
      requestingTagId: owner.id,
      kind: "surface-action",
      actions: [{ target: "runtime", action: "deploy" }],
      summary: "Deploy after merge",
      ruleSources: ["release"],
      approvers: [],
    });

    await inboxClient({ url, token: issued.secret }).approve({ id: request.id });
    expect(await store.getApprovalRequest(request.id)).toMatchObject({
      status: "approved",
      decidedBy: "token:laptop-2",
      decidedByKind: "operator",
    });

    const target = { url, token: issued.secret };
    const messaged = await objectiveClient(target).messageObjective({
      id: objective.id,
      text: "Please include CSV",
      idempotencyKey: "include-csv",
    });
    // The message is a turn of the Objective's own Session, made by the token's operator.
    const turn = await store.findTaskById(messaged.taskId);
    expect(turn?.actor).toMatchObject({ id: "token:laptop-2" });

    await objectiveClient({ url, token: issued.secret }).cancelObjective({
      id: objective.id,
      reason: "Superseded",
    });
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
        action: "resource.apply",
        target: "Tag/reviewer",
        method: "POST",
        path: "/supertag.operator.v1.ResourceService/ApplyManifests",
        status: 200,
      }),
    );
    // Reads are not audited, and the admin token is recorded as break-glass.
    expect(audit.some((event) => event.method === "GET")).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        actor: "control-plane-break-glass",
        action: "operator-token.create",
        target: "OperatorToken/laptop-2",
        path: "/supertag.operator.v1.AccessService/CreateOperatorToken",
      }),
    );
  });
});

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Opens a Task of the Objective's own Session, as its start turn does. */
async function ownerTask(
  store: DrizzleStore,
  objectiveId: string,
  owner: { readonly id: string; readonly name: string },
) {
  const at = new Date().toISOString();
  const account = await store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: "T0TOKEN",
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
    scope: "channel:export",
  });
  const authorization = {
    version: 5,
    capturedAt: at,
    tag: { id: owner.id, name: owner.name },
    origin: {
      provider: "slack",
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      scope: "channel:export",
    },
    requester: { id: "human", kind: "user" },
    roles: [],
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  } as const;
  const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
  const sessionKey = objectiveSessionKey(objectiveId);
  const event = {
    eventId: randomUUID(),
    logicalEventId: randomUUID(),
    provider: "slack",
    externalAccountId: account.externalAccountId,
    kind: "message",
    scope: "channel:export",
    sessionKey,
    actor: { id: "human", kind: "user" },
    text: "Export the report",
    occurredAt: at,
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: sessionKey,
      target: { channelId: "export", threadTs: sessionKey },
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
    objectiveId,
  });
  return store.openTask({
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
}
