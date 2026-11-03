import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TagAdministration } from "../apps/cli/src/tag-administration.js";
import { renderTagOperation } from "../apps/cli/src/tag-command-adapter.js";
import { runTagCommand } from "../apps/cli/src/tags.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";

it("shares typed Tag administration across rendering adapters without owning their connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-administration-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  const credentialVault = new FileGatewayCredentialVault({
    directory: join(directory, "credentials"),
  });
  const dependencies = { store, credentialVault };
  const connect = vi.spyOn(store, "connect");
  const disconnect = vi.spyOn(store, "disconnect");
  try {
    const service = new TagAdministration(store, credentialVault);
    const created = await renderTagOperation("create", ["Engineering"], dependencies);
    const tag = await service.requireTag("Engineering");
    expect(created).toBe(`Created Tag ${tag.name} (${tag.id}).\n`);
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
    expect(await renderTagOperation("list", [], dependencies)).toBe(
      "NAME\tSTATUS\tAVAILABLE_IN\tPERMISSION_SETS\tCONTEXTS\nEngineering\tactive\t1\t1\t1\n",
    );
    let cliOutput = "";
    await runTagCommand("show", [tag.name], dependencies, {
      manageConnection: false,
      write: (text) => {
        cliOutput += text;
      },
    });
    expect(await renderTagOperation("show", [tag.name], dependencies)).toBe(cliOutput);
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
    await expect(
      renderTagOperation("add", ["Missing", "slack", "--channel-id", "CADMIN"], dependencies),
    ).rejects.toThrow('Tag "Missing" does not exist. Create it with: supertag create tag Missing');
    await expect(
      renderTagOperation("add", [tag.name, "lark", "--chat-id", "chat"], dependencies),
    ).rejects.toThrow("No connected lark account exists. Run supertag setup surface lark.");
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
