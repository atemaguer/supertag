import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { conversationClient } from "../apps/cli/src/operator-client.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import { ControlPlane } from "../packages/control-plane/src/index.js";
import {
  placeTask,
  taskPlacementLabels,
  undeclaredMcpServers,
  withoutMcpServers,
} from "../packages/control-plane/src/label-placement.js";
import { placementHoldReason } from "../packages/core/src/index.js";
import {
  LocalWorklet,
  StaticWorker,
  type TaskAttemptSpec,
} from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";

const none = { version: 1, status: "none" } as const;
const workspace = { version: 1, status: "workspace", workspace: "app", branch: "b" } as never;
const grants = { mcp: [{ action: "notes/save_note" }, { action: "github/get_issue" }] };

describe("MCP servers of a Task without a Workspace", () => {
  const hosts = [
    { id: "laptop", labels: ["mcp:github"] },
    { id: "studio", labels: ["mcp-login:slack"] },
    { id: "unbound", labels: ["mcp:notes"] },
  ];

  it("requires only servers a bound host declares; the rest are left out", async () => {
    expect(undeclaredMcpServers(grants, none, ["laptop"], hosts)).toEqual(["notes"]);
    // A server on a host that is not bound to the Tag is not declared for it.
    expect(undeclaredMcpServers(grants, none, ["laptop", "studio"], hosts)).toEqual(["notes"]);
    // A lapsed login still declares the server, so the Task waits for the login.
    expect(
      undeclaredMcpServers({ mcp: [{ action: "slack/post" }] }, none, ["studio"], hosts),
    ).toEqual([]);
    // A Task with a Workspace may get the server from the Workspace, so it goes without none.
    expect(undeclaredMcpServers(grants, workspace, ["laptop"], hosts)).toEqual([]);

    const dispatched = withoutMcpServers(grants, ["notes"]);
    expect(dispatched).toEqual({ mcp: [{ action: "github/get_issue" }] });
    expect(withoutMcpServers(grants, [])).toBe(grants);
    await expect(
      placeTask(["laptop"], taskPlacementLabels([], dispatched), none, async () =>
        hosts.map((host) => ({ ...host, enrollmentStatus: "active" as const, workerSnapshot: {} })),
      ),
    ).resolves.toMatchObject({ status: "eligible", tiers: [{ allowedWorkerHostIds: ["laptop"] }] });
  });
});

describe("placement hold reasons", () => {
  it("says in one line why a Task waits", () => {
    expect(placementHoldReason({ unmetRequirements: ["labels:mcp:notes"] })).toBe(
      "no bound Worker Host provides MCP server notes",
    );
    expect(placementHoldReason({ unmetRequirements: ["labels:gpu,mcp:notes,tpu"] })).toBe(
      "no bound Worker Host provides MCP server notes; no bound Worker Host has labels gpu, tpu",
    );
    expect(
      placementHoldReason({ unmetRequirements: ["labels:mcp:slack"], mcpLogins: ["slack"] }),
    ).toBe("MCP server slack needs a login on its Worker Host (supertag mcp login slack)");
    expect(placementHoldReason({ unmetRequirements: ["tag.workerHostBindings"] })).toBe(
      "the Tag has no Worker Host binding",
    );
    expect(placementHoldReason({ unmetRequirements: [] })).toBeUndefined();
    expect(placementHoldReason(undefined)).toBeUndefined();
  });
});

it("dispatches past a turn that cannot be placed, keeping each Session's order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-head-of-line-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const specs: TaskAttemptSpec[] = [];
  class RecordingWorker extends StaticWorker {
    override execute(spec: TaskAttemptSpec) {
      specs.push(spec);
      return super.execute(spec);
    }
  }
  /** A host whose `oauth: true` MCP server sentry needs `supertag mcp login sentry`. */
  class LapsedLoginWorklet extends LocalWorklet {
    override async describe() {
      const described = await super.describe();
      const labels = Array.isArray(described.host["labels"]) ? described.host["labels"] : [];
      return { ...described, host: { ...described.host, labels: [...labels, "mcp-login:sentry"] } };
    }
  }
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: new LapsedLoginWorklet("hol-worklet", "hol-host", [new RecordingWorker()]),
    reply: async () => {},
    dispatch: { pollIntervalMs: 5 },
  });
  try {
    await controlPlane.start();
    const account = await controlPlane.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T-HOL",
      displayName: "Head of line",
      authMethod: "slack-socket-mode",
      configuration: {},
      secrets: { botToken: "fake", appToken: "fake" },
    });
    const x = await store.createTag({ name: "Notes" });
    const y = await store.createTag({ name: "Other" });
    for (const tag of [x, y]) await store.bindTagWorkerHost(tag.id, "hol-host");
    // C1 grants a host server whose login lapsed: its turns wait for the login. C2 grants a
    // server no bound host declares, which a conversation turn goes without.
    const routes = {
      C1: await store.addTagRoute({
        tagId: x.id,
        surfaceAccountId: account.id,
        scope: "channel:C1",
      }),
      C2: await store.addTagRoute({
        tagId: x.id,
        surfaceAccountId: account.id,
        scope: "channel:C2",
      }),
      C3: await store.addTagRoute({
        tagId: y.id,
        surfaceAccountId: account.id,
        scope: "channel:C3",
      }),
    };
    for (const [channel, action] of [
      ["C1", "sentry/get_issue"],
      ["C2", "notes/save_note"],
    ] as const) {
      const set = await store.createTagPermissionSet({ name: `mcp-${channel}` });
      await store.addTagPermission({ permissionSetId: set.id, target: "mcp", action });
      await store.activateTagPermissionSet({
        permissionSetId: set.id,
        tagRouteId: routes[channel].id,
      });
    }
    const send = async (channel: string, thread: string, eventId: string) =>
      (
        await controlPlane.ingestSurfaceEvent({
          eventId,
          logicalEventId: eventId,
          provider: "slack",
          externalAccountId: "T-HOL",
          kind: "mention",
          scope: `channel:${channel}`,
          sessionKey: `slack:T-HOL:${channel}:${thread}`,
          actor: { id: "U1", kind: "user" },
          text: "Say hello",
          occurredAt: new Date().toISOString(),
          callback: {
            provider: "slack",
            mode: "slack_thread",
            threadKey: `T-HOL|${channel}|${thread}`,
            target: { channelId: channel, threadTs: thread },
          },
          source: {},
          metadata: {},
        })
      ).taskId as string;
    const held = await send("C1", "1", "held");
    const later = await send("C1", "1", "held-later");
    const notes = await send("C2", "2", "notes");
    const other = await send("C3", "3", "other");

    for (const taskId of [notes, other])
      await expect
        .poll(async () => (await store.findTaskById(taskId))?.status, { timeout: 5000 })
        .toBe("completed");
    // The notes turn ran without the absent server's grant, so it got no dangling tool.
    expect(specs.find((spec) => spec.taskId === notes)?.authorization.mcp).toEqual([]);
    expect((await store.findTaskById(notes))?.authorizationSnapshot.mcp).toEqual([
      { action: "notes/save_note" },
    ]);

    // The held turn records why, once, however many passes find it unplaceable.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await store.findTaskById(held))?.status).toBe("pending");
    const holds = (await store.listTaskEvents(held)).filter(
      (event) => event.type === "task.scheduling-incompatible",
    );
    expect(holds).toHaveLength(1);
    expect(placementHoldReason(holds[0]?.payload)).toBe(
      "MCP server sentry needs a login on its Worker Host (supertag mcp login sentry)",
    );
    // A later turn of the held Session never overtakes it.
    expect(later === undefined || (await store.findTaskById(later))?.status !== "completed").toBe(
      true,
    );
    expect(specs.map((spec) => spec.taskId)).not.toContain(held);
  } finally {
    await controlPlane.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

it("reports once why a conversation turn waits, then answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-waiting-reason-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  vi.stubEnv("SUPERTAG_STATE_DIR", join(directory, "server"));
  const runtime = await startControlPlaneRuntime({
    host: "127.0.0.1",
    port: 0,
    databaseUrl,
    adminToken: "waiting-admin",
    worklet: new LocalWorklet("wait-worklet", "wait-host", [new StaticWorker({ text: "Hi." })]),
  });
  try {
    const tag = await store.createTag({ name: "waiter" });
    await store.bindTagWorkerHost(tag.id, "wait-host");
    await store.setTagRunsOn(tag.id, ["gpu"]);
    const target = { url: runtime.url, token: "waiting-admin" };
    const client = conversationClient(target);
    const sent = await client.sendMessage({ tag: "waiter", text: "Hello" });
    const reasons: string[] = [];
    let reply: string | undefined;
    for await (const { part } of client.followMessage(
      { tag: sent.tag, taskId: sent.taskId },
      { timeoutMs: 15_000 },
    )) {
      if (part.case === "finish") {
        reply = part.value.reply?.text;
        break;
      }
      if (part.case !== "waiting") continue;
      reasons.push(part.value.reason);
      if (reasons.length !== 1) continue;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const described = await runResourceCommand(new ControlPlaneClient(target), "describe", [
        "task",
        sent.taskId,
      ]);
      expect(described).toContain("Waiting: no bound Worker Host has labels gpu.");
      expect(
        (await store.listTaskEvents(sent.taskId)).filter(
          (event) => event.type === "task.scheduling-incompatible",
        ),
      ).toHaveLength(1);
      await store.setTagRunsOn(tag.id, []);
    }
    expect(reasons).toEqual(["no bound Worker Host has labels gpu"]);
    expect(reply).toContain("Hi.");
  } finally {
    await runtime.close();
    await store.disconnect();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

/** A Control Plane on `store` with one local Worker Host, and a Slack account to send through. */
async function slackControlPlane(store: DrizzleStore, directory: string, id: string) {
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: new LocalWorklet(`${id}-worklet`, `${id}-host`, [new StaticWorker()]),
    reply: async () => {},
    dispatch: { pollIntervalMs: 5 },
  });
  await controlPlane.start();
  const account = await controlPlane.setupSurfaceAccount({
    provider: "slack",
    externalAccountId: `T-${id}`,
    displayName: id,
    authMethod: "slack-socket-mode",
    configuration: {},
    secrets: { botToken: "fake", appToken: "fake" },
  });
  const send = async (channel: string, thread: string, eventId: string) =>
    (
      await controlPlane.ingestSurfaceEvent({
        eventId,
        logicalEventId: eventId,
        provider: "slack",
        externalAccountId: `T-${id}`,
        kind: "mention",
        scope: `channel:${channel}`,
        sessionKey: `slack:T-${id}:${channel}:${thread}`,
        actor: { id: "U1", kind: "user" },
        text: "Say hello",
        occurredAt: new Date().toISOString(),
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: `T-${id}|${channel}|${thread}`,
          target: { channelId: channel, threadTs: thread },
        },
        source: {},
        metadata: {},
      })
    ).taskId as string;
  return { controlPlane, account, send };
}

it("reaches a placeable turn behind more unplaceable turns than one page holds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-many-held-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const { controlPlane, account, send } = await slackControlPlane(store, directory, "many");
  try {
    // A Tag whose runsOn labels no bound host carries: every one of its threads waits.
    const stuck = await store.createTag({ name: "Stuck" });
    const ready = await store.createTag({ name: "Ready" });
    for (const tag of [stuck, ready]) await store.bindTagWorkerHost(tag.id, "many-host");
    await store.setTagRunsOn(stuck.id, ["gpu"]);
    await store.addTagRoute({ tagId: stuck.id, surfaceAccountId: account.id, scope: "channel:S" });
    await store.addTagRoute({ tagId: ready.id, surfaceAccountId: account.id, scope: "channel:R" });
    for (let thread = 0; thread < 60; thread++) await send("S", `${thread}`, `s${thread}`);
    const answered = await send("R", "1", "ready");
    await expect
      .poll(async () => (await store.findTaskById(answered))?.status, { timeout: 10_000 })
      .toBe("completed");
    // Every waiting turn was tried, and each still waits.
    const waiting = await store.listTasks({ tagId: stuck.id, limit: 100 });
    expect(waiting).toHaveLength(60);
    expect(waiting.every((task) => task.status === "pending")).toBe(true);
  } finally {
    await controlPlane.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("ends a hold recorded before a restart once the Task can be placed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-hold-restart-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const first = await slackControlPlane(store, directory, "restart");
  const tag = await store.createTag({ name: "Gpu" });
  await store.bindTagWorkerHost(tag.id, "restart-host");
  await store.setTagRunsOn(tag.id, ["gpu"]);
  await store.addTagRoute({
    tagId: tag.id,
    surfaceAccountId: first.account.id,
    scope: "channel:G",
  });
  const taskId = await first.send("G", "1", "gpu");
  let reader = store;
  const scheduling = async () =>
    (await reader.listTaskEvents(taskId))
      .filter((event) => event.type.startsWith("task.scheduling-"))
      .map((event) => event.type);
  await expect.poll(scheduling, { timeout: 5000 }).toEqual(["task.scheduling-incompatible"]);
  await first.controlPlane.stop();
  // The next Control Plane process knows nothing of the hold the first one recorded.
  const restarted = new DrizzleStore({ url });
  await restarted.setTagRunsOn(tag.id, []);
  const second = new ControlPlane({
    store: restarted,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: new LocalWorklet("restart-worklet", "restart-host", [new StaticWorker()]),
    reply: async () => {},
    dispatch: { pollIntervalMs: 5 },
  });
  try {
    await second.start();
    reader = restarted;
    await expect
      .poll(async () => (await restarted.findTaskById(taskId))?.status, { timeout: 10_000 })
      .toBe("completed");
    expect(await scheduling()).toEqual([
      "task.scheduling-incompatible",
      "task.scheduling-compatible",
    ]);
  } finally {
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
