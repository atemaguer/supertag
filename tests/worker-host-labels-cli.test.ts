import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthKeyCommand } from "../apps/cli/src/auth-keys.js";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { authKeyView } from "../apps/cli/src/host-protos.ts";
import { main } from "../apps/cli/src/index.js";
import { hostClient } from "../apps/cli/src/operator-client.ts";
import {
  getAuthKeyResource,
  getWorkerHostResource,
  listWorkerHostResources,
} from "../apps/cli/src/operator-resources.ts";
import { runResourceCommand } from "../apps/cli/src/resources.js";
import * as worker from "../apps/cli/src/worker.js";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.js";
import { WorkletConnection } from "../packages/runtime/transport/src/index.js";
import { FileGatewayCredentialVault } from "../packages/store/src/index.js";
import { migrateSqlite } from "./support/database.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { fakeOperatorRpc } from "./support/fake-operator-rpc.ts";
import { fakeWorkRpc } from "./support/fake-work-rpc.ts";
import { applyManifests, getResource } from "./support/resources.ts";

const CONTROL_PLANE = "https://control.example.com";

describe("Worker Host label commands", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("sends --label on create auth-key and reports the granted labels", async () => {
    const rpc = fakeOperatorRpc({
      "HostService/CreateAuthKey": () => ({
        authKey: {
          metadata: { name: "gpu-pool" },
          tags: ["trainer"],
          labels: ["gpu", "team:ml"],
          reusable: true,
          phase: "AUTH_KEY_PHASE_ACTIVE",
          expiresAt: "2026-12-29T00:00:00Z",
        },
        secret: `stak_${"b".repeat(64)}`,
      }),
    });
    const client = { operator: { url: CONTROL_PLANE, token: "admin" } };
    const output = await runAuthKeyCommand(
      client,
      "create",
      ["gpu-pool", "--tag", "trainer", "--label", "GPU", "--label", "team:ml", "--reusable"],
      CONTROL_PLANE,
    );
    expect(rpc.called("HostService/CreateAuthKey")[0]?.body).toMatchObject({
      labels: ["gpu", "team:ml"],
    });
    expect(output).toContain("Hosts that join with it get labels gpu, team:ml.");
    await expect(
      runAuthKeyCommand(
        client,
        "create",
        ["bad", "--tag", "trainer", "--label", "no spaces"],
        CONTROL_PLANE,
      ),
    ).rejects.toThrow("--label entry");
    await expect(
      runAuthKeyCommand(
        client,
        "create",
        ["bad-mcp", "--tag", "trainer", "--label", "MCP:github"],
        CONTROL_PLANE,
      ),
    ).rejects.toThrow("mcp: labels come from host service configuration");
  });

  it("passes --label to connect worklet and documents labels in help", async () => {
    const run = vi.spyOn(worker, "runWorkletCommand").mockResolvedValue();
    await main([
      "connect",
      "worklet",
      "--worklet-url",
      "ws://127.0.0.1:3434/worklets",
      "--label",
      "gpu",
      "--label",
      "rack:b",
    ]);
    expect(run.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["--label", "gpu", "rack:b"]));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["--help"])).toBe(0);
    const help = write.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("[--label LABEL ...] [--reusable] [--ephemeral]");
    expect(help).toContain("[--workspace [NAME=]PATH ...] [--label LABEL ...]");
    expect(help).toContain("runsOn");
  });

  it("applies, exports, and describes runsOn, and shows host and key labels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-label-cli-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.db");
    await migrateSqlite(databasePath);
    const token = "label-admin";
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      workletTransport: "remote",
      adminToken: token,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      reply: async () => {},
    });
    cleanups.push(() => runtime.close());
    const client = new ControlPlaneClient({ url: runtime.url, token });
    const manifest = join(directory, "tag.yaml");
    const writeTag = (runsOn: string) =>
      writeFile(
        manifest,
        [
          "apiVersion: supertag/v1",
          "kind: Tag",
          "metadata:",
          "  name: trainer",
          "spec:",
          `  runsOn: ${runsOn}`,
          "",
        ].join("\n"),
      );

    await writeTag("[GPU, linux]");
    await runResourceCommand(client, "apply", ["-f", manifest]);
    const tag = await getResource(client, "tags", "trainer");
    expect(tag.spec["runsOn"]).toEqual(["gpu", "linux"]);
    expect(await runResourceCommand(client, "diff", ["-f", manifest])).toContain("No changes.");
    const exported = await runResourceCommand(client, "get", [
      "tag",
      "trainer",
      "--output",
      "yaml",
    ]);
    expect(exported).toMatch(/runsOn:\n\s+- gpu\n\s+- linux/u);
    const described = await runResourceCommand(client, "describe", ["tag", "trainer"]);
    expect(described).toContain("Runs on labels: gpu, linux");
    expect(described).toContain("runsOn labels only choose among them");
    await writeTag("[gpu]");
    expect(await runResourceCommand(client, "diff", ["-f", manifest])).toContain(
      "spec.runsOn: - linux",
    );
    await writeTag('["not valid"]');
    await expect(runResourceCommand(client, "apply", ["-f", manifest])).rejects.toThrow(
      "is invalid",
    );

    expect(
      await runAuthKeyCommand(
        client,
        "create",
        ["trainer-pool", "--tag", "trainer", "--label", "gpu", "--reusable"],
        runtime.url,
      ),
    ).toContain("Hosts that join with it get labels gpu.");
    const key = await getAuthKeyResource(client.operator, "trainer-pool");
    expect(key.spec.labels).toEqual(["gpu"]);
  });

  it("grants key labels to joined hosts and lists advertised labels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-label-hosts-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.db");
    await migrateSqlite(databasePath);
    const token = "label-admin";
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      workletTransport: "remote",
      adminToken: token,
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
      reply: async () => {},
    });
    cleanups.push(() => runtime.close());
    const client = new ControlPlaneClient({ url: runtime.url, token });
    await applyManifests(client, [
      {
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "trainer" },
        spec: {},
      },
    ]);
    const hosts = hostClient(client.operator);
    const created = await hosts.createAuthKey({
      name: "gpu-pool",
      tags: ["trainer"],
      labels: ["GPU", "team:ml"],
      reusable: true,
    });
    const issued = { secret: created.secret, ...authKeyView(created.authKey as never) };
    expect(issued.spec).toEqual({
      tags: ["trainer"],
      labels: ["gpu", "team:ml"],
      reusable: true,
      ephemeral: false,
    });
    await expect(
      hosts.createAuthKey({ name: "bad-labels", tags: ["trainer"], labels: ["no spaces"] }),
    ).rejects.toThrow("is invalid");
    const joined = await hostClient({ url: runtime.url, token: issued.secret }).joinWorkerHost({
      name: "gpu-1",
    });
    const worklet = new LocalWorklet("gpu-1-worklet", "gpu-1", [new StaticWorker()], {
      labels: ["rack:b"],
    });
    const connection = new WorkletConnection({
      url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
      credential: joined.credential?.token ?? "",
      worklet,
      durableWorklet: durableTestWorklet(worklet),
      reconnectIntervalMs: 5,
    });
    cleanups.push(() => connection.stop());
    await connection.start();
    const status = async () => (await getWorkerHostResource(client.operator, "gpu-1")).status;
    await expect.poll(async () => (await status()).labels).toContain("rack:b");
    expect((await status()).grantedLabels).toEqual(["gpu", "team:ml"]);
    expect((await status()).labels).toEqual(expect.arrayContaining(["gpu", "team:ml", "rack:b"]));
    const listed = await listWorkerHostResources(client.operator);
    expect(listed.items[0]?.status.labels).toContain("rack:b");
    const described = await runResourceCommand(client, "describe", ["worker-host", "gpu-1"]);
    expect(described).toMatch(/Labels: .*rack:b/u);
    expect(described).toContain("Granted by Auth Key gpu-pool: gpu, team:ml");
    expect(described).toContain("self-reported and never grant access");
  });

  it("explains a label hold in describe task", async () => {
    const task = {
      apiVersion: "supertag/v1",
      kind: "Task",
      metadata: { id: "task-1" },
      spec: { tagId: "tag", sessionId: "session" },
      status: {
        phase: "pending",
        scheduling: {
          status: "incompatible",
          observedAt: "2026-09-30T00:00:00.000Z",
          unmetRequirements: ["labels:macos,gpu,workspace:app"],
        },
      },
    };
    fakeWorkRpc([task]);
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    const text = await runResourceCommand(client, "describe", ["task", "task-1"]);
    expect(text).toContain("Unmet requirements: labels:macos,gpu,workspace:app");
    expect(text).toContain("No bound Worker Host has labels: macos, gpu, workspace:app.");
    expect(text).toContain("Connect a Worker Host on macos and bind it to this Tag.");
    expect(text).toContain("supertag connect worklet --workspace app=PATH");
    expect(text).toContain("supertag connect worklet --label gpu");
  });

  it("names the missing MCP server in describe task", async () => {
    const task = {
      apiVersion: "supertag/v1",
      kind: "Task",
      metadata: { id: "task-2" },
      spec: { tagId: "tag", sessionId: "session" },
      status: {
        phase: "pending",
        scheduling: {
          status: "incompatible",
          observedAt: "2026-10-02T00:00:00.000Z",
          unmetRequirements: ["labels:mcp:sentry"],
          reason: "no bound Worker Host provides MCP server sentry",
        },
      },
    };
    fakeWorkRpc([task]);
    const client = new ControlPlaneClient({ url: "http://127.0.0.1:1", token: "unused" });
    const text = await runResourceCommand(client, "describe", ["task", "task-2"]);
    expect(text).toContain("Waiting: no bound Worker Host provides MCP server sentry.");
    expect(text).toContain("No bound Worker Host has labels: mcp:sentry.");
    expect(text).toContain(
      "No bound Worker Host provides MCP server sentry. Add it to a host service's mcp map in supertag.yaml",
    );
    expect(text).not.toContain("--label mcp:sentry");
  });
});
