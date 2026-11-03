import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  emptyTagContextPlan,
  type InboundSurfaceEvent,
  narrowObjectiveWorkspaces,
  type SurfaceTagAuthorizationSnapshot,
  workspacesForGitHubRepository,
} from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];

describe("Workspace matching for new Objectives", () => {
  it("matches GitHub sources in https, ssh, and scp forms, with or without .git, ignoring case", () => {
    const workspaces = [
      { name: "https", source: "https://github.com/Acme/App.git" },
      { name: "plain", source: "https://github.com/acme/app" },
      { name: "slash", source: "https://github.com/acme/app/" },
      { name: "scp", source: "git@github.com:ACME/app.git" },
      { name: "ssh", source: "ssh://git@github.com/acme/APP" },
      { name: "other", source: "https://github.com/acme/application.git" },
      { name: "fork", source: "https://github.com/someone/app.git" },
      { name: "gitlab", source: "https://gitlab.com/acme/app.git" },
      { name: "local" },
    ];
    expect(workspacesForGitHubRepository(workspaces, "acme/app")).toEqual([
      "https",
      "plain",
      "slash",
      "scp",
      "ssh",
    ]);
    expect(workspacesForGitHubRepository(workspaces, "ACME/App")).toHaveLength(5);
    expect(workspacesForGitHubRepository(workspaces, "not-a-repository")).toEqual([]);
  });

  it("narrows to a subset and rejects names outside the allowed Workspaces", () => {
    expect(narrowObjectiveWorkspaces(["app", "docs"], undefined, "Parent")).toEqual([
      "app",
      "docs",
    ]);
    expect(narrowObjectiveWorkspaces(["app", "docs"], ["docs"], "Parent")).toEqual(["docs"]);
    expect(narrowObjectiveWorkspaces(["app"], [], "Parent")).toEqual([]);
    expect(() => narrowObjectiveWorkspaces(["app"], ["app", "infra"], "Parent")).toThrow(
      "Parent attaches only Workspaces app; infra is not among them",
    );
    expect(() => narrowObjectiveWorkspaces([], ["app"], "This slack location")).toThrow(
      "This slack location attaches no Workspaces, so this Objective cannot name app",
    );
  });
});

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} location Workspaces`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function database() {
      const directory = await mkdtemp(join(tmpdir(), "supertag-location-workspaces-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      let url = `file:${join(directory, "state.db")}`;
      if (dialect === "postgresql") {
        if (!postgres) throw new Error("Missing PostgreSQL test database");
        const isolated = await createIsolatedPostgresDatabase(postgres);
        url = isolated.url;
        cleanups.push(isolated.cleanup);
      }
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      cleanups.push(() => store.disconnect());
      await store.applyWorkspace({
        name: "app",
        source: "https://github.com/acme/app.git",
        delivery: "branch",
      });
      await store.applyWorkspace({
        name: "api",
        source: "git@github.com:Acme/App",
        delivery: "branch",
      });
      await store.applyWorkspace({ name: "docs", delivery: "patch" });
      return store;
    }

    /** A verified human surface Task that carries `@SuperTag objective ...`. */
    async function surface(
      store: DrizzleStore,
      provider: "github" | "slack",
      options: {
        readonly workspaces?: readonly string[];
        readonly text?: string;
        /** What the Control Plane composed from the Tag's Roles and this location's activations. */
        readonly runtime?: Pick<SurfaceTagAuthorizationSnapshot, "runtimeActions" | "approvals">;
      } = {},
    ) {
      const at = new Date().toISOString();
      const tag = await store.createTag({ name: `lead-${randomUUID().slice(0, 8)}` });
      const account = await store.saveSurfaceAccount({
        provider,
        externalAccountId: randomUUID(),
        displayName: "Fixture",
        authMethod: "simulation",
        credentialId: randomUUID(),
        status: "connected",
        configuration: {},
        verifiedAt: at,
      });
      const scope = provider === "slack" ? "channel:C1" : "repository:42";
      const route = await store.addTagRoute({
        tagId: tag.id,
        surfaceAccountId: account.id,
        scope,
      });
      if (options.workspaces) await store.setTagRouteWorkspaces(route.id, options.workspaces);
      const event: InboundSurfaceEvent = {
        eventId: randomUUID(),
        logicalEventId: randomUUID(),
        provider,
        externalAccountId: account.externalAccountId,
        kind: "mention",
        scope,
        sessionKey: randomUUID(),
        actor: { id: "person", kind: "user" },
        text: options.text ?? "@SuperTag objective Ship the search page",
        occurredAt: at,
        callback:
          provider === "slack"
            ? {
                provider: "slack",
                mode: "slack_thread",
                threadKey: "T1|C1|1.000",
                target: { channelId: "C1", threadTs: "1.000" },
              }
            : {
                provider: "github",
                mode: "github_issue_comment",
                threadKey: "ACME/app#7",
                target: { repository: "ACME/app", number: "7" },
              },
        source: {},
        metadata: {},
      };
      const authorization: SurfaceTagAuthorizationSnapshot = {
        version: 5,
        capturedAt: at,
        tag: { id: tag.id, name: tag.name },
        origin: {
          tagRouteId: route.id,
          surfaceAccountId: account.id,
          provider,
          scope,
        },
        requester: event.actor,
        permissionSets: [],
        resources: [],
        runtimeActions: ["files:write"],
        ...options.runtime,
      };
      const contextPlan = emptyTagContextPlan(at);
      const admitted = await store.admitInboundEvent({
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        tagId: tag.id,
        authorization,
        contextPlan,
        event,
      });
      const session = await store.openSession({
        tagId: tag.id,
        sessionKey: event.sessionKey,
        origin: { provider, scope },
        at,
      });
      const task = await store.openTask({
        inboundEventId: admitted.work.id,
        tagId: tag.id,
        sessionId: session.id,
        execution: { profile: { id: "default", revision: "1" } },
        actor: event.actor,
        trigger: { kind: "mention" },
        workspacePlan: { version: 1, status: "none" },
        sessionHistory: [],
        authorizationSnapshot: authorization,
        contextPlan,
        createdAt: at,
      });
      await store.claimDueInboundEvent({
        inboundEventId: admitted.work.id,
        leaseOwner: "location-workspaces",
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
      });
      await store.startTask({ taskId: task.id, startedAt: at });
      const attempt = await store.createTaskAttempt({
        workerProfile: { id: "default", revision: "1" },
        taskId: task.id,
        attemptNumber: 1,
        workerSnapshot: { kind: "test" },
        startedAt: at,
      });
      const running = await store.findTaskById(task.id);
      if (!running) throw new Error("Missing Task");
      const controller = new ObjectiveController(store, undefined);
      controller.activateCoordination({ url: "http://127.0.0.1:3434" });
      const capability = await controller.surfaceCoordination(running, attempt);
      const caller = await controller.authenticate(capability.token);
      const create = (input: Record<string, unknown> = {}) =>
        controller.command(
          "create_objective",
          { outcome: "Ship the search page", ...input },
          caller,
        ) as Promise<{
          id: string;
          workspaces: string[];
          runtimeActions: string[];
          warnings: string[];
        }>;
      const start = () =>
        controller.command("start_objective", {}, caller) as Promise<{ taskId: string }>;
      return { tag, route, task: running, create, start };
    }

    it("gives an Objective created from a location the runtime actions its Tag may use there", async () => {
      const store = await database();
      // Roles allow commands:execute; this location's activation allows files:write, gated.
      const f = await surface(store, "slack", {
        runtime: {
          runtimeActions: ["commands:execute", "files:write"],
          approvals: [
            {
              target: "runtime",
              action: "files:write",
              permissionSets: ["location-writes"],
              approvers: [],
            },
          ],
        },
      });
      await store.bindTagWorkerHost(f.tag.id, "laptop");
      const objective = await f.create();
      expect(objective.runtimeActions).toEqual(["commands:execute", "files:write"]);
      expect(objective.warnings.join("\n")).not.toContain("runtime actions");
      // The owner's start Task inherits both, and the location's approval still holds it.
      const started = await f.start();
      const task = await store.findTaskById(started.taskId);
      expect(task?.authorizationSnapshot.runtimeActions).toEqual([
        "commands:execute",
        "files:write",
      ]);
      expect(task?.authorizationSnapshot.approvals).toEqual([
        expect.objectContaining({ target: "runtime", action: "files:write" }),
      ]);
      expect((await store.getTaskAssignment(started.taskId))?.approval).toBe("pending");
    });

    it("warns when the Tag may use no runtime actions at the location", async () => {
      const store = await database();
      const f = await surface(store, "slack", { runtime: { runtimeActions: [] } });
      const objective = await f.create();
      expect(objective.runtimeActions).toEqual([]);
      expect(objective.warnings).toContainEqual(
        `Owner Tag ${f.tag.name}'s Permission Sets allow no runtime actions; its Tasks cannot edit files or run commands. Grant files:write or commands:execute in a Permission Set on one of the Tag's Roles.`,
      );
    });

    it("stores, validates, lists, and forgets a location's Workspaces", async () => {
      const store = await database();
      const { route } = await surface(store, "slack");
      expect(route.workspaces).toEqual([]);
      const updated = await store.setTagRouteWorkspaces(route.id, ["docs", "app"]);
      expect(updated.workspaces).toEqual(["docs", "app"]);
      expect((await store.findTagRouteById(route.id))?.workspaces).toEqual(["docs", "app"]);
      await expect(store.setTagRouteWorkspaces(route.id, ["ghost"])).rejects.toThrow(
        "Workspace ghost does not exist",
      );
      await expect(store.setTagRouteWorkspaces(route.id, ["Bad Name"])).rejects.toThrow(
        "lowercase letters",
      );
      await expect(store.setTagRouteWorkspaces(randomUUID(), ["app"])).rejects.toThrow(
        "does not exist",
      );
      const other = await surface(store, "slack");
      await store.setTagRouteWorkspaces(other.route.id, ["app"]);
      expect((await store.listLocationsReferencingWorkspace("app")).map((item) => item.id)).toEqual(
        [route.id, other.route.id],
      );
      expect(
        (await store.listLocationsReferencingWorkspace("docs")).map((item) => item.id),
      ).toEqual([route.id]);
      expect(await store.listLocationsReferencingWorkspace("api")).toEqual([]);
      await store.removeTagRoute(route.id);
      expect(
        (await store.listLocationsReferencingWorkspace("docs")).map((item) => item.id),
      ).toEqual([]);
      await store.setTagRouteWorkspaces(other.route.id, []);
      expect(await store.listLocationsReferencingWorkspace("app")).toEqual([]);
    });

    it("gives an Objective created from a Slack location that location's Workspaces", async () => {
      const store = await database();
      const f = await surface(store, "slack", { workspaces: ["docs", "app"] });
      await store.bindTagWorkerHost(f.tag.id, "laptop");
      const objective = await f.create();
      expect(objective.workspaces).toEqual(["docs", "app"]);
      expect((await store.getObjective(objective.id)).workspaces).toEqual(["docs", "app"]);
      // The Runnable condition covers the location's Workspaces too.
      expect(objective.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("declares a checkout of Workspace docs"),
          expect.stringContaining("declares a checkout of Workspace app, can clone it"),
        ]),
      );
      // A retry of the same command returns the same Objective.
      expect((await f.create()).id).toBe(objective.id);
    });

    it("lets the Tag name a subset of the location's Workspaces and rejects others", async () => {
      const store = await database();
      const f = await surface(store, "slack", { workspaces: ["app", "docs"] });
      await expect(f.create({ workspaces: ["api"] })).rejects.toMatchObject({
        statusCode: 400,
        message: "This slack location attaches only Workspaces app, docs; api is not among them",
      });
      expect((await f.create({ workspaces: ["docs"] })).workspaces).toEqual(["docs"]);

      const bare = await surface(store, "slack");
      await expect(bare.create({ workspaces: ["app"] })).rejects.toMatchObject({
        statusCode: 400,
        message: "This slack location attaches no Workspaces, so this Objective cannot name app",
      });
      expect((await bare.create()).workspaces).toEqual([]);
    });

    it("matches Workspaces by repository for GitHub, unless the location names its own", async () => {
      const store = await database();
      const matched = await surface(store, "github");
      expect((await matched.create()).workspaces).toEqual(["api", "app"]);

      const explicit = await surface(store, "github", { workspaces: ["docs"] });
      expect((await explicit.create()).workspaces).toEqual(["docs"]);

      const narrowed = await surface(store, "github");
      expect((await narrowed.create({ workspaces: ["app"] })).workspaces).toEqual(["app"]);
      const refused = await surface(store, "github");
      await expect(refused.create({ workspaces: ["docs"] })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("still refuses to create an Objective without the explicit command", async () => {
      const store = await database();
      const f = await surface(store, "slack", {
        workspaces: ["app"],
        text: "please work on app",
      });
      await expect(f.create()).rejects.toMatchObject({ statusCode: 403 });
    });
  });
}
