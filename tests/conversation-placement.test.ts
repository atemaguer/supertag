import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import { runTagConversationCommand } from "../apps/cli/src/tag-conversation.js";
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

it("tells a CLI conversation once why its turn waits, then answers", async () => {
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
    const output: string[] = [];
    const conversation = runTagConversationCommand(
      { url: runtime.url, token: "waiting-admin" },
      ["waiter", "Hello"],
      { intervalMs: 20, timeoutMs: 15_000, write: (text) => output.push(text) },
    );
    await vi.waitFor(() => expect(output.join("")).toContain("· waiting:"), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [pending] = await store.listTasks({ tagId: tag.id });
    const described = await runResourceCommand(
      new ControlPlaneClient({ url: runtime.url, token: "waiting-admin" }),
      "describe",
      ["task", pending?.id ?? ""],
    );
    expect(described).toContain("Waiting: no bound Worker Host has labels gpu.");
    expect(
      (await store.listTaskEvents(pending?.id ?? "")).filter(
        (event) => event.type === "task.scheduling-incompatible",
      ),
    ).toHaveLength(1);
    await store.setTagRunsOn(tag.id, []);
    await conversation;
    const shown = output.join("");
    expect(shown).toContain("· waiting: no bound Worker Host has labels gpu\n");
    expect(shown.split("· waiting:")).toHaveLength(2);
    expect(shown).toContain("Hi.");
  } finally {
    await runtime.close();
    await store.disconnect();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
