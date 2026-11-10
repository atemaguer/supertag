import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TagAdministration } from "../apps/cli/src/tag-administration.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";

it("administers typed Tag state without owning the store connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-administration-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const credentialVault = new FileGatewayCredentialVault({
    directory: join(directory, "credentials"),
  });
  const connect = vi.spyOn(store, "connect");
  const disconnect = vi.spyOn(store, "disconnect");
  try {
    const service = new TagAdministration(store, credentialVault);
    const tag = await service.create("Engineering");
    expect(await service.requireTag("Engineering")).toEqual(tag);
    await expect(service.create(tag.name)).rejects.toThrow(
      'A Tag named "Engineering" already exists',
    );
    await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: "T_ADMIN",
      displayName: "Workspace",
      authMethod: "slack-bot-token",
      credentialId: "fixture",
      status: "connected",
      configuration: {},
      verifiedAt: new Date().toISOString(),
    });
    const target = { provider: "slack" as const, channelId: "CADMIN" };
    const { route } = await service.addRoute(tag.name, target);
    const { contextSet } = await service.createContextSet(tag.name, "Knowledge");
    const { permissionSet } = await service.createPermissionSet(tag.name, "Access");
    await store.activateTagContextSet({ contextSetId: contextSet.id, tagRouteId: route.id });
    await service.setPermissionActivation(tag.name, permissionSet.name, target, true);
    expect(await service.list()).toEqual([
      { tag, locationCount: 1, permissionSetCount: 1, contextSetCount: 1 },
    ]);
    expect(await service.show(tag.name)).toMatchObject({
      tag,
      locations: [route],
      contextSets: [contextSet],
      permissionSets: [permissionSet],
    });
    await expect(service.deleteContextSet("Missing", contextSet.name)).rejects.toThrow(
      'Tag "Missing" does not exist',
    );
    expect(await store.findTagContextSetByName(contextSet.name)).toEqual(contextSet);
    await service.changeRuntimePermissions(tag.name, permissionSet.name, ["files:write"], true);
    // Slack tools are granted with target: mcp, so Slack has no surface actions.
    await expect(
      service.changeSurfacePermissions(
        tag.name,
        permissionSet.name,
        target,
        ["messages:send"],
        true,
      ),
    ).rejects.toThrow(
      "Unsupported slack action: messages:send. Grant tools with target: mcp instead.",
    );
    expect(
      (await service.showPermissionSet(tag.name, permissionSet.name)).permissions,
    ).toHaveLength(1);
    await service.changeRuntimePermissions(tag.name, permissionSet.name, ["files:write"], false);
    expect((await service.showPermissionSet(tag.name, permissionSet.name)).permissions).toEqual([]);
    const { item } = await service.addSkill(tag.name, contextSet.name, "research", {
      version: "1",
    });
    await service.addContextItem(tag.name, contextSet.name, {
      itemKey: "custom",
      type: "test.io/context",
      version: 1,
      required: true,
      config: {},
    });
    await service.addArtifacts(tag.name, contextSet.name, target, { maxAgeDays: 30, limit: 5 });
    expect((await service.showContextSet(tag.name, contextSet.name)).sources).toHaveLength(3);
    await service.removeContextItem(tag.name, contextSet.name, item.id);
    expect((await service.showContextSet(tag.name, contextSet.name)).sources).toHaveLength(2);
    await service.setContextActivation(tag.name, contextSet.name, target, false);
    await service.setPermissionActivation(tag.name, permissionSet.name, target, false);
    expect((await service.listContextSets(tag.name)).sets).toEqual([]);
    expect((await service.listPermissionSets(tag.name)).sets).toEqual([]);
    await service.removeRoute(tag.name, target);
    expect((await service.show(tag.name)).locations).toEqual([]);
    await service.deleteContextSet(tag.name, contextSet.name);
    await service.deletePermissionSet(tag.name, permissionSet.name);
    expect((await service.show(tag.name)).contextSets).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
    disconnect.mockRestore();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
