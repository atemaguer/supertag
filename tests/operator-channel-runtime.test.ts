import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SurfaceAccount } from "@supertag/core";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { createOperatorNotificationSender } from "../apps/cli/src/gateway-surfaces.js";
import { parseOperatorChannel } from "../packages/control-plane/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

async function withRuntime(
  operatorChannel: string | undefined,
  run: (context: {
    readonly url: string;
    readonly send: ReturnType<typeof vi.fn>;
    readonly ownerId: string;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "supertag-operator-channel-runtime-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
  try {
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    const owner = await store.createTag({ name: "Channel owner" });
    await store.bindTagWorkerHost(owner.id, "control-plane-static-host");
    await store.createObjective({
      id: "channel-objective",
      ownerTagId: owner.id,
      outcome: "Tell the operator",
    });
    await store.createTeam({
      id: "channel-team",
      objectiveId: "channel-objective",
      name: "Channel Team",
      leadTagId: owner.id,
      memberTagIds: [],
      maxConcurrency: 1,
    });
    await store.disconnect();
    const send = vi.fn(async () => ({ externalMessageId: "1.0" }));
    runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: "channel-admin",
      ...(operatorChannel ? { operatorChannel } : {}),
      operatorNotificationSender: send,
    });
    await run({ url: runtime.url, send, ownerId: owner.id });
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function holdTaskForApproval(url: string, ownerId: string) {
  const response = await fetch(`${url}/api/v1/coordination/assign_task`, {
    method: "POST",
    headers: { authorization: "Bearer channel-admin", "content-type": "application/json" },
    body: JSON.stringify({
      objectiveId: "channel-objective",
      taskId: "held-task",
      teamId: "channel-team",
      assignedTagId: ownerId,
      instruction: "Private instruction",
      acceptanceCriteria: ["Approved"],
      requiresApproval: true,
    }),
  });
  expect(response.status, await response.text()).toBe(200);
}

it("tells the configured operator channel about a CLI Objective's held Task", async () => {
  await withRuntime("slack:C0OPS", async ({ url, send, ownerId }) => {
    await holdTaskForApproval(url, ownerId);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [destination, text] = send.mock.calls[0] as unknown as [unknown, string];
    expect(destination).toEqual(parseOperatorChannel("slack:C0OPS"));
    expect(text).toContain("Objective channel-objective needs you: Task held-task is held");
    expect(text).toMatch(/`supertag describe objective channel-objective`$/u);
    expect(text).not.toContain("Private instruction");
    await vi.waitFor(async () => {
      const response = await fetch(`${url}/api/v1/coordination/inbox`, {
        headers: { authorization: "Bearer channel-admin" },
      });
      const page = (await response.json()) as {
        items: Array<{ notification?: { status: string; reason?: string } }>;
      };
      expect(page.items[0]?.notification).toEqual({ status: "delivered", reason: "via slack" });
    });
    // Later sweeps do not send it again.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(send).toHaveBeenCalledTimes(1);
  });
}, 30_000);

it("leaves the inbox idle and scans promptly after an assignment changes it", async () => {
  const scan = vi.spyOn(DrizzleStore.prototype, "readCoordinationInbox");
  try {
    await withRuntime("slack:C0OPS", async ({ url, send, ownerId }) => {
      await vi.waitFor(() => expect(scan).toHaveBeenCalled());
      scan.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(scan.mock.calls.filter(([input]) => input?.includeNotices)).toHaveLength(0);
      await holdTaskForApproval(url, ownerId);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(scan.mock.calls.some(([input]) => input?.includeNotices)).toBe(true);
    });
  } finally {
    scan.mockRestore();
  }
}, 30_000);

it("sends nothing when no operator channel is configured", async () => {
  await withRuntime(undefined, async ({ url, send, ownerId }) => {
    await holdTaskForApproval(url, ownerId);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(send).not.toHaveBeenCalled();
    const response = await fetch(`${url}/api/v1/coordination/inbox`, {
      headers: { authorization: "Bearer channel-admin" },
    });
    const page = (await response.json()) as { items: Array<{ notification?: { status: string } }> };
    expect(page.items[0]?.notification?.status).toBe("not configured");
  });
}, 30_000);

it("refuses an invalid operator channel at startup", async () => {
  await expect(
    startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: "file::memory:",
      adminToken: "channel-admin",
      operatorChannel: "slack:#ops",
    }),
  ).rejects.toThrow(/SUPERTAG_OPERATOR_CHANNEL/u);
});

it("posts through the enrolled Slack Surface Account as a top-level message", async () => {
  const account = (id: string, workspace: string): SurfaceAccount => ({
    id,
    provider: "slack",
    externalAccountId: workspace,
    displayName: workspace,
    authMethod: "slack-socket-mode",
    credentialId: `credential-${id}`,
    status: "connected",
    configuration: {},
    verifiedAt: "2026-09-30T00:00:00.000Z",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  });
  const accounts = [account("a", "T0ONE")];
  const store = {
    listSurfaceAccounts: async () => accounts,
    findSurfaceAccount: async (_provider: string, workspace: string) =>
      accounts.find((candidate) => candidate.externalAccountId === workspace),
  };
  const vault = {
    resolve: async (id: string) => ({ botToken: `xoxb-${id}` }),
    store: async () => {},
    delete: async () => {},
  };
  const request = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, ts: "171.1" })),
  );
  const send = createOperatorNotificationSender(store, vault, request as typeof fetch);
  expect(await send(parseOperatorChannel("slack:U0PERSON"), "Needs you: `supertag x`")).toEqual({
    externalMessageId: "171.1",
  });
  const [url, init] = request.mock.calls[0] ?? [];
  expect(url).toBe("https://slack.com/api/chat.postMessage");
  expect((init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
    "Bearer xoxb-credential-a",
  );
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({ channel: "U0PERSON", text: "Needs you: `supertag x`" });
  expect(body.thread_ts).toBeUndefined();

  accounts.push(account("b", "T0TWO"));
  await expect(send(parseOperatorChannel("slack:C0OPS"), "x")).rejects.toThrow(
    /slack:WORKSPACE_ID\/TARGET/u,
  );
  await send(parseOperatorChannel("slack:T0TWO/C0OPS"), "x");
  expect(
    (request.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined)?.["authorization"],
  ).toBe("Bearer xoxb-credential-b");
  await expect(send(parseOperatorChannel("slack:T0NONE/C0OPS"), "x")).rejects.toThrow(
    /No Slack Surface Account/u,
  );
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: false, error: "not_in_channel" })),
  );
  await expect(send(parseOperatorChannel("slack:T0ONE/C0OPS"), "x")).rejects.toThrow(
    /not_in_channel/u,
  );
});
