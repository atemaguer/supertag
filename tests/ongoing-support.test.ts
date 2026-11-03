import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
// The standalone example deliberately imports no private workspace packages.
// @ts-expect-error JavaScript example application
import { supportWorker } from "../examples/ongoing-support/application.mjs";
// @ts-expect-error JavaScript example client
import { applyReviewedPolicy, policyRequest } from "../examples/ongoing-support/policy-client.mjs";
// @ts-expect-error JavaScript example provider
import { startPolicyService } from "../examples/ongoing-support/policy-service.mjs";
// @ts-expect-error JavaScript public-API setup
import { apiClient, createOrganization } from "../examples/ongoing-support/resources.mjs";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { hostArtifactStore } from "./support/host-artifact-store.js";

it("reconciles a lost provider acknowledgement across service restart without another write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-provider-"));
  const options = {
    path: join(directory, "policy.json"),
    readToken: "reader",
    writeToken: "writer",
    dropFirstResponse: true,
  };
  let service = await startPolicyService(options);
  const proposal = {
    operationId: "support:ticket-1",
    incidentId: "ticket-1",
    expectedRevision: 1,
    responseMinutes: 30,
    sourceArtifactId: "reviewed-artifact",
    sourceDigest: `sha256:${"a".repeat(64)}`,
  };
  try {
    await expect(policyRequest(service.url, "reader", "/apply", proposal)).rejects.toThrow("403");
    await expect(policyRequest(service.url, "writer", "/apply", proposal)).rejects.toThrow();
    await service.close();
    service = await startPolicyService(options);
    const recovered = await applyReviewedPolicy(service.url, "writer", proposal);
    expect(recovered.recovered).toBe(true);
    expect(recovered.receipt.revision).toBe(2);
    expect((await policyRequest(service.url, "writer", "/status")).operations).toHaveProperty(
      proposal.operationId,
    );
    await expect(
      policyRequest(service.url, "writer", "/apply", {
        ...proposal,
        sourceArtifactId: "different",
      }),
    ).rejects.toThrow("409");
    await expect(
      policyRequest(service.url, "writer", "/apply", { ...proposal, operationId: "new-id" }),
    ).rejects.toThrow("Policy revision changed");
    await expect(
      applyReviewedPolicy(service.url, "writer", { ...proposal, sourceArtifactId: "different" }),
    ).rejects.toThrow("does not match");
    await expect(policyRequest(service.url, "bad", "/status")).rejects.toThrow("401");
    expect(Object.keys((await policyRequest(service.url, "writer", "/status")).operations)).toEqual(
      [proposal.operationId],
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("processes every backlog page across two hosts and Control Plane restart, with bounded review and provider recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-backlog-"));
  const databaseUrl = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url: databaseUrl });
  const store = new DrizzleStore({ url: databaseUrl });
  await store.connect();
  const service = await startPolicyService({
    path: join(directory, "policies.json"),
    readToken: "reader",
    writeToken: "writer",
    dropFirstResponse: true,
  });
  const start = (port: number) =>
    startControlPlaneRuntime({
      host: "127.0.0.1",
      port,
      databaseUrl,
      workletTransport: "remote",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
  let runtime = await start(0);
  const api = apiClient(runtime.url, "test-admin");
  const connections: Awaited<ReturnType<typeof connectWorklet>>[] = [];
  const worklets: DurableLocalWorklet[] = [];
  const errors: unknown[] = [];
  const observedBacklogs: number[] = [];
  let injectedEdit = false;
  // Both example Workers keep their artifact copies on one machine, as examples/ongoing-support does.
  const artifactStore = hostArtifactStore(join(directory, "artifacts"));
  try {
    const actors = await createOrganization(api);
    for (const name of ["manager", "analyst"] as const) {
      const worker = supportWorker({
        name,
        config: {
          analystTagId: actors.analyst.tagId,
          policyUrl: service.url,
          policyToken: name === "manager" ? "writer" : "reader",
        },
        artifactStore,
        onError: (error: unknown) => errors.push(error),
        afterApply: async () => {
          if (!injectedEdit) {
            injectedEdit = true;
            const team = await store.getTeam("support-team");
            await api.coordinate("update_team", {
              teamId: team.id,
              expectedRevision: team.revision,
              context: { ...team.context, operatorNote: "Preserve this concurrent edit" },
            });
          }
          const tasks = await store.listTaskAssignments("ongoing-support");
          observedBacklogs.push(
            tasks.filter(
              (task) =>
                task.taskId !== "ongoing-support:start" &&
                !["accepted", "cancelled", "failed"].includes(task.status),
            ).length,
          );
        },
      }) as Worker;
      const local = new LocalWorklet(`support-${name}`, actors[name].hostId, [worker]);
      const durable = new DurableLocalWorklet(local, new FileAttemptJournal(join(directory, name)));
      worklets.push(durable);
      connections.push(
        await connectWorklet({
          url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
          credential: actors[name].credential,
          worklet: local,
          durableWorklet: durable,
          reconnectIntervalMs: 20,
        }),
      );
    }
    await api.coordinate("start_objective", { maxCostMinor: 0 });
    const waiting = () =>
      expect
        .poll(async () => (await store.getTaskAssignment("ongoing-support:start"))?.status, {
          timeout: 15000,
        })
        .toBe("waiting");
    await waiting();
    const port = Number(new URL(runtime.url).port);
    await runtime.close();
    runtime = await start(port);
    await expect.poll(() => connections.every((connection) => connection.isConnected)).toBe(true);
    // More posts than fit on a page; duplicate incidents appear both within and across pages.
    for (const [index, incidentId] of [
      "one",
      "one",
      "two",
      "three",
      "one",
      "four",
      "five",
    ].entries()) {
      const post = {
        workstreamId: "support-observations",
        body: JSON.stringify({ incidentId }),
        idempotencyKey: `delivery-${index}`,
      };
      const first = await api.coordinate("post_workstream", post);
      expect(await api.coordinate("post_workstream", post)).toEqual(first);
    }
    await expect
      .poll(
        async () =>
          Object.keys((await store.getTeam("support-team")).context?.["applied"] ?? {}).length,
        { timeout: 30000 },
      )
      .toBe(5);
    await waiting();
    const team = await store.getTeam("support-team");
    expect(team.context?.["cursor"]).toBe(7);
    expect(team.context?.["operatorNote"]).toBe("Preserve this concurrent edit");
    const provider = await policyRequest(service.url, "reader", "/status");
    expect(provider.dropped).toBe(true);
    expect(Object.keys(provider.operations)).toHaveLength(5);
    expect(Math.max(...observedBacklogs)).toBeLessThanOrEqual(2);
    const assignments = await store.listTaskAssignments("ongoing-support");
    expect(assignments).toHaveLength(6);
    for (const task of assignments.filter((task) => task.taskId !== "ongoing-support:start")) {
      expect(task.status).toBe("accepted");
      const result = task.result?.["taskResult"] as { artifacts: { artifactId: string }[] };
      const receipt = provider.operations[task.taskId];
      expect(receipt.sourceArtifactId).toBe(result.artifacts[0]?.artifactId);
      expect(receipt.revision).toBe(2);
      const applied = team.context?.["applied"] as Record<string, { reviewedAttemptId: string }>;
      expect(applied[receipt.incidentId]?.reviewedAttemptId).toBe(
        task.result?.["reviewedAttemptId"],
      );
    }
    const overview = await api.request(
      "GET",
      "/api/v1/coordination/objectives/ongoing-support/overview",
    );
    expect(overview.performance.states.accepted).toBe(5);
    await runtime.close();
    runtime = await start(port);
    await expect.poll(() => connections.every((connection) => connection.isConnected)).toBe(true);
    await api.coordinate("post_workstream", {
      workstreamId: "support-observations",
      body: JSON.stringify({ incidentId: "one" }),
      idempotencyKey: "later-report",
    });
    await expect
      .poll(async () => (await store.getTeam("support-team")).context?.["cursor"], {
        timeout: 15000,
      })
      .toBe(8);
    expect(await store.listTaskAssignments("ongoing-support")).toHaveLength(6);
    expect(
      Object.keys((await policyRequest(service.url, "reader", "/status")).operations),
    ).toHaveLength(5);
    expect(errors).toEqual([]);
  } finally {
    for (const connection of connections) await connection.stop();
    await runtime.close();
    for (const worklet of worklets) await worklet.shutdown("Test complete");
    await service.close();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("exposes scoped MCP tools and lets a manager inspect a write whose response was lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-mcp-"));
  const service = await startPolicyService({
    path: join(directory, "policy.json"),
    readToken: "reader",
    writeToken: "writer",
    dropFirstResponse: true,
  });
  const client = new Client({ name: "support-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("examples/ongoing-support/policy-mcp.mjs")],
    env: { SUPPORT_POLICY_URL: service.url, SUPPORT_POLICY_TOKEN: "writer" },
    stderr: "ignore",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "policy_status",
      "operation_status",
      "apply_policy",
    ]);
    const proposal = {
      collection: "support",
      operationId: "support:mcp",
      incidentId: "mcp",
      expectedRevision: 1,
      responseMinutes: 30,
      sourceArtifactId: "artifact",
      sourceDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(
      (
        await client.callTool({
          name: "apply_policy",
          arguments: { ...proposal, collection: "other" },
        })
      ).isError,
    ).toBe(true);
    expect(
      Object.keys((await policyRequest(service.url, "reader", "/status")).operations),
    ).toHaveLength(0);
    expect((await client.callTool({ name: "apply_policy", arguments: proposal })).isError).toBe(
      true,
    );
    const result = await client.callTool({
      name: "operation_status",
      arguments: { collection: "support", operationId: proposal.operationId },
    });
    const text = (result.content as { text: string }[])[0]?.text;
    expect(JSON.parse(text ?? "{}").operation).toMatchObject({
      operationId: proposal.operationId,
      revision: 2,
    });
    const duplicates = await Promise.all([
      client.callTool({ name: "apply_policy", arguments: proposal }),
      client.callTool({ name: "apply_policy", arguments: proposal }),
    ]);
    expect(duplicates.every((item) => !item.isError)).toBe(true);
    expect(
      Object.keys((await policyRequest(service.url, "reader", "/status")).operations),
    ).toHaveLength(1);
  } finally {
    await client.close();
    await transport.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not advertise an in-memory receipt after durable storage fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-storage-failure-"));
  const path = join(directory, "policy.json");
  // Prevent opening the temporary file without depending on user/root permission semantics.
  await mkdir(`${path}.tmp`);
  const service = await startPolicyService({ path, readToken: "reader", writeToken: "writer" });
  const proposal = {
    operationId: "support:storage",
    incidentId: "storage",
    expectedRevision: 1,
    responseMinutes: 30,
    sourceArtifactId: "artifact",
    sourceDigest: `sha256:${"a".repeat(64)}`,
  };
  try {
    await expect(policyRequest(service.url, "writer", "/apply", proposal)).rejects.toThrow();
    await expect(
      policyRequest(service.url, "reader", "/operation?operationId=support:storage"),
    ).rejects.toThrow("Storage outcome uncertain");
    await expect(applyReviewedPolicy(service.url, "writer", proposal)).rejects.toThrow("503");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
