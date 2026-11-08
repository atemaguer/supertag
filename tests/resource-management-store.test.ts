import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneApplySet } from "../apps/cli/src/apply-set-prune.ts";
import type { SurfaceTagAuthorizationSnapshot } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} resource management`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-resource-management-"));
      const isolated =
        dialect === "postgresql" && postgres
          ? await createIsolatedPostgresDatabase(postgres)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(async () => {
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      });
      return store;
    }

    /** Opens a pending surface Task for the Tag, as an inbound message would. */
    async function openTask(store: DrizzleStore, tagId: string, tagName: string) {
      const account = await store.saveSurfaceAccount({
        provider: "slack",
        externalAccountId: randomUUID(),
        displayName: "Slack",
        authMethod: "test",
        credentialId: "test",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const route = await store.addTagRoute({
        tagId,
        surfaceAccountId: account.id,
        scope: "channel:busy",
      });
      const at = new Date().toISOString();
      const authorization: SurfaceTagAuthorizationSnapshot = {
        version: 5,
        capturedAt: at,
        tag: { id: tagId, name: tagName },
        origin: {
          provider: "slack",
          surfaceAccountId: account.id,
          tagRouteId: route.id,
          scope: "channel:busy",
        },
        requester: { id: "human", kind: "user" },
        roles: [],
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      };
      const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
      const event = {
        eventId: randomUUID(),
        logicalEventId: randomUUID(),
        provider: "slack",
        externalAccountId: account.externalAccountId,
        kind: "message",
        scope: "channel:busy",
        sessionKey: "conversation",
        actor: { id: "human", kind: "user" },
        text: "Work on this",
        occurredAt: at,
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: "conversation",
          target: { channelId: "busy", threadTs: "conversation" },
        },
        source: {},
        metadata: {},
      } as const;
      const admitted = await store.admitInboundEvent({
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        tagId,
        authorization,
        contextPlan,
        event,
      });
      const session = await store.openSession({
        tagId,
        sessionKey: "conversation",
        origin: {},
        at,
      });
      return store.openTask({
        inboundEventId: admitted.work.id,
        tagId,
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

    it("saves field ownership and set membership per resource", async () => {
      const store = await fixture();
      expect(await store.findResourceManagement("Tag", "builder")).toBeUndefined();
      const saved = await store.saveResourceManagement({
        kind: "Tag",
        name: "builder",
        applySet: "team-a",
        fields: { "spec.roles[Engineer]": { manager: "team-a", value: true } },
      });
      expect(saved).toMatchObject({
        kind: "Tag",
        name: "builder",
        applySet: "team-a",
        fields: { "spec.roles[Engineer]": { manager: "team-a", value: true } },
      });
      // Without a set, a later write keeps the membership and replaces the fields.
      await store.saveResourceManagement({
        kind: "Tag",
        name: "builder",
        fields: { "spec.workerHosts[h1]": { manager: "apply", value: true } },
      });
      expect(await store.findResourceManagement("Tag", "builder")).toMatchObject({
        applySet: "team-a",
        fields: { "spec.workerHosts[h1]": { manager: "apply", value: true } },
      });
      await store.saveResourceManagement({
        kind: "Role",
        name: "Engineer",
        applySet: "team-a",
        fields: {},
      });
      await store.saveResourceManagement({
        kind: "Tag",
        name: "planner",
        applySet: "team-b",
        fields: {},
      });
      expect(
        (await store.listApplySetMembers("team-a")).map(
          (member) => `${member.kind}/${member.name}`,
        ),
      ).toEqual(["Role/Engineer", "Tag/builder"]);
      // Applying under another set moves the resource.
      await store.saveResourceManagement({
        kind: "Tag",
        name: "builder",
        applySet: "team-b",
        fields: {},
      });
      expect((await store.listApplySetMembers("team-a")).map((member) => member.name)).toEqual([
        "Engineer",
      ]);
      expect(await store.deleteResourceManagement("Role", "Engineer")).toBe(true);
      expect(await store.deleteResourceManagement("Role", "Engineer")).toBe(false);
      await expect(
        store.saveResourceManagement({ kind: "Tag", name: "x", applySet: "cli", fields: {} }),
      ).rejects.toThrow("built-in field manager");
      await expect(
        store.saveResourceManagement({ kind: "Task" as "Tag", name: "x", fields: {} }),
      ).rejects.toThrow("not a managed resource kind");
    });

    it("deletes a Tag with its configuration unless coordination records name it", async () => {
      const store = await fixture();
      const role = await store.createRole({ name: `role-${randomUUID()}`, purpose: "Review." });
      const idle = await store.createTag({ name: `idle-${randomUUID()}` });
      await store.assignRole({ roleId: role.id, tagId: idle.id });
      expect(await store.deleteTag(idle.id)).toBe(true);
      expect(await store.findTagById(idle.id)).toBeUndefined();
      expect(await store.listRoleAssignments({ roleId: role.id })).toEqual([]);

      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      await store.assignRole({ roleId: role.id, tagId: owner.id });
      await store.createObjective({ id: randomUUID(), ownerTagId: owner.id, outcome: "Ship." });
      await expect(store.deleteTag(owner.id)).rejects.toThrow();
      // The failed delete rolled back: the assignment survives.
      expect(await store.listRoleAssignments({ tagId: owner.id })).toHaveLength(1);
    });

    it("prunes only the set's missing members and retires only Tags nothing uses", async () => {
      const store = await fixture();
      const busy = await store.createTag({ name: "busy" });
      const done = await store.createTag({ name: "done" });
      const owner = await store.createTag({ name: "owner" });
      await store.createTag({ name: "idle" });
      await store.createTag({ name: "kept" });
      await store.createTag({ name: "elsewhere" });
      for (const name of ["busy", "done", "owner", "idle", "kept"])
        await store.saveResourceManagement({ kind: "Tag", name, applySet: "team-a", fields: {} });
      await store.saveResourceManagement({
        kind: "Tag",
        name: "elsewhere",
        applySet: "team-b",
        fields: {},
      });
      expect((await openTask(store, busy.id, busy.name)).status).toBe("pending");
      const finished = await openTask(store, done.id, done.name);
      await store.closeTask({
        taskId: finished.id,
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      const objectiveId = randomUUID();
      await store.createObjective({ id: objectiveId, ownerTagId: owner.id, outcome: "Ship." });
      const busyTask = await store.listTasks({ tagId: busy.id, status: "pending" });

      const input = { applySet: "team-a", keep: [{ kind: "Tag", name: "kept" }] };
      const planned = await pruneApplySet(store, { ...input, dryRun: true });
      expect(planned).toEqual([
        {
          kind: "Tag",
          name: "busy",
          action: "skip",
          reason: `is in use by Task ${busyTask[0]?.id} (pending)`,
        },
        // Finished history does not keep a Tag in use; pruning retires it.
        { kind: "Tag", name: "done", action: "delete" },
        { kind: "Tag", name: "idle", action: "delete" },
        {
          kind: "Tag",
          name: "owner",
          action: "skip",
          reason: `is in use by Objective ${objectiveId} (owner)`,
        },
      ]);
      expect(await store.findTagByName("idle")).toBeDefined();

      expect(await pruneApplySet(store, { ...input, dryRun: false })).toEqual(planned);
      expect(await store.findTagByName("idle")).toBeUndefined();
      expect(await store.findTagByName("done")).toBeUndefined();
      expect(await store.findTagByName("done", { includeRetired: true })).toMatchObject({
        id: done.id,
        status: "retired",
      });
      for (const name of ["busy", "owner", "kept", "elsewhere"])
        expect(await store.findTagByName(name)).toBeDefined();
      // History is untouched.
      expect(await store.findTaskById(finished.id)).toMatchObject({
        status: "completed",
        tagId: done.id,
      });
      // Skipped members stay in the set so a later prune tries again.
      expect((await store.listApplySetMembers("team-a")).map((member) => member.name)).toEqual([
        "busy",
        "kept",
        "owner",
      ]);
    });

    it("retires a Tag: configuration goes, history and its reference stay", async () => {
      const store = await fixture();
      const role = await store.createRole({ name: `role-${randomUUID()}`, purpose: "Review." });
      const permissionSet = await store.createTagPermissionSet({ name: "deploy" });
      const contextSet = await store.createTagContextSet({ name: "guides" });
      const tag = await store.createTag({ name: "release" });
      const peer = await store.createTag({ name: "peer" });
      await store.assignRole({ roleId: role.id, tagId: tag.id });
      const finished = await openTask(store, tag.id, tag.name);
      await store.closeTask({
        taskId: finished.id,
        status: "completed",
        endedAt: new Date().toISOString(),
      });
      const [route] = await store.listTagRoutes({ tagId: tag.id });
      if (!route) throw new Error("expected a route");
      await store.activateTagPermissionSet({
        permissionSetId: permissionSet.id,
        tagRouteId: route.id,
      });
      await store.activateTagContextSet({ contextSetId: contextSet.id, tagRouteId: route.id });
      await store.bindTagWorkerHost(tag.id, "host-a");
      await store.setTagMessagingGrants(tag.id, [peer.id]);
      await store.setTagMessagingGrants(peer.id, [tag.id]);

      const retired = await store.retireTag(tag.id);
      expect(retired).toMatchObject({ id: tag.id, name: "release", status: "retired" });
      expect(retired.retiredAt).toEqual(expect.any(String));
      expect(await store.listTagRoutes({ tagId: tag.id })).toEqual([]);
      expect(
        await store.listTagPermissionActivations({ permissionSetId: permissionSet.id }),
      ).toEqual([]);
      expect(await store.listTagContextActivations({ contextSetId: contextSet.id })).toEqual([]);
      expect(await store.listTagWorkerHostBindings(tag.id)).toEqual([]);
      expect(await store.listTagMessagingGrants(peer.id)).toEqual([]);
      expect(await store.listRoleAssignments({ tagId: tag.id, status: "active" })).toEqual([]);
      expect(await store.listRoleAssignments({ tagId: tag.id })).toMatchObject([
        { status: "inactive" },
      ]);
      // History keeps its reference to the retired row.
      expect(await store.findTaskById(finished.id)).toMatchObject({ tagId: tag.id });
      expect(await store.listSessions({ tagId: tag.id })).toHaveLength(1);
      expect(await store.findTagById(tag.id)).toMatchObject({ status: "retired" });
      // Retiring again changes nothing.
      expect(await store.retireTag(tag.id)).toMatchObject({ retiredAt: retired.retiredAt });

      // Hidden from lists and name lookups; nothing can be attached to it.
      expect((await store.listTags()).map((item) => item.name)).toEqual(["peer"]);
      expect((await store.listTags({ includeRetired: true })).map((item) => item.name)).toEqual([
        "peer",
        "release",
      ]);
      expect(await store.findTagByName("release")).toBeUndefined();
      await expect(store.bindTagWorkerHost(tag.id, "host-a")).rejects.toThrow("retired");
      await expect(
        store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: route.surfaceAccountId,
          scope: "channel:other",
        }),
      ).rejects.toThrow("retired");
      await expect(store.assignRole({ roleId: role.id, tagId: tag.id })).rejects.toThrow();
      await expect(store.setTagMessagingGrants(peer.id, [tag.id])).rejects.toThrow("Active Tag");

      // The name is free: a new Tag gets a new id, and name lookups prefer it.
      const successor = await store.createTag({ name: "release" });
      expect(successor.id).not.toBe(tag.id);
      expect(await store.findTagByName("release", { includeRetired: true })).toMatchObject({
        id: successor.id,
        status: "active",
      });
      await expect(store.createTag({ name: "release" })).rejects.toThrow("already exists");
      await store.retireTag(successor.id);
      // With two retired Tags of one name, the latest retirement answers.
      expect(await store.findTagByName("release", { includeRetired: true })).toMatchObject({
        id: successor.id,
      });
    });

    it("refuses to retire a Tag with open Tasks", async () => {
      const store = await fixture();
      const tag = await store.createTag({ name: "busy" });
      const task = await openTask(store, tag.id, tag.name);
      await expect(store.retireTag(tag.id)).rejects.toThrow(`open Task ${task.id}`);
      expect(await store.findTagById(tag.id)).toMatchObject({ status: "active" });
      expect(await store.listTagRoutes({ tagId: tag.id })).toHaveLength(1);
    });

    it("gives a retired Tag no work, messages, Teams, or Auth Key joins", async () => {
      const store = await fixture();
      const lead = await store.createTag({ name: "lead" });
      const retired = await store.createTag({ name: "gone" });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: lead.id,
        outcome: "Ship.",
      });
      await store.setTagMessagingGrants(retired.id, [lead.id]);
      await store.createAuthKey({
        name: "joins-gone",
        tagIds: [retired.id],
        reusable: true,
        ephemeral: false,
        lookupId: "0123456789abcdef",
        secretDigest: "a".repeat(64),
        createdAt: new Date().toISOString(),
      });
      await store.retireTag(retired.id);

      await expect(
        store.createObjective({ id: randomUUID(), ownerTagId: retired.id, outcome: "Ship." }),
      ).rejects.toThrow("Active Tag");
      await expect(
        store.deliverTagMessage({
          senderTagId: lead.id,
          recipientTagId: retired.id,
          objectiveId: objective.id,
          text: "hello",
          hops: 0,
        }),
      ).rejects.toThrow("Active Tag");
      expect(await store.mayMessage(lead.id, retired.id)).toBe(false);
      await expect(
        store.createTeam({
          id: randomUUID(),
          name: `Team ${randomUUID()}`,
          memberTagIds: [retired.id],
          maxConcurrency: 1,
        }),
      ).rejects.toThrow("Active Tag");
      await expect(
        store.createAuthKey({
          name: "joins-gone-again",
          tagIds: [retired.id],
          reusable: true,
          ephemeral: false,
          lookupId: "fedcba9876543210",
          secretDigest: "b".repeat(64),
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow("must exist");
    });

    it("records declared Objectives and prunes them by cancelling, before their owner Tag", async () => {
      const store = await fixture();
      const owner = await store.createTag({ name: "keeper" });
      await store.createObjective({ id: "upkeep", ownerTagId: owner.id, outcome: "Keep it." });
      await store.createObjective({ id: "done", ownerTagId: owner.id, outcome: "Finish." });
      await store.saveResourceManagement({
        kind: "Tag",
        name: "keeper",
        applySet: "ops",
        fields: {},
      });
      for (const name of ["upkeep", "done"])
        await store.saveResourceManagement({
          kind: "Objective",
          name,
          applySet: "ops",
          fields: {
            "spec.outcome": { manager: "ops", value: "Keep it." },
            "spec.team": {
              manager: "ops",
              value: { name: "crew", members: ["keeper"], maxConcurrency: 1 },
            },
          },
        });
      expect(await store.findResourceManagement("Objective", "upkeep")).toMatchObject({
        applySet: "ops",
        fields: { "spec.team": { manager: "ops" } },
      });
      const done = await store.getObjective("done");
      await store.updateObjectiveStatus("done", {
        status: "completed",
        completionSummary: "Finished.",
        expectedRevision: done.revision,
      });
      const cancelled: string[] = [];
      const cancelObjective = async (id: string) => {
        cancelled.push(id);
        await store.cancelObjective(id, {}, { operatorId: "operator" });
      };
      // A dry run counts the Objective it would cancel as closed, so the owner Tag can go too.
      expect(
        await pruneApplySet(store, { applySet: "ops", keep: [], dryRun: true, cancelObjective }),
      ).toEqual([
        {
          kind: "Objective",
          name: "done",
          action: "skip",
          reason: "already completed; it leaves the set",
        },
        { kind: "Objective", name: "upkeep", action: "cancel" },
        { kind: "Tag", name: "keeper", action: "delete" },
      ]);
      expect(cancelled).toEqual([]);
      expect((await store.getObjective("upkeep")).status).toBe("working");
      await pruneApplySet(store, { applySet: "ops", keep: [], dryRun: false, cancelObjective });
      expect(cancelled).toEqual(["upkeep"]);
      expect((await store.getObjective("upkeep")).status).toBe("cancelled");
      expect(await store.findTagByName("keeper")).toBeUndefined();
      expect(await store.listApplySetMembers("ops")).toEqual([]);
    });

    it("lists open Objectives and deletes Workspaces", async () => {
      const store = await fixture();
      const owner = await store.createTag({ name: "owner" });
      await store.applyWorkspace({ name: "api", delivery: "branch" });
      const open = await store.createObjective({
        id: "open",
        ownerTagId: owner.id,
        outcome: "Ship.",
        workspaces: ["api"],
      });
      await store.createObjective({ id: "cancelled", ownerTagId: owner.id, outcome: "Stop." });
      await store.cancelObjective("cancelled", {}, { operatorId: "operator" });
      expect((await store.listOpenObjectives()).map((objective) => objective.id)).toEqual([
        open.id,
      ]);
      expect(await store.deleteWorkspace("api")).toBe(true);
      expect(await store.deleteWorkspace("api")).toBe(false);
      expect(await store.findWorkspaceByName("api")).toBeUndefined();
      // The Objective keeps the name it recorded.
      expect((await store.getObjective(open.id)).workspaces).toEqual(["api"]);
    });
  });
}
