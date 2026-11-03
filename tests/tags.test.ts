import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTagCommand } from "../apps/cli/src/tags.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import type { InboundSurfaceEvent } from "../packages/core/src/index.ts";
import type {
  TaskAttemptEvent,
  TaskAttemptSpec,
  Worklet,
} from "../packages/runtime/sdk/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite as migrateSqliteDatabase } from "./support/database.ts";

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
        "ObjectiveMessage",
        "ObjectiveSession",
        "OperatorInputReceipt",
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
        "TagDigestDelivery",
        "TagMailboxCredential",
        "TagMessage",
        "TagMessagingGrant",
        "TagPermission",
        "TagPermissionActivation",
        "TagPermissionSet",
        "TagRoute",
        "TagWorkerHostBinding",
        "Task",
        "TaskAssignment",
        "TaskAttempt",
        "TaskEvent",
        "TaskReference",
        "Team",
        "TeamLiveDelivery",
        "TeamReplyTrigger",
        "Volume",
        "WorkerArtifactInventory",
        "WorkerHost",
        "WorkerHostCredential",
        "Workspace",
        "WorkspacePullRequestTransition",
        "Workstream",
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
                origin: "user",
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

  it("creates, shows, lists, adds, and removes a Slack surface through the CLI", async () => {
    const fixture = await createStoreFixture();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const credentialVault = new FileGatewayCredentialVault(join(fixture.directory, "secrets.json"));
    try {
      await createAccount(fixture.store);
      const dependencies = { store: fixture.store, credentialVault };

      await expect(
        runTagCommand("create", ["Engineering", "--worker-profile", "removed"], dependencies),
      ).rejects.toThrow();
      await runTagCommand("create", ["Engineering"], dependencies);
      await runTagCommand(
        "add",
        ["Engineering", "slack", "--channel-id", "c123", "--account", "T-BINDINGS"],
        dependencies,
      );
      await runTagCommand(
        "permission",
        ["create", "Engineering", "engineering-access"],
        dependencies,
      );
      await runTagCommand(
        "permission",
        [
          "allow",
          "Engineering",
          "engineering-access",
          "runtime",
          "--actions",
          "commands:execute,web:search",
        ],
        dependencies,
      );
      await expect(
        runTagCommand(
          "permission",
          [
            "allow",
            "Engineering",
            "engineering-access",
            "slack",
            "--channel-id",
            "C123",
            "--actions",
            "history:read",
            "--account",
            "T-BINDINGS",
          ],
          dependencies,
        ),
      ).rejects.toThrow("Grant tools with target: mcp instead");
      await runTagCommand(
        "permission",
        [
          "activate",
          "Engineering",
          "engineering-access",
          "slack",
          "--channel-id",
          "C123",
          "--account",
          "T-BINDINGS",
        ],
        dependencies,
      );
      await runTagCommand("context", ["create", "Engineering", "engineering"], dependencies);
      await runTagCommand(
        "context",
        [
          "add-artifacts",
          "Engineering",
          "engineering",
          "slack",
          "--channel-id",
          "C123",
          "--account",
          "T-BINDINGS",
          "--max-age-days",
          "30",
          "--limit",
          "3",
        ],
        dependencies,
      );
      await runTagCommand(
        "context",
        ["add-skill", "Engineering", "engineering", "code-review", "--version", "1"],
        dependencies,
      );
      await runTagCommand(
        "context",
        [
          "add",
          "Engineering",
          "engineering",
          "acme.io/runbook",
          "runbook:payments",
          "--version",
          "1",
          "--config",
          '{"name":"payments"}',
          "--optional",
        ],
        dependencies,
      );
      await runTagCommand(
        "context",
        [
          "activate",
          "Engineering",
          "engineering",
          "slack",
          "--channel-id",
          "C123",
          "--account",
          "T-BINDINGS",
        ],
        dependencies,
      );
      await runTagCommand("context", ["show", "Engineering", "engineering"], dependencies);
      await runTagCommand("show", ["Engineering"], dependencies);
      await runTagCommand("list", [], dependencies);

      expect(output.mock.calls.map(([value]) => String(value)).join("")).toMatch(
        /Created Tag Engineering.*Added Engineering.*Tag: Engineering.*slack:channel:C123/s,
      );
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toContain(
        "NAME\tSTATUS\tAVAILABLE_IN",
      );
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toContain(
        "commands:execute\truntime\t-",
      );
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toMatch(
        /Context Set: engineering.*acme\.io\/runbook\t1\tfalse.*supertag\/artifacts\t1\ttrue.*supertag\/skill\t1\ttrue.*ACTIVE_FROM.*slack:channel:C123/s,
      );

      await runTagCommand(
        "permission",
        [
          "revoke",
          "Engineering",
          "engineering-access",
          "runtime",
          "--actions",
          "commands:execute,web:search",
        ],
        dependencies,
      );

      await runTagCommand(
        "remove",
        ["Engineering", "slack", "--channel-id", "C123", "--account", "T-BINDINGS"],
        dependencies,
      );
      await fixture.store.connect();
      await expect(fixture.store.listTagRoutes()).resolves.toEqual([]);
      await expect(fixture.store.listTagPermissions()).resolves.toEqual([]);
      await fixture.store.disconnect();
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toContain(
        "Removed Engineering from slack C123 on Tag Test.",
      );
    } finally {
      await fixture.close();
    }
  });

  it("resolves a GitHub repository name to its stable numeric scope through the CLI", async () => {
    const fixture = await createStoreFixture();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ id: 987654, full_name: "atemaguer/supertag" }),
      );
    vi.stubGlobal("fetch", request);
    const credentialVault = new FileGatewayCredentialVault(join(fixture.directory, "secrets.json"));
    try {
      const account = await fixture.store.saveSurfaceAccount({
        provider: "github",
        externalAccountId: "user-123",
        displayName: "atemaguer",
        authMethod: "github-token",
        credentialId: "surface/github/user-123",
        status: "connected",
        configuration: {},
        verifiedAt: "2026-08-01T00:00:00.000Z",
      });
      await credentialVault.store("surface/github/user-123", { token: "github-secret-token" });
      const tag = await fixture.store.createTag({ name: "Engineering" });
      const dependencies = { store: fixture.store, credentialVault };

      await runTagCommand(
        "add",
        [
          tag.name,
          "github",
          "--repo",
          "atemaguer/supertag",
          "--account",
          account.externalAccountId,
        ],
        dependencies,
      );
      await runTagCommand("permission", ["create", tag.name, "engineering-access"], dependencies);
      await runTagCommand(
        "permission",
        [
          "allow",
          tag.name,
          "engineering-access",
          "github",
          "--repo",
          "atemaguer/supertag",
          "--actions",
          "contents:read",
          "--account",
          account.externalAccountId,
        ],
        dependencies,
      );

      await fixture.store.connect();
      await expect(fixture.store.listTagRoutes()).resolves.toEqual([
        expect.objectContaining({
          surfaceAccountId: account.id,
          tagId: tag.id,
          scope: "repository:987654",
        }),
      ]);
      await expect(fixture.store.listTagPermissions()).resolves.toEqual([
        expect.objectContaining({
          surfaceAccountId: account.id,
          scope: "repository:987654",
          reference: "atemaguer/supertag",
          action: "contents:read",
        }),
      ]);
      await fixture.store.disconnect();
      expect(request).toHaveBeenCalledWith(
        "https://api.github.com/repos/atemaguer/supertag",
        expect.objectContaining({ redirect: "error" }),
      );
      const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer github-secret-token");
      expect(output.mock.calls.map(([value]) => String(value)).join("")).not.toContain(
        "github-secret-token",
      );
    } finally {
      await fixture.close();
    }
  });

  it("resolves a Linear team key to its stable UUID scope through the CLI", async () => {
    const fixture = await createStoreFixture();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const teamId = "72b2a2dc-6f4f-4423-9d34-24b5bd10634a";
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          teams: {
            nodes: [{ id: teamId, key: "ENG", name: "Engineering" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", request);
    const credentialVault = new FileGatewayCredentialVault(join(fixture.directory, "secrets.json"));
    try {
      const account = await fixture.store.saveSurfaceAccount({
        provider: "linear",
        externalAccountId: "workspace-1",
        displayName: "Acme",
        authMethod: "linear-api-key",
        credentialId: "surface/linear/workspace-1",
        status: "connected",
        configuration: { apiBaseUrl: "https://api.linear.app/graphql" },
        verifiedAt: "2026-08-01T00:00:00.000Z",
      });
      await credentialVault.store("surface/linear/workspace-1", {
        apiKey: "lin_api_test",
        webhookSecret: "linear-webhook-secret",
      });
      const tag = await fixture.store.createTag({ name: "Engineering" });
      const dependencies = { store: fixture.store, credentialVault };

      await runTagCommand(
        "add",
        [tag.name, "linear", "--team", "ENG", "--account", account.externalAccountId],
        dependencies,
      );

      await fixture.store.connect();
      await expect(fixture.store.listTagRoutes()).resolves.toEqual([
        expect.objectContaining({
          surfaceAccountId: account.id,
          tagId: tag.id,
          scope: `team:${teamId}`,
        }),
      ]);
      await fixture.store.disconnect();
      const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe("lin_api_test");
      expect(output.mock.calls.map(([value]) => String(value)).join("")).toContain(
        "Added Engineering to linear Engineering (ENG) on Acme",
      );
      expect(output.mock.calls.map(([value]) => String(value)).join("")).not.toContain(
        "lin_api_test",
      );
    } finally {
      await fixture.close();
    }
  });
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
