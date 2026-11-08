import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import {
  objectiveRuntimeActionWarnings,
  resolveObjectiveRuntimeActions,
  resolveOwnerObjectiveRuntimeActions,
} from "../packages/control-plane/src/index.ts";
import { objectiveAuthorization } from "../packages/control-plane/src/objective-sessions.ts";
import {
  mergeApprovalRequirements,
  type TagApprovalRequirement,
} from "../packages/core/src/index.ts";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase, migrateSqlite } from "./support/database.ts";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

/** Give a Tag a Role whose Permission Set allows these runtime actions. */
async function grantRuntimeActions(
  store: DrizzleStore,
  tagId: string,
  actions: readonly { readonly action: string; readonly approval?: "required" }[],
) {
  const set = await store.createTagPermissionSet({ name: `runtime-${randomUUID()}` });
  const permissions = [];
  for (const { action, approval } of actions)
    permissions.push(
      await store.addTagPermission({
        permissionSetId: set.id,
        target: "runtime",
        action,
        ...(approval ? { approval } : {}),
      }),
    );
  const role = await store.createRole({
    name: `Builder ${randomUUID()}`,
    purpose: "Build.",
    instructions: "Build carefully.",
    contextSetIds: [],
    permissionSetIds: [set.id],
  });
  const assignment = await store.assignRole({ roleId: role.id, tagId });
  return { set, permissions, role, assignment };
}

describe("Objective runtime action resolution", () => {
  it("defaults to the owner's actions and lets an explicit list only narrow them", () => {
    expect(resolveObjectiveRuntimeActions(["files:write", "commands:execute"])).toEqual([
      "commands:execute",
      "files:write",
    ]);
    expect(
      resolveObjectiveRuntimeActions(["commands:execute", "files:write"], ["files:write"]),
    ).toEqual(["files:write"]);
    expect(
      resolveObjectiveRuntimeActions(["files:write"], ["web:fetch", "files:write", "files:write"]),
    ).toEqual(["files:write"]);
    expect(resolveObjectiveRuntimeActions([], ["files:write"])).toEqual([]);
    expect(resolveObjectiveRuntimeActions(["files:write"], [])).toEqual([]);
  });

  it("warns about dropped actions and an owner with none", () => {
    expect(
      objectiveRuntimeActionWarnings({
        objectiveId: "ship",
        owner: { name: "builder" },
        allowed: ["files:write"],
        requested: ["files:write", "web:fetch"],
      }),
    ).toEqual([
      "Tag builder's Permission Sets do not allow web:fetch, so the Objective omits it. Grant it in a Permission Set on one of the Tag's Roles, then run: supertag update objective ship --runtime-action files:write --runtime-action web:fetch",
    ]);
    expect(
      objectiveRuntimeActionWarnings({ objectiveId: "ship", owner: { name: "b" }, allowed: [] }),
    ).toEqual([
      "Owner Tag b's Permission Sets allow no runtime actions; its Tasks cannot edit files or run commands. Grant files:write or commands:execute in a Permission Set on one of the Tag's Roles.",
    ]);
    // Narrowing within what the owner may use is not worth a warning.
    expect(
      objectiveRuntimeActionWarnings({
        objectiveId: "ship",
        owner: { name: "b" },
        allowed: ["files:write", "commands:execute"],
        requested: [],
      }),
    ).toEqual([]);
  });

  it("carries inherited runtime approval requirements and never surface ones", () => {
    const runtime = (action: string, set: string, approvers: string[] = []) =>
      ({
        target: "runtime",
        action,
        permissionSets: [set],
        approvers,
      }) satisfies TagApprovalRequirement;
    const own = [runtime("commands:execute", "mine", ["tag:a"])];
    expect(mergeApprovalRequirements(own, undefined)).toBe(own);
    expect(mergeApprovalRequirements(own, [])).toBe(own);
    expect(
      mergeApprovalRequirements(own, [
        runtime("commands:execute", "owner", ["tag:b"]),
        runtime("files:write", "owner"),
        {
          target: "surface",
          surfaceAccountId: "account",
          scope: "repository:1",
          action: "pull-requests:merge",
          permissionSets: ["owner"],
          approvers: [],
        },
      ]),
    ).toEqual([
      {
        target: "runtime",
        action: "commands:execute",
        permissionSets: ["mine", "owner"],
        approvers: ["tag:a", "tag:b"],
      },
      runtime("files:write", "owner"),
    ]);
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Objective runtime actions`,
    () => {
      const cleanups: (() => Promise<unknown> | unknown)[] = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      async function database() {
        const directory = await mkdtemp(join(tmpdir(), "supertag-objective-runtime-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        let url = `file:${join(directory, "state.db")}`;
        if (dialect === "postgresql") {
          const isolated = await createIsolatedPostgresDatabase(postgres as string);
          url = isolated.url;
          cleanups.push(isolated.cleanup);
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        return store;
      }

      it("freezes the owner's actions at creation and replaces them only by an operator update", async () => {
        const store = await database();
        const owner = await store.createTag({ name: `owner-${randomUUID()}` });
        const grant = await grantRuntimeActions(store, owner.id, [
          { action: "files:write" },
          { action: "commands:execute" },
        ]);
        const resolved = await resolveOwnerObjectiveRuntimeActions(store, {
          objectiveId: "ship",
          ownerTagId: owner.id,
        });
        expect(resolved).toEqual({
          runtimeActions: ["commands:execute", "files:write"],
          warnings: [],
        });
        const objective = await store.createObjective({
          id: "ship",
          ownerTagId: owner.id,
          outcome: "Ship it",
          runtimeActions: resolved.runtimeActions,
        });
        // Later Permission Set changes do not rewrite the recorded actions.
        await store.removeTagPermission(grant.permissions[1]?.id as string);
        expect((await store.getObjective("ship")).runtimeActions).toEqual([
          "commands:execute",
          "files:write",
        ]);
        expect(
          (
            await resolveOwnerObjectiveRuntimeActions(store, {
              objectiveId: "x",
              ownerTagId: owner.id,
            })
          ).runtimeActions,
        ).toEqual(["files:write"]);

        await expect(
          store.updateObjectiveStatus(
            "ship",
            { runtimeActions: ["files:write"], expectedRevision: objective.revision },
            owner.id,
          ),
        ).rejects.toMatchObject({
          statusCode: 403,
          message: "Only operators may change Objective runtime actions",
        });
        const updated = await store.updateObjectiveStatus(
          "ship",
          { runtimeActions: ["files:write"], expectedRevision: objective.revision },
          undefined,
          undefined,
          { operatorId: "operator:alice" },
        );
        expect(updated).toMatchObject({ runtimeActions: ["files:write"], revision: 2 });
        const changes = await store.listResourceChanges({
          resourceType: "objective",
          resourceId: "ship",
        });
        expect(changes.at(-1)?.changes).toEqual({
          runtimeActions: { previous: ["commands:execute", "files:write"], next: ["files:write"] },
        });
      });
    },
  );
}

describe("approval for inherited runtime actions", () => {
  const cleanups: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-runtime-approval-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const [owner, member] = await Promise.all(
      ["owner", "member"].map((name) => store.createTag({ name: `${name}-${randomUUID()}` })),
    );
    if (!owner || !member) throw new Error("Missing Tags");
    for (const tag of [owner, member]) await store.bindTagWorkerHost(tag.id, "fixture");
    // Only the owner has Permission Sets; commands:execute needs approval.
    await grantRuntimeActions(store, owner.id, [
      { action: "commands:execute", approval: "required" },
      { action: "files:write" },
    ]);
    const objectiveId = randomUUID();
    const { runtimeActions } = await resolveOwnerObjectiveRuntimeActions(store, {
      objectiveId,
      ownerTagId: owner.id,
    });
    const team = await store.createTeam({
      id: randomUUID(),
      name: `release-${randomUUID()}`,
      memberTagIds: [owner.id, member.id],
      maxConcurrency: 5,
    });
    const objective = await store.createObjective({
      id: objectiveId,
      ownerTagId: owner.id,
      outcome: "Release the change",
      runtimeActions,
      teamId: team.id,
    });
    const at = new Date().toISOString();
    const account = await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: randomUUID(),
      displayName: "Fixture",
      authMethod: "simulation",
      credentialId: randomUUID(),
      status: "connected",
      configuration: {},
      verifiedAt: at,
    });
    const route = await store.addTagRoute({
      tagId: owner.id,
      surfaceAccountId: account.id,
      scope: "channel:C1",
    });
    const location = {
      account,
      route,
      event: { actor: { id: "supertag", kind: "bot" as const } },
    } as Parameters<typeof objectiveAuthorization>[3];
    return { store, owner, member, objective, team, location };
  }

  it("holds the owner's turn for an action its Permission Set gates", async () => {
    const f = await fixture();
    expect(f.objective.runtimeActions).toEqual(["commands:execute", "files:write"]);
    const snapshot = await objectiveAuthorization(f.store, f.objective, f.owner, f.location);
    expect(snapshot.runtimeActions).toEqual(["commands:execute", "files:write"]);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({ target: "runtime", action: "commands:execute" }),
    ]);
  });

  it("carries the owner's requirement to a Team member's turn, directly and by delegation", async () => {
    const f = await fixture();
    // A member with no Permission Sets of its own still runs under the Objective's actions,
    // with the owner's approval requirement.
    const member = await objectiveAuthorization(f.store, f.objective, f.member, f.location);
    expect(member).toMatchObject({
      runtimeActions: ["commands:execute", "files:write"],
      approvals: [expect.objectContaining({ target: "runtime", action: "commands:execute" })],
    });
    // Delegation never widens: the starting turn's authorization is the ceiling.
    const narrowed = await objectiveAuthorization(f.store, f.objective, f.member, f.location, {
      runtimeActions: ["files:write"],
      approvals: [],
    });
    expect(narrowed.runtimeActions).toEqual(["files:write"]);
    expect(narrowed.approvals ?? []).toEqual([]);
  });
});

describe("Objective runtime action commands", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>>;
  let direct: DrizzleStore;
  let errors: string[];
  let output: string[];
  let plannerId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "supertag-objective-runtime-cli-"));
    const serverState = join(directory, "server");
    const databasePath = join(serverState, "supertag.db");
    await migrateSqlite(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
    });
    output = [];
    errors = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "client"));
    vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
    await expect(main(["connect", "control-plane", runtime.url])).resolves.toBe(0);
    const client = new ControlPlaneClient({ url: runtime.url, token });
    plannerId = (await client.createTag({ name: "planner" })).metadata.id as string;
    await client.createTag({ name: "idle" });
    direct = new DrizzleStore({ url: `file:${databasePath}` });
    await direct.connect();
  });

  afterEach(async () => {
    await direct.disconnect();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const run = async (...args: string[]) => {
    output.length = 0;
    errors.length = 0;
    await expect(main(args)).resolves.toBe(0);
    return JSON.parse(output.join("")) as { runtimeActions: string[]; revision: number };
  };
  const warnings = () =>
    errors.filter((line) => line.startsWith("Warning: ") && line.includes("runtime"));
  const create = (id: string, owner: string, ...flags: string[]) =>
    run(
      "create",
      "objective",
      id,
      "--outcome",
      "Ship it",
      "--owner",
      owner,
      ...flags,
      "--output",
      "json",
    );

  it("defaults to the owner's Role actions, narrows explicit lists, and updates later", async () => {
    const grant = await grantRuntimeActions(direct, plannerId, [
      { action: "files:write" },
      { action: "commands:execute" },
    ]);
    expect((await create("ship", "planner")).runtimeActions).toEqual([
      "commands:execute",
      "files:write",
    ]);
    expect(warnings()).toEqual([]);
    expect((await run("get", "objective", "ship")).runtimeActions).toEqual([
      "commands:execute",
      "files:write",
    ]);

    // Frozen: a retry without the flag returns the record after grants change.
    await direct.deactivateRoleAssignment(grant.assignment.id, grant.assignment.revision);
    expect((await create("ship", "planner")).runtimeActions).toEqual([
      "commands:execute",
      "files:write",
    ]);
    await grantRuntimeActions(direct, plannerId, [{ action: "files:write" }]);

    expect(
      (await create("narrow", "planner", "--runtime-action", "files:write")).runtimeActions,
    ).toEqual(["files:write"]);
    expect(warnings()).toEqual([]);
    expect(
      (
        await create(
          "wide",
          "planner",
          "--runtime-action",
          "files:write",
          "--runtime-action",
          "commands:execute",
        )
      ).runtimeActions,
    ).toEqual(["files:write"]);
    expect(warnings()).toEqual([
      "Warning: Tag planner's Permission Sets do not allow commands:execute, so the Objective omits it. Grant it in a Permission Set on one of the Tag's Roles, then run: supertag update objective wide --runtime-action files:write --runtime-action commands:execute\n",
    ]);

    // An update replaces the list, within what the owner may use now.
    const narrowed = await run(
      "update",
      "objective",
      "ship",
      "--runtime-action",
      "files:write",
      "--output",
      "json",
    );
    expect(narrowed).toMatchObject({ runtimeActions: ["files:write"], revision: 2 });
    expect(
      (
        await run(
          "update",
          "objective",
          "ship",
          "--runtime-action",
          "commands:execute",
          "--output",
          "json",
        )
      ).runtimeActions,
    ).toEqual([]);
    expect(warnings()).toEqual([
      expect.stringContaining("Tag planner's Permission Sets do not allow commands:execute"),
    ]);
  });

  it("warns when the owner's Permission Sets allow no runtime actions", async () => {
    expect((await create("idle-work", "idle")).runtimeActions).toEqual([]);
    expect(warnings()).toEqual([
      "Warning: Owner Tag idle's Permission Sets allow no runtime actions; its Tasks cannot edit files or run commands. Grant files:write or commands:execute in a Permission Set on one of the Tag's Roles.\n",
    ]);
    // A dry run reports the same.
    await run(
      "create",
      "objective",
      "--outcome",
      "Ship it",
      "--owner",
      "idle",
      "--dry-run",
      "--output",
      "json",
    );
    expect(warnings()).toHaveLength(1);
  });
});
