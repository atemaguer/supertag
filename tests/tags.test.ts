import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import type {
  TaskAttemptEvent,
  TaskAttemptSpec,
  Worklet,
} from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite as migrateSqliteDatabase } from "./support/database.ts";
import { applyManifests, getResource } from "./support/resources.ts";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Tags and their routes", () => {
  it("allows only one Tag to occupy an account scope", async () => {
    const fixture = await createStoreFixture();
    try {
      const account = await createAccount(fixture.store);
      const engineering = await fixture.store.createTag({
        name: "Engineering",
      });
      expect(engineering).not.toHaveProperty("workerProfile");
      const product = await fixture.store.createTag({ name: "Product" });

      const surface = await fixture.store.addTagRoute({
        tagId: engineering.id,
        surfaceAccountId: account.id,
        scope: " channel:C123 ",
        createdBy: "user:U123",
      });
      expect(surface).toMatchObject({
        tagId: engineering.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
        enabled: true,
        createdBy: "user:U123",
      });
      await expect(
        fixture.store.addTagRoute({
          tagId: product.id,
          surfaceAccountId: account.id,
          scope: "channel:C123",
        }),
      ).rejects.toThrow(/already.*Tag|unique/i);

      await expect(fixture.store.listTagRoutes()).resolves.toEqual([surface]);
      await expect(fixture.store.resolveTagRoute(account.id, "channel:C123")).resolves.toEqual(
        surface,
      );
    } finally {
      await fixture.close();
    }
  });

  it("fails closed for disabled and removed routes", async () => {
    const fixture = await createStoreFixture();
    try {
      const account = await createAccount(fixture.store);
      const tag = await fixture.store.createTag({ name: "Engineering" });
      const disabled = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
        enabled: false,
      });

      await expect(fixture.store.findTagRouteById(disabled.id)).resolves.toEqual(disabled);
      await expect(
        fixture.store.resolveTagRoute(account.id, "channel:C123"),
      ).resolves.toBeUndefined();
      await expect(fixture.store.removeTagRoute(disabled.id)).resolves.toBe(true);
      await expect(fixture.store.findTagRouteById(disabled.id)).resolves.toBeUndefined();
      await expect(fixture.store.removeTagRoute(disabled.id)).resolves.toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("stores permissions independently from invocation surfaces and makes allow idempotent", async () => {
    const fixture = await createStoreFixture();
    try {
      const account = await createAccount(fixture.store);
      const tag = await fixture.store.createTag({ name: "Engineering" });
      const surface = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      const permissionSet = await fixture.store.createTagPermissionSet({
        tagId: tag.id,
        name: "engineering",
      });
      const input = {
        permissionSetId: permissionSet.id,
        target: "surface" as const,
        surfaceAccountId: account.id,
        scope: "channel:C123",
        action: "history:read",
      };

      const first = await fixture.store.addTagPermission(input);
      await expect(fixture.store.addTagPermission(input)).resolves.toEqual(first);
      await expect(fixture.store.listTagPermissions({ tagId: tag.id })).resolves.toEqual([first]);
      const activation = await fixture.store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: surface.id,
      });
      await expect(
        fixture.store.listTagPermissionActivations({ tagRouteId: surface.id }),
      ).resolves.toEqual([activation]);

      await fixture.store.removeTagRoute(surface.id);
      await expect(fixture.store.listTagPermissions({ tagId: tag.id })).resolves.toEqual([first]);
      await expect(fixture.store.removeTagPermission(first.id)).resolves.toBe(true);
      await expect(fixture.store.listTagPermissions({ tagId: tag.id })).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("stores Context Sets independently from permissions and activates them per origin surface", async () => {
    const fixture = await createStoreFixture();
    try {
      const account = await createAccount(fixture.store);
      const tag = await fixture.store.createTag({ name: "Engineering" });
      const surface = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      const contextSet = await fixture.store.createTagContextSet({
        tagId: tag.id,
        name: "engineering",
      });
      await expect(
        fixture.store.createTagContextSet({ tagId: tag.id, name: "engineering" }),
      ).resolves.toEqual(contextSet);

      const skill = await fixture.store.addTagContextItem({
        contextSetId: contextSet.id,
        itemKey: "skill:engineering-guidelines",
        type: "supertag/skill",
        version: 1,
        required: true,
        config: { reference: "engineering-guidelines" },
      });
      const work = await fixture.store.addTagContextItem({
        contextSetId: contextSet.id,
        itemKey: `artifacts:${surface.id}:shared-resource`,
        type: "supertag/artifacts",
        version: 1,
        required: true,
        config: {
          sourceRouteId: surface.id,
          selection: {
            match: "shared-resource",
            maxAgeDays: 30,
            limit: 3,
          },
        },
      });
      const activation = await fixture.store.activateTagContextSet({
        contextSetId: contextSet.id,
        tagRouteId: surface.id,
      });

      await expect(fixture.store.listTagContextSets({ tagId: tag.id })).resolves.toEqual([
        contextSet,
      ]);
      await expect(
        fixture.store.listTagContextItems({ contextSetId: contextSet.id }),
      ).resolves.toEqual([work, skill]);
      await expect(
        fixture.store.listTagContextActivations({ tagRouteId: surface.id }),
      ).resolves.toEqual([activation]);
      await expect(fixture.store.listTagPermissions({ tagId: tag.id })).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("reuses shared Permission and Context Sets across different Tags", async () => {
    const fixture = await createStoreFixture();
    try {
      const account = await createAccount(fixture.store);
      const engineering = await fixture.store.createTag({ name: "Engineering" });
      const security = await fixture.store.createTag({ name: "Security" });
      const engineeringRoute = await fixture.store.addTagRoute({
        tagId: engineering.id,
        surfaceAccountId: account.id,
        scope: "channel:engineering",
      });
      const securityRoute = await fixture.store.addTagRoute({
        tagId: security.id,
        surfaceAccountId: account.id,
        scope: "channel:security",
      });
      const permissionSet = await fixture.store.createTagPermissionSet({ name: "repository-read" });
      const contextSet = await fixture.store.createTagContextSet({ name: "engineering-knowledge" });

      await fixture.store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: engineeringRoute.id,
      });
      await fixture.store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: securityRoute.id,
      });
      await fixture.store.activateTagContextSet({
        contextSetId: contextSet.id,
        tagRouteId: engineeringRoute.id,
      });
      await fixture.store.activateTagContextSet({
        contextSetId: contextSet.id,
        tagRouteId: securityRoute.id,
      });
      await fixture.store.addTagContextItem({
        contextSetId: contextSet.id,
        itemKey: "work:engineering",
        type: "supertag/artifacts",
        version: 1,
        required: true,
        config: {
          sourceRouteId: engineeringRoute.id,
          selection: { match: "shared-resource", maxAgeDays: 30, limit: 3 },
        },
      });

      await expect(fixture.store.listTagPermissionActivations()).resolves.toHaveLength(2);
      await expect(fixture.store.listTagContextActivations()).resolves.toHaveLength(2);
      await expect(fixture.store.findTagPermissionSetByName("repository-read")).resolves.toEqual(
        permissionSet,
      );
      await expect(fixture.store.findTagContextSetByName("engineering-knowledge")).resolves.toEqual(
        contextSet,
      );
    } finally {
      await fixture.close();
    }
  });

  it("creates only the current Tag IAM schema from the Drizzle migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-tag-schema-"));
    directories.push(directory);
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const database = new Database(databasePath);
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        "ApprovalRequest",
        "Artifact",
        "ArtifactAcquisition",
        "ArtifactApprovalAuditEvent",
        "ArtifactConsumptionApproval",
        "ArtifactPublicationApproval",
        "ArtifactStorageLocation",
        "ArtifactUpload",
        "ArtifactVolumeCopy",
        "AttemptChangedPaths",
        "AuditEntry",
        "AuthKey",
        "CapturedArtifact",
        "DurableInboundEvent",
        "InboundControlDelivery",
        "Objective",
        "OperatorNotification",
        "OperatorNotificationItem",
        "OperatorToken",
        "OutboundReply",
        "OverlapWarning",
        "ResourceChange",
        "ResourceManagement",
        "Role",
        "RoleAssignment",
        "RoleContextSet",
        "RolePermissionSet",
        "Session",
        "SessionState",
        "SurfaceAccount",
        "Tag",
        "TagContextActivation",
        "TagContextItem",
        "TagContextSet",
        "TagMessage",
        "TagMessagingGrant",
        "TagPermission",
        "TagPermissionActivation",
        "TagPermissionSet",
        "TagRoute",
        "TagWorkerHostBinding",
        "Task",
        "TaskAttempt",
        "TaskEvent",
        "TaskReference",
        "Team",
        "Volume",
        "WorkerArtifactInventory",
        "WorkerHost",
        "WorkerHostCredential",
        "Workspace",
        "WorkspacePullRequestTransition",
        "WorkstreamPost",
      ]);

      const admissionColumns = database
        .prepare('PRAGMA table_info("DurableInboundEvent")')
        .all() as readonly { name: string; notnull: number; dflt_value: string | null }[];
      for (const name of ["tagRouteId", "tagId", "authorization", "contextPlan"]) {
        expect(admissionColumns.find((column) => column.name === name)).toMatchObject({
          notnull: 1,
          dflt_value: null,
        });
      }
    } finally {
      database.close();
    }
  });

  it("rejects an unconfigured surface before durable admission or Worker execution", async () => {
    const fixture = await createControlPlaneFixture();
    const worker = testWorker();
    const reply = vi.fn(async () => {});
    const onInboundEvent = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply, onInboundEvent });

    try {
      await controlPlane.start();
      await fixture.setupAccount(controlPlane);

      await expect(controlPlane.ingestSurfaceEvent(event())).resolves.toMatchObject({
        status: "unconfigured",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(worker.execute).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(onInboundEvent).not.toHaveBeenCalled();
      expect(durableRows(fixture.databasePath)).toEqual([]);
    } finally {
      await controlPlane.stop();
      await fixture.remove();
    }
  });

  it("rejects disabled and account-mismatched routes before Task admission", async () => {
    const fixture = await createControlPlaneFixture();
    const worker = testWorker();
    const reply = vi.fn(async () => {});
    const onInboundEvent = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply, onInboundEvent });

    try {
      await controlPlane.start();
      const primaryAccount = await fixture.setupAccount(controlPlane);
      const otherAccount = await fixture.store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: "T-OTHER",
        displayName: "Other workspace",
        authMethod: "slack-socket-mode",
        credentialId: "surface/slack/T-OTHER",
        status: "connected",
        configuration: { transport: "socket" },
        verifiedAt: "2026-08-01T00:00:00.000Z",
      });
      const tag = await fixture.store.createTag({ name: "Engineering" });
      await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: primaryAccount.id,
        scope: "channel:C123",
        enabled: false,
      });
      await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: otherAccount.id,
        scope: "channel:C999",
      });

      await expect(
        controlPlane.ingestSurfaceEvent(event("C123", "disabled")),
      ).resolves.toMatchObject({
        status: "unconfigured",
        surfaceAccountId: primaryAccount.id,
      });
      await expect(
        controlPlane.ingestSurfaceEvent(event("C999", "wrong-account")),
      ).resolves.toMatchObject({
        status: "unconfigured",
        surfaceAccountId: primaryAccount.id,
      });

      expect(worker.execute).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(onInboundEvent).not.toHaveBeenCalled();
      expect(durableRows(fixture.databasePath)).toEqual([]);
    } finally {
      await controlPlane.stop();
      await fixture.remove();
    }
  });

  it("routes an event to its Tag and snapshots the resolved route durably", async () => {
    const fixture = await createControlPlaneFixture();
    const worker = testWorker();
    const reply = vi.fn(async () => {});
    const onInboundEvent = vi.fn(async () => {});
    const controlPlane = fixture.controlPlane({ worklet: worker, reply, onInboundEvent });

    try {
      await controlPlane.start();
      const account = await fixture.setupAccount(controlPlane);
      const tag = await fixture.store.createTag({
        name: "Engineering",
      });
      await fixture.store.bindTagWorkerHost(tag.id, "tag-host");
      const surface = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      const permissionSet = await fixture.store.createTagPermissionSet({
        tagId: tag.id,
        name: "engineering",
      });
      await fixture.store.addTagPermission({
        target: "surface",
        permissionSetId: permissionSet.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
        action: "history:read",
      });
      await fixture.store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: surface.id,
      });
      const contextSet = await fixture.store.createTagContextSet({
        tagId: tag.id,
        name: "engineering",
      });
      const contextItem = await fixture.store.addTagContextItem({
        contextSetId: contextSet.id,
        itemKey: "skill:code-review",
        type: "supertag/skill",
        version: 1,
        required: true,
        config: { reference: "code-review", version: "1" },
      });
      await fixture.store.activateTagContextSet({
        contextSetId: contextSet.id,
        tagRouteId: surface.id,
      });
      const role = await fixture.store.createRole({
        name: "Engineering Reviewer",
        purpose: "Review engineering work.",
        instructions: "State unresolved risk.",
        contextSetIds: [contextSet.id],
        permissionSetIds: [permissionSet.id],
      });
      const roleAssignment = await fixture.store.assignRole({
        roleId: role.id,
        tagId: tag.id,
      });
      const inbound = event();

      await expect(controlPlane.ingestSurfaceEvent(inbound)).resolves.toMatchObject({
        status: "accepted",
        surfaceAccountId: account.id,
        tagRouteId: surface.id,
        tagId: tag.id,
      });

      await vi.waitFor(() =>
        expect(onInboundEvent).toHaveBeenCalledWith(inbound, account, {
          tagRouteId: surface.id,
          tagId: tag.id,
        }),
      );
      await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
      expect(worker.execute).toHaveBeenCalledOnce();
      expect(worker.execute.mock.calls[0]?.[0]).toMatchObject({
        version: 2,
        execution: {},
        workerProfile: { id: "default", revision: "1" },
        tag: { id: tag.id, name: "Engineering" },
        input: {
          origin: expect.objectContaining({
            surface: "slack",
            scope: inbound.scope,
            sessionKey: inbound.sessionKey,
          }),
        },
        authorization: {
          version: 5,
          tag: {
            id: tag.id,
            name: "Engineering",
          },
          origin: {
            tagRouteId: surface.id,
            surfaceAccountId: account.id,
            provider: "slack",
            scope: "channel:C123",
          },
          requester: inbound.actor,
          permissionSets: [{ id: permissionSet.id, name: permissionSet.name }],
          roles: [
            {
              assignmentId: roleAssignment.id,
              assignmentRevision: roleAssignment.revision,
              role: {
                id: role.id,
                name: role.name,
                purpose: role.purpose,
                instructions: role.instructions,
                revision: role.revision,
                contextSetIds: [contextSet.id],
                permissionSetIds: [permissionSet.id],
              },
            },
          ],
          resources: [
            {
              surfaceAccountId: account.id,
              provider: "slack",
              scope: "channel:C123",
              actions: ["event:receive", "history:read", "thread:read", "thread:reply"],
              sources: ["origin", "permission-set"],
            },
          ],
          runtimeActions: [],
        },
        contextPlan: {
          version: 7,
          sets: [
            {
              id: contextSet.id,
              name: contextSet.name,
              items: [
                {
                  id: contextItem.id,
                  itemKey: contextItem.itemKey,
                  type: "supertag/skill",
                  version: 1,
                  required: true,
                  config: { reference: "code-review", version: "1" },
                },
              ],
            },
          ],
        },
      });
      expect(durableRows(fixture.databasePath)).toEqual([
        expect.objectContaining({
          tagRouteId: surface.id,
          tagId: tag.id,
          status: "completed",
        }),
      ]);
      expect(
        JSON.parse(String(durableRows(fixture.databasePath)[0]?.["contextPlan"])),
      ).toMatchObject({
        version: 7,
        sets: [{ id: contextSet.id, items: [{ id: contextItem.id }] }],
      });
      expect(
        JSON.parse(String(durableRows(fixture.databasePath)[0]?.["authorization"])),
      ).toMatchObject({
        roles: [
          {
            assignmentId: roleAssignment.id,
            assignmentRevision: roleAssignment.revision,
            role: { id: role.id, revision: role.revision },
          },
        ],
      });
    } finally {
      await controlPlane.stop();
      await fixture.remove();
    }
  });

  it("composes Context Sets and Permission Sets asymmetrically by origin", async () => {
    const fixture = await createControlPlaneFixture();
    const worker = testWorker();
    const controlPlane = fixture.controlPlane({
      worklet: worker,
      reply: vi.fn(async () => {}),
      onInboundEvent: vi.fn(async () => {}),
    });
    try {
      await controlPlane.start();
      const account = await fixture.setupAccount(controlPlane);
      const tag = await fixture.store.createTag({ name: "Scoped teammate" });
      await fixture.store.bindTagWorkerHost(tag.id, "tag-host");
      const engineeringSurface = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
      });
      const securitySurface = await fixture.store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope: "channel:C999",
      });
      const engineeringPermissions = await fixture.store.createTagPermissionSet({
        tagId: tag.id,
        name: "engineering-access",
      });
      const securityPermissions = await fixture.store.createTagPermissionSet({
        tagId: tag.id,
        name: "security-access",
      });
      await fixture.store.addTagPermission({
        target: "surface",
        permissionSetId: engineeringPermissions.id,
        surfaceAccountId: account.id,
        scope: "channel:C123",
        action: "history:read",
      });
      await fixture.store.addTagPermission({
        target: "runtime",
        permissionSetId: engineeringPermissions.id,
        action: "commands:execute",
      });
      await fixture.store.addTagPermission({
        target: "surface",
        permissionSetId: securityPermissions.id,
        surfaceAccountId: account.id,
        scope: "channel:C999",
        action: "security:read",
      });
      await fixture.store.addTagPermission({
        target: "runtime",
        permissionSetId: securityPermissions.id,
        action: "browser:use",
      });
      for (const surface of [engineeringSurface, securitySurface]) {
        await fixture.store.activateTagPermissionSet({
          permissionSetId: engineeringPermissions.id,
          tagRouteId: surface.id,
        });
      }
      await fixture.store.activateTagPermissionSet({
        permissionSetId: securityPermissions.id,
        tagRouteId: securitySurface.id,
      });

      const engineeringContext = await fixture.store.createTagContextSet({
        tagId: tag.id,
        name: "engineering",
      });
      const securityContext = await fixture.store.createTagContextSet({
        tagId: tag.id,
        name: "security",
      });
      await fixture.store.addTagContextItem({
        contextSetId: engineeringContext.id,
        itemKey: "skill:code-review",
        type: "supertag/skill",
        version: 1,
        required: true,
        config: { reference: "code-review", version: "1" },
      });
      await fixture.store.addTagContextItem({
        contextSetId: securityContext.id,
        itemKey: "skill:incident-response",
        type: "supertag/skill",
        version: 1,
        required: true,
        config: { reference: "incident-response", version: "1" },
      });
      for (const surface of [engineeringSurface, securitySurface]) {
        await fixture.store.activateTagContextSet({
          contextSetId: engineeringContext.id,
          tagRouteId: surface.id,
        });
      }
      await fixture.store.activateTagContextSet({
        contextSetId: securityContext.id,
        tagRouteId: securitySurface.id,
      });

      await controlPlane.ingestSurfaceEvent(event("C123", "engineering"));
      await controlPlane.ingestSurfaceEvent(event("C999", "security"));
      await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledTimes(2));

      const executions = worker.execute.mock.calls.map((call) => call[0]);
      const engineeringExecution = executions.find(
        (execution) => execution.input.origin.scope === "channel:C123",
      );
      const securityExecution = executions.find(
        (execution) => execution.input.origin.scope === "channel:C999",
      );
      expect(engineeringExecution?.authorization.permissionSets.map((set) => set.name)).toEqual([
        "engineering-access",
      ]);
      expect(securityExecution?.authorization.permissionSets.map((set) => set.name)).toEqual([
        "engineering-access",
        "security-access",
      ]);
      expect(engineeringExecution?.authorization.runtimeActions).toEqual(["commands:execute"]);
      expect(securityExecution?.authorization.runtimeActions).toEqual([
        "browser:use",
        "commands:execute",
      ]);
      expect(engineeringExecution?.contextPlan.sets.map((set) => set.name)).toEqual([
        "engineering",
      ]);
      expect(securityExecution?.contextPlan.sets.map((set) => set.name)).toEqual([
        "engineering",
        "security",
      ]);
      expect(securityExecution?.contextPlan.sets[1]?.items[0]).toMatchObject({
        type: "supertag/skill",
        version: 1,
        required: true,
        config: { reference: "incident-response", version: "1" },
      });
    } finally {
      await controlPlane.stop();
      await fixture.remove();
    }
  });

  it("creates, describes, lists and changes Slack locations through RPC and manifests", async () => {
    const fixture = await createTagCliFixture();
    const { client, store } = fixture;
    try {
      await createAccount(store);
      await expect(
        client.runTagCommand("create", ["engineering", "--worker-profile", "removed"]),
      ).rejects.toThrow();
      expect(await client.runTagCommand("create", ["engineering"])).toContain(
        "Created Tag engineering",
      );
      expect(
        await client.runTagCommand("add", [
          "engineering",
          "slack",
          "--channel-id",
          "c123",
          "--account",
          "T-BINDINGS",
        ]),
      ).toContain("Added engineering to slack C123");
      const applied = await applyManifests(client, [
        {
          apiVersion: "supertag/v1",
          kind: "PermissionSet",
          metadata: { name: "engineering-access" },
          spec: {
            permissions: [
              { target: "runtime", action: "commands:execute" },
              { target: "runtime", action: "web:search" },
            ],
          },
        },
        {
          apiVersion: "supertag/v1",
          kind: "ContextSet",
          metadata: { name: "engineering-context" },
          spec: {
            items: [
              {
                itemKey: "skill:review",
                type: "supertag/skill",
                version: 1,
                required: true,
                config: { reference: "code-review", version: "1" },
              },
              {
                itemKey: "runbook:payments",
                type: "acme.io/runbook",
                version: 1,
                required: false,
                config: { name: "payments" },
              },
              {
                itemKey: "artifacts",
                type: "supertag/artifacts",
                version: 1,
                required: true,
                config: {
                  sourceRouteId: (await store.listTagRoutes())[0]?.id,
                  selection: { match: "shared-resource", maxAgeDays: 30, limit: 3 },
                },
              },
            ],
          },
        },
      ]);
      expect(applied.results.map((result) => result.failureMessage)).toEqual(["", ""]);
      expect(applied.complete).toBe(true);
      for (const [command, set] of [
        ["permission", "engineering-access"],
        ["context", "engineering-context"],
      ] as const) {
        expect(
          await client.runTagCommand(command, [
            "activate",
            "engineering",
            set,
            "slack",
            "--channel-id",
            "C123",
          ]),
        ).toContain(`Activated ${set}`);
      }
      expect(await store.listTagPermissionActivations()).toHaveLength(1);
      expect(await store.listTagContextActivations()).toHaveLength(1);
      expect(await runResourceCommand(client, "describe", ["tag", "engineering"])).toContain(
        "engineering",
      );
      expect(await runResourceCommand(client, "get", ["tag"])).toContain("engineering");
      expect((await getResource(client, "context-sets", "engineering-context")).spec.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "supertag/skill" }),
          expect.objectContaining({ type: "supertag/artifacts" }),
          expect.objectContaining({ type: "acme.io/runbook", required: false }),
        ]),
      );
      await applyManifests(client, [
        {
          apiVersion: "supertag/v1",
          kind: "PermissionSet",
          metadata: { name: "engineering-access" },
          spec: { permissions: [] },
        },
      ]);
      expect(await store.listTagPermissions()).toEqual([]);
      expect(
        await client.runTagCommand("remove", [
          "engineering",
          "slack",
          "--channel-id",
          "C123",
          "--account",
          "T-BINDINGS",
        ]),
      ).toContain("Removed engineering from slack C123 on Tag Test");
      expect(await store.listTagRoutes()).toEqual([]);
      expect(await store.listTagContextActivations()).toEqual([]);
      expect(await store.listTagPermissionActivations()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    {
      provider: "github",
      selector: ["--repo", "atemaguer/supertag"],
      scope: "repository:987654",
      secret: "github-secret-token",
    },
    {
      provider: "linear",
      selector: ["--team", "ENG"],
      scope: "team:72b2a2dc-6f4f-4423-9d34-24b5bd10634a",
      secret: "lin_api_test",
    },
  ] as const)(
    "resolves $provider names through the live CLI RPC route",
    async ({ provider, selector, scope, secret }) => {
      const fixture = await createTagCliFixture();
      const realFetch = globalThis.fetch;
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/"))
          return Response.json({ id: 987654, full_name: "atemaguer/supertag" });
        if (url.startsWith("https://api.linear.app/"))
          return Response.json({
            data: {
              teams: {
                nodes: [{ id: scope.slice(5), key: "ENG", name: "Engineering" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        return realFetch(input, init);
      });
      try {
        const account = await fixture.store.saveSurfaceAccount({
          provider,
          externalAccountId: "provider-account",
          displayName: "Provider account",
          authMethod: provider === "github" ? "github-token" : "linear-api-key",
          credentialId: `surface/${provider}/fixture`,
          status: "connected",
          configuration: {},
          verifiedAt: new Date().toISOString(),
        });
        await fixture.credentialVault.store(
          account.credentialId,
          provider === "github"
            ? { token: secret }
            : { apiKey: secret, webhookSecret: "test-webhook-secret" },
        );
        const tag = await fixture.client.createTag({ name: "engineering" });
        const output = await fixture.client.runTagCommand("add", [
          tag.metadata.name,
          provider,
          ...selector,
          "--account",
          account.externalAccountId,
        ]);
        expect(await fixture.store.listTagRoutes()).toEqual([
          expect.objectContaining({ tagId: tag.metadata.id, surfaceAccountId: account.id, scope }),
        ]);
        const providerCall = request.mock.calls.find(([url]) =>
          String(url).startsWith(
            `https://api.${provider === "github" ? "github.com" : "linear.app"}/`,
          ),
        );
        expect(providerCall).toBeDefined();
        expect(new Headers(providerCall?.[1]?.headers).get("authorization")).toBe(
          provider === "github" ? `Bearer ${secret}` : secret,
        );
        if (provider === "github") {
          expect(String(providerCall?.[0])).toBe("https://api.github.com/repos/atemaguer/supertag");
          expect(providerCall?.[1]?.redirect).toBe("error");
        }
        expect(output).not.toContain(secret);
        // Provider permissions retain the resolved stable scope through manifests.
        await applyManifests(fixture.client, [
          {
            apiVersion: "supertag/v1",
            kind: "PermissionSet",
            metadata: { name: "provider-access" },
            spec: {
              permissions: [
                {
                  target: "surface",
                  surfaceAccountId: account.id,
                  scope,
                  action: provider === "github" ? "contents:read" : "issues:read",
                },
              ],
            },
          },
        ]);
        expect(await fixture.store.listTagPermissions()).toEqual([
          expect.objectContaining({ surfaceAccountId: account.id, scope }),
        ]);
      } finally {
        request.mockRestore();
        await fixture.close();
      }
    },
  );
});

async function createStoreFixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-tags-store-"));
  directories.push(directory);
  const databasePath = join(directory, "supertag.db");
  await migrateSqlite(databasePath);
  const store = new DrizzleStore({ url: `file:${databasePath}` });
  await store.connect();
  return {
    directory,
    store,
    close: async () => {
      await store.disconnect();
      const index = directories.indexOf(directory);
      if (index !== -1) {
        directories.splice(index, 1);
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createControlPlaneFixture() {
  const directory = await mkdtemp(join(tmpdir(), "supertag-tags-controlPlane-"));
  const databasePath = join(directory, "supertag.db");
  await migrateSqlite(databasePath);
  const store = new DrizzleStore({ url: `file:${databasePath}` });
  return {
    databasePath,
    store,
    controlPlane: (
      handlers: Pick<
        ConstructorParameters<typeof ControlPlane>[0],
        "onInboundEvent" | "reply" | "worklet"
      >,
    ) =>
      new ControlPlane({
        store,
        credentialVault: new FileGatewayCredentialVault(join(directory, "secrets.json")),
        dispatch: { instanceId: "tag-test", pollIntervalMs: 5, retryBaseMs: 5 },
        ...handlers,
      }),
    setupAccount: (controlPlane: ControlPlane) =>
      controlPlane.setupSurfaceAccount({
        provider: "slack",
        externalAccountId: "T-BINDINGS",
        displayName: "Tag Test",
        authMethod: "slack-socket-mode",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
      }),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

async function createAccount(store: DrizzleStore) {
  return store.saveSurfaceAccount({
    provider: "slack",
    externalAccountId: "T-BINDINGS",
    displayName: "Tag Test",
    authMethod: "slack-socket-mode",
    credentialId: "surface/slack/T-BINDINGS",
    status: "connected",
    configuration: { transport: "socket" },
    verifiedAt: "2026-08-01T00:00:00.000Z",
  });
}

async function migrateSqlite(databasePath: string): Promise<void> {
  await migrateSqliteDatabase(databasePath);
}

function durableRows(databasePath: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM DurableInboundEvent ORDER BY createdAt").all();
  } finally {
    database.close();
  }
}

function testWorker(): Worklet & {
  execute: ReturnType<typeof vi.fn<Worklet["execute"]>>;
} {
  const execute = vi.fn((spec: TaskAttemptSpec): AsyncIterable<TaskAttemptEvent> => {
    async function* stream(): AsyncIterable<TaskAttemptEvent> {
      const at = "2026-08-02T00:00:00.000Z";
      const identity = { taskId: spec.taskId, attemptId: spec.attemptId, at };
      yield { type: "execution.started", ...identity, workerId: "tag-worker" };
      yield {
        type: "output.message",
        ...identity,
        message: { role: "teammate", text: "bound reply" },
      };
      yield {
        type: "result",
        ...identity,
        result: {
          summary: "bound reply",
          decisions: [],
          changes: [],
          unresolved: [],
          findings: [],
          references: [],
          artifacts: [],
        },
      };
      yield { type: "execution.completed", ...identity };
    }
    return stream();
  });
  return {
    id: "tag-worklet",
    describe: async () => ({
      id: "tag-worklet",
      protocolVersion: 1,
      host: {
        id: "tag-host",
        workers: [
          {
            profileCapabilities: [
              {
                profile: { id: "default", revision: "1" },
                capabilities: [],
                contextTypes: [
                  { type: "supertag/skill", versions: [1] },
                  { type: "supertag/artifacts", versions: [1] },
                ],
              },
              {
                profile: { id: "local-codex", revision: "7" },
                capabilities: [],
                contextTypes: [
                  { type: "supertag/skill", versions: [1] },
                  { type: "supertag/artifacts", versions: [1] },
                ],
              },
            ],
            id: "tag-worker",
            type: "test",
            capabilities: [],
            profiles: [
              { id: "default", revision: "1" },
              { id: "local-codex", revision: "7" },
            ],
            contextTypes: [
              { type: "supertag/skill", versions: [1] },
              { type: "supertag/artifacts", versions: [1] },
            ],
          },
        ],
      },
    }),
    execute,
  };
}

function event(channelId = "C123", suffix = "1.000"): InboundSurfaceEvent {
  return {
    eventId: `tag-delivery-${suffix}`,
    logicalEventId: `message:T-BINDINGS:${channelId}:${suffix}`,
    provider: "slack",
    externalAccountId: "T-BINDINGS",
    kind: "mention",
    scope: `channel:${channelId}`,
    sessionKey: `slack:T-BINDINGS:${channelId}:${suffix}`,
    actor: { id: "U123", kind: "user" },
    text: "<@U_APP> route this",
    occurredAt: "2026-08-01T00:00:00.000Z",
    callback: {
      provider: "slack",
      mode: "slack_thread",
      threadKey: `T-BINDINGS|${channelId}|${suffix}`,
      target: { channelId, threadTs: suffix },
    },
    source: {
      workspaceId: "T-BINDINGS",
      channelId,
      messageTs: suffix,
      threadTs: suffix,
    },
    metadata: { slackEventType: "app_mention" },
  };
}

async function createTagCliFixture() {
  const fixture = await createStoreFixture();
  const credentialVault = new FileGatewayCredentialVault(join(fixture.directory, "vault.json"));
  const runtime = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: `file:${join(fixture.directory, "supertag.db")}`,
    adminToken: "tag-cli-test",
    workletTransport: "remote",
    credentialVault,
    stateDirectory: join(fixture.directory, "server"),
    reply: async () => {},
  });
  return {
    ...fixture,
    credentialVault,
    client: new ControlPlaneClient({ url: runtime.url, token: "tag-cli-test" }),
    close: async () => {
      await runtime.close();
      await fixture.close();
    },
  };
}
