import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneApiServer, isControlPlaneApiPath } from "../apps/cli/src/control-plane-api.ts";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";
import { organizationClient } from "../apps/cli/src/operator-client.ts";
import { runResourceCommand } from "../apps/cli/src/resources.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import { emptyTagContextPlan } from "../packages/core/src/index.ts";
import {
  executionWarningProgress,
  LocalWorklet,
  StaticWorker,
  type Worklet,
} from "../packages/runtime/sdk/src/index.ts";
import {
  GrpcCoordinationClient,
  RemoteWorkletServer,
  WorkletConnection,
} from "../packages/runtime/transport/src/index.ts";
import { DrizzleStore, FileGatewayCredentialVault } from "../packages/store/src/index.ts";
import { migrateSqlite } from "./support/database.ts";
import { durableTestWorklet } from "./support/durable-test-worklet.js";
import { sharedTokenAuthentication } from "./support/worklet-authentication.js";

describe("Control Plane API boundary", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("serves spend only to management credentials and rejects invalid filters", async () => {
    const f = await apiFixture();
    const endpoint = `${f.url}/api/v1/spend`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(
      (await fetch(endpoint, { headers: { authorization: "Bearer coordination-only" } })).status,
    ).toBe(403);
    const headers = { authorization: "Bearer administrative-token" };
    const response = await fetch(endpoint, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ by: "objective", since: null, groups: [] });
    expect((await fetch(`${endpoint}?since=invalid`, { headers })).status).toBe(400);
    expect((await fetch(`${endpoint}?by=invalid`, { headers })).status).toBe(400);
  });

  it("serves the organization overview only to management credentials", async () => {
    const f = await apiFixture();
    const endpoint = `${f.url}/api/v1/organization`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(
      (await fetch(endpoint, { headers: { authorization: "Bearer coordination-only" } })).status,
    ).toBe(403);
    const response = await fetch(endpoint, {
      headers: { authorization: "Bearer administrative-token" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workerHosts: { id: string }[];
      tags: unknown[];
      objectives: unknown[];
    };
    expect(body.workerHosts.map((host) => host.id)).toContain("api-host");
    expect(body).toMatchObject({ tags: [], objectives: [] });
  });

  it("preserves administrative authentication without starting a Gateway", async () => {
    const fixture = await apiFixture();

    const missingToken = await fetch(`${fixture.url}/api/v1/tags`);
    expect(missingToken.status).toBe(401);
    await expect(missingToken.json()).resolves.toMatchObject({
      kind: "Status",
      status: "Failure",
      reason: "Unauthorized",
      code: 401,
    });

    const scopedToken = await fetch(`${fixture.url}/api/v1/tags`, {
      headers: { authorization: "Bearer coordination-only" },
    });
    expect(scopedToken.status).toBe(403);
    await expect(scopedToken.json()).resolves.toMatchObject({
      kind: "Status",
      status: "Failure",
      reason: "Forbidden",
      code: 403,
    });
  });

  it("serves the Objective overview to authorized operators over Connect and the CLI", async () => {
    const f = await apiFixture();
    const owner = await f.store.createTag({ name: `overview-${randomUUID()}` });
    const objective = await f.store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Make progress inspectable",
    });
    const describe = (body: unknown, token?: string) =>
      fetch(`${f.url}/supertag.operator.v1.ObjectiveService/DescribeObjective`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    expect((await describe({ id: objective.id })).status).toBe(401);
    const response = await describe({ id: objective.id }, "coordination-only");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ objective: { id: objective.id } });
    for (const body of [
      { id: objective.id, pageSize: -1 },
      { id: objective.id, pageToken: "x" },
    ])
      expect((await describe(body, "coordination-only")).status).toBe(400);
    const target = { url: f.url, token: "coordination-only" };
    const rendered = await runObjectiveCommand(target, ["get", objective.id, "--overview"]);
    expect(rendered).toContain("Make progress inspectable");
    expect(rendered).toContain("The Objective's conversation has not started.");
    expect(rendered).toContain("Budget: unlimited; no cost recorded");
    const json = JSON.parse(
      await runObjectiveCommand(target, ["get", objective.id, "--overview", "--output", "json"]),
    );
    expect(json.objective.id).toBe(objective.id);
    expect(json.sessions ?? []).toEqual([]);
    await expect(runObjectiveCommand(target, ["get", objective.id, "--json"])).rejects.toThrow(
      "Unknown option '--json'",
    );
    expect(
      JSON.parse(
        await runObjectiveCommand({ url: f.url, token: "administrative-token" }, [
          "get",
          objective.id,
        ]),
      ).id,
    ).toBe(objective.id);
  });

  it("cancels an Objective through CancelObjective and the CLI", async () => {
    const f = await apiFixture();
    const owner = await f.store.createTag({ name: `cancel-${randomUUID()}` });
    const objective = await f.store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "Explore a direction we may drop",
    });
    const cancel = (body: unknown, token?: string) =>
      fetch(`${f.url}/supertag.operator.v1.ObjectiveService/CancelObjective`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    expect((await cancel({ id: objective.id })).status).toBe(401);
    // CancelObjective does not accept scoped coordination credentials.
    expect((await cancel({ id: objective.id }, "coordination-only")).status).toBe(403);
    const admin = { url: f.url, token: "administrative-token" };
    await expect(
      runObjectiveCommand(admin, ["cancel", objective.id, "--revision", "1"]),
    ).rejects.toThrow("Usage: supertag cancel objective ID [--reason TEXT]");
    const cancelled = JSON.parse(
      await runObjectiveCommand(admin, [
        "cancel",
        objective.id,
        "--reason",
        "Priorities changed",
        "--output",
        "json",
      ]),
    );
    expect(cancelled).toMatchObject({
      objective: {
        id: objective.id,
        status: "OBJECTIVE_STATUS_CANCELLED",
        cancellationReason: "Priorities changed",
      },
      changed: true,
    });
    expect(cancelled.cancelledTaskIds).toBeUndefined();
    expect(await runObjectiveCommand(admin, ["cancel", objective.id])).toBe(
      `objective/${objective.id} was already cancelled.\n`,
    );
    const rendered = await runObjectiveCommand(admin, ["get", objective.id, "--overview"]);
    expect(rendered).toContain(`Objective ${objective.id}: cancelled`);
    expect(rendered).toContain("An operator cancelled this Objective: Priorities changed");
    expect((await cancel({ id: objective.id, reason: "   " }, "administrative-token")).status).toBe(
      400,
    );
    expect((await cancel({ id: "missing" }, "administrative-token")).status).toBe(404);
  });

  it("retrieves private native Session state only through administrative Session endpoints", async () => {
    const fixture = await apiFixture();
    const { store } = fixture;
    const owner = await store.createTag({ name: `native-session-${randomUUID()}` });
    const profile = { id: "session-test", revision: "1" };
    const at = new Date().toISOString();
    const opened = await openConversationTask(store, owner, { profile });
    const taskId = opened.id;
    await store.startTask({ taskId, startedAt: at });
    const attempt = await store.createTaskAttempt({
      taskId,
      attemptNumber: 1,
      workerProfile: profile,
      workerSnapshot: {},
      startedAt: at,
    });
    const task = await store.findTaskById(taskId);
    if (!task) throw new Error("Expected admitted Task");
    const first = await store.putSessionState({
      taskId,
      attemptId: attempt.id,
      harnessId: "codex",
      ref: { id: randomUUID(), format: "codex.v1", uri: "supertag://native/first" },
      data: { threadId: "codex-thread-a", transcript: "private native conversation A" },
    });
    await store.promoteSessionState({
      id: first.id,
      taskId,
      attemptId: attempt.id,
      compatibility: "test-policy",
      workerProfile: profile,
    });
    const second = await store.putSessionState({
      taskId,
      attemptId: attempt.id,
      harnessId: "claude-code",
      ref: { id: randomUUID(), format: "claude.v1", uri: "supertag://native/second" },
      data: {
        claudeSessionId: "claude-session-b",
        transcripts: [{ entries: ["private native conversation B"] }],
      },
    });
    const base = `${fixture.url}/api/v1/sessions/${task.sessionId}/states`;
    const headers = { authorization: "Bearer administrative-token" };
    for (const suffix of ["", `/${first.id}`]) {
      expect((await fetch(`${base}${suffix}`)).status).toBe(401);
      expect(
        (
          await fetch(`${base}${suffix}`, {
            headers: { authorization: "Bearer coordination-only" },
          })
        ).status,
      ).toBe(403);
    }
    const listed = await fetch(base, { headers });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const listing = (await listed.json()) as { states: Array<Record<string, unknown>> };
    expect(listing.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, nativeId: "codex-thread-a", status: "resumable" }),
        expect.objectContaining({ id: second.id, nativeId: "claude-session-b", status: "stored" }),
      ]),
    );
    expect(listing.states).toHaveLength(2);
    expect(listing.states.every((state) => !("data" in state))).toBe(true);
    expect(JSON.stringify(listing)).not.toContain("private native conversation");
    const filtered = await fetch(`${base}?nativeId=codex-thread-a`, { headers });
    await expect(filtered.json()).resolves.toMatchObject({ states: [{ id: first.id }] });
    const missingNative = await fetch(`${base}?nativeId=missing`, { headers });
    await expect(missingNative.json()).resolves.toEqual({ states: [] });
    const exact = await fetch(`${base}/${second.id}`, { headers });
    expect(exact.status).toBe(200);
    expect(exact.headers.get("cache-control")).toBe("no-store");
    await expect(exact.json()).resolves.toMatchObject({ id: second.id, data: second.data });
    const otherSession = await store.openSession({
      tagId: owner.id,
      sessionKey: "unrelated-session",
      origin: {},
      at,
    });
    expect(
      (
        await fetch(`${fixture.url}/api/v1/sessions/${otherSession.id}/states/${first.id}`, {
          headers,
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/missing-state`, { headers })).status).toBe(404);
    expect(await store.listArtifacts()).toEqual([]);
  });

  it("creates and lists resources when mounted independently of the Gateway", async () => {
    const fixture = await apiFixture();
    const headers = {
      authorization: "Bearer administrative-token",
      "content-type": "application/json",
    };

    const created = await fetch(`${fixture.url}/api/v1/tags`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "Tag",
        metadata: { name: "api-boundary" },
        spec: {},
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      apiVersion: "supertag/v1",
      kind: "Tag",
      metadata: { name: "api-boundary" },
      spec: { roles: [] },
      status: { phase: "active", locations: [] },
    });

    const listed = await fetch(`${fixture.url}/api/v1/tags`, { headers });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      apiVersion: "supertag/v1",
      kind: "ResourceList",
      items: [
        expect.objectContaining({
          kind: "Tag",
          metadata: expect.objectContaining({ name: "api-boundary" }),
        }),
      ],
    });

    const gatewayRoute = await fetch(`${fixture.url}/webhooks/slack`, { method: "POST" });
    expect(gatewayRoute.status).toBe(404);
  });

  it("enrolls, rotates, revokes, and reports durable Worker Hosts without leaking secrets", async () => {
    const server = createServer();
    const workletApi = new RemoteWorkletServer({
      server,
      authenticateWorklet: sharedTokenAuthentication("fixture-bootstrap-token"),
    });
    const fixture = await apiFixture(workletApi, server, workletApi);
    const headers = {
      authorization: "Bearer administrative-token",
      "content-type": "application/json",
    };

    const enrolled = await fetch(`${fixture.url}/api/v1/worker-hosts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "WorkerHostEnrollment",
        metadata: { id: "build-east-1" },
        spec: {},
      }),
    });
    expect(enrolled.status).toBe(201);
    expect(enrolled.headers.get("cache-control")).toBe("no-store");
    const enrollment = (await enrolled.json()) as {
      readonly credential: { readonly token: string };
    };
    expect(enrollment).toMatchObject({
      kind: "WorkerHostCredential",
      metadata: { workerHostId: "build-east-1" },
      credential: { token: expect.any(String) },
    });

    const initial = await fetch(`${fixture.url}/api/v1/worker-hosts/build-east-1`, { headers });
    expect(initial.status).toBe(200);
    const initialResource = await initial.json();
    expect(initialResource).toMatchObject({
      kind: "WorkerHost",
      metadata: { id: "build-east-1" },
      spec: { draining: false },
      status: {
        phase: "unreachable",
        credentialRevision: 1,
        connectionGeneration: 0,
        connectionStatus: "disconnected",
      },
    });
    expect(JSON.stringify(initialResource)).not.toContain(enrollment.credential.token);
    expect(JSON.stringify(initialResource)).not.toContain("credentialId");

    const duplicate = await fetch(`${fixture.url}/api/v1/worker-hosts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        apiVersion: "supertag/v1",
        kind: "WorkerHostEnrollment",
        metadata: { id: "build-east-1" },
        spec: {},
      }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ reason: "AlreadyExists" });

    const rotated = await fetch(`${fixture.url}/api/v1/worker-hosts/build-east-1/credential`, {
      method: "POST",
      headers,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    const rotation = (await rotated.json()) as {
      readonly credential: { readonly token: string };
    };
    expect(rotation.credential.token).not.toBe(enrollment.credential.token);

    const afterRotation = await fetch(`${fixture.url}/api/v1/worker-hosts/build-east-1`, {
      headers,
    });
    await expect(afterRotation.json()).resolves.toMatchObject({
      status: { credentialRevision: 2 },
    });

    const revoked = await fetch(`${fixture.url}/api/v1/worker-hosts/build-east-1/credential`, {
      method: "DELETE",
      headers,
    });
    expect(revoked.status).toBe(204);
    expect(await revoked.text()).toBe("");

    const afterRevocation = await fetch(`${fixture.url}/api/v1/worker-hosts/build-east-1`, {
      headers,
    });
    await expect(afterRevocation.json()).resolves.toMatchObject({
      status: { phase: "revoked", credentialRevision: 2 },
    });

    const rotateRevoked = await fetch(
      `${fixture.url}/api/v1/worker-hosts/build-east-1/credential`,
      { method: "POST", headers },
    );
    expect(rotateRevoked.status).toBe(409);
    await expect(rotateRevoked.json()).resolves.toMatchObject({ reason: "Revoked" });
  });

  it("owns authenticated internal coordination routes", async () => {
    const fixture = await apiFixture();

    const response = await fetch(`${fixture.url}/internal/v1/coordination/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Attempt credential required",
    });
  });

  it("owns the remote Worklet API lifecycle independently of the Gateway", async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const workletApi = {
      start,
      stop,
      isConnected: true,
      workletRegistration: {
        id: "remote-api-worklet",
        host: { id: "remote-api-host" },
      },
    } as unknown as RemoteWorkletServer;
    const fixture = await apiFixture(workletApi);

    expect(start).toHaveBeenCalledOnce();
    expect(fixture.api.workletStatus).toEqual({
      connected: true,
      id: "remote-api-worklet",
      workerHostId: "remote-api-host",
    });

    await fixture.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("mounts an explicit WebSocket Worklet API connection without a Gateway", async () => {
    const server = createServer();
    const workletApi = new RemoteWorkletServer({
      server,
      authenticateWorklet: sharedTokenAuthentication("worklet-api-token"),
    });
    const fixture = await apiFixture(workletApi, server, workletApi);
    const worklet = new LocalWorklet("remote-api-worklet", "remote-api-host", [
      new StaticWorker({ id: "remote-api-worker", profile: { id: "default", revision: "1" } }),
    ]);
    const client = new WorkletConnection({
      url: `${fixture.url}/worklets`,
      transport: "websocket",
      credential: "worklet-api-token",
      worklet,
      durableWorklet: durableTestWorklet(worklet),
    });

    await client.start();
    expect(fixture.api.workletStatus).toEqual({
      connected: true,
      id: "remote-api-worklet",
      workerHostId: "remote-api-host",
    });
    await client.stop();
  });

  it("exposes bounded RPC observations only to administrators", async () => {
    const server = createServer();
    const workletApi = new RemoteWorkletServer({
      server,
      authenticateWorklet: sharedTokenAuthentication("rpc-observation-host-token"),
    });
    const fixture = await apiFixture(workletApi, server, workletApi);
    const rpcUrl = await fixture.api.startWorkletGrpc({});
    const client = new GrpcCoordinationClient({
      baseUrl: rpcUrl,
      token: "private-invalid-execution-token",
    });
    await expect(
      client.fetch("http://coordination/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ).rejects.toBeDefined();
    const endpoint = `${fixture.url}/api/v1/metrics`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(
      (await fetch(endpoint, { headers: { authorization: "Bearer coordination-only" } })).status,
    ).toBe(403);
    const response = await fetch(endpoint, {
      headers: { authorization: "Bearer administrative-token" },
    });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.values.rpc.methods).toContainEqual(
      expect.objectContaining({
        service: "supertag.coordination.v1.CoordinationService",
        method: "ListTools",
        started: 1,
        completed: 1,
        active: 0,
        errors: 1,
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("private-invalid-execution-token");
    expect(snapshot.values.rpc.queues.frames).toBe(0);
  });

  it("fences new requests and drains active requests before shutdown", async () => {
    const fixture = await apiFixture();
    const metrics = await fixture.store.readCoordinationMetrics();
    const metricsStarted = deferred<void>();
    const releaseMetrics = deferred<void>();
    const readMetrics = vi
      .spyOn(fixture.store, "readCoordinationMetrics")
      .mockImplementation(async () => {
        metricsStarted.resolve();
        await releaseMetrics.promise;
        return metrics;
      });
    const active = fetch(`${fixture.url}/api/v1/metrics`, {
      headers: { authorization: "Bearer administrative-token" },
    });
    await metricsStarted.promise;

    fixture.api.beginDrain();
    let drained = false;
    const drain = fixture.api.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await expect(
      organizationClient({ url: fixture.url, token: "administrative-token" }).getStatus({}),
    ).rejects.toMatchObject({ code: Code.Unavailable });
    const executionApi = await fetch(`${fixture.url}/internal/v1/coordination/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(executionApi.status).toBe(401);
    releaseMetrics.resolve();
    expect((await active).status).toBe(200);
    await drain;
    expect(readMetrics).toHaveBeenCalledOnce();
  });

  it("explains queued and split execution from stored evidence without an inspection", async () => {
    const fixture = await apiFixture(
      undefined,
      createServer(),
      new LocalWorklet("worklet-a", "laptop-a", []),
    );
    const { store } = fixture;
    const owner = await store.createTag({ name: `diagnostic-${randomUUID()}` });
    const at = new Date().toISOString();
    const profile = { id: "diagnostic", revision: "1" };
    const id = (await openConversationTask(store, owner, { profile })).id;
    const client = new ControlPlaneClient({ url: fixture.url, token: "administrative-token" });
    const queued = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(queued).toMatchObject({
      apiVersion: "supertag/v1",
      kind: "Task",
      spec: { tagId: owner.id },
      status: { phase: "pending" },
    });
    const queuedText = await runResourceCommand(client, "describe", ["task", id]);
    expect(queuedText).toContain("No execution Attempt has been recorded.");
    expect(queuedText).toContain("No scheduling diagnosis is recorded");
    expect(queuedText).not.toContain("capacity problem");
    await store.appendTaskEvent({
      taskId: id,
      type: "task.scheduling-incompatible",
      payload: {
        version: 1,
        status: "incompatible",
        unmetRequirements: ["missing-required-profile"],
      },
    });
    expect(await runResourceCommand(client, "describe", ["task", id])).toContain(
      "Unmet requirements: missing-required-profile",
    );
    await store.appendTaskEvent({
      taskId: id,
      type: "task.scheduling-compatible",
      payload: { version: 1, status: "compatible" },
    });
    const compatible = await runResourceCommand(client, "describe", ["task", id]);
    expect(compatible).toContain("Last scheduling check: compatible");
    expect(compatible).not.toContain("missing-required-profile");
    const attempt = await store.createTaskAttempt({
      taskId: id,
      attemptNumber: 1,
      workerProfile: profile,
      workerSnapshot: {
        durableExecution: true,
        workerHostId: "laptop-a",
        workletId: "worklet-a",
        credential: "never-render-this",
      },
      startedAt: at,
    });
    await store.startTask({ taskId: id, startedAt: at });
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "execution.started",
      payload: { workerId: "worker-a" },
    });
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "execution.runtime-inputs.resolved",
      payload: {
        manifest: {
          harness: { id: "codex", version: "1" },
          executionEnvironment: {
            id: "shared-tools",
            provider: "docker",
            placement: "remote",
            provenance: { secret: "never-render-this" },
          },
          harnessRuntime: { id: "local-cli", provider: "local-process", placement: "local" },
        },
      },
    });
    // No advertised Workers or sandbox capability: recorded execution still warns.
    const describedHost = await runResourceCommand(client, "describe", ["worker-host", "laptop-a"]);
    expect(describedHost).toContain("Task files in docker sandboxes are lost");
    expect(describedHost).not.toContain("Storage: persistent");
    const listedHosts = (await client.request("/api/v1/worker-hosts")) as {
      items: { metadata: { id: string }; status: { storage: unknown } }[];
    };
    expect(
      listedHosts.items.find((host) => host.metadata.id === "laptop-a")?.status.storage,
    ).toEqual({
      sandboxes: ["docker"],
      placementUnknown: false,
    });
    const storedBefore = await store.listTaskEvents(id);
    const described = await runResourceCommand(client, "describe", ["task", id]);
    expect(described).toContain("Worker Host: laptop-a");
    expect(described).toContain("Harness runtime: local-cli (local-process, local)");
    expect(described).toContain("Tool execution environment: shared-tools (docker, remote)");
    expect(described).toContain("Execution cleanup evidence: pending");
    expect(described).not.toContain("never-render-this");
    const running = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(running.metadata.resourceVersion).not.toBe(queued.metadata.resourceVersion);
    expect(JSON.stringify(running)).not.toContain("never-render-this");
    expect(await store.listTaskEvents(id)).toEqual(storedBefore);
    const priorVersion = running.metadata.resourceVersion;
    expect(running.status.attempt.runningCommand).toBeNull();
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "command.updated",
      payload: { command: { id: "cmd-1", command: "pnpm test:verify", status: "running" } },
    });
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "command.updated",
      payload: {
        command: { id: "cmd-2", command: "\x1b]0;pwned\x07git\x1b[31m status", status: "running" },
      },
    });
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "command.updated",
      payload: { command: { id: "cmd-2", command: "git status", status: "completed" } },
    });
    const commanded = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(commanded.status.attempt.runningCommand).toMatchObject({ command: "pnpm test:verify" });
    expect(await runResourceCommand(client, "describe", ["task", id])).toMatch(
      /^Command: running `pnpm test:verify` for \d+s$/mu,
    );
    const organization = (await (
      await fetch(`${fixture.url}/api/v1/organization`, {
        headers: { authorization: "Bearer administrative-token" },
      })
    ).json()) as {
      tags: { id: string; runningCommands: { taskId: string; command: string }[] }[];
    };
    expect(organization.tags.find((tag) => tag.id === owner.id)?.runningCommands).toMatchObject([
      { taskId: id, command: "pnpm test:verify" },
    ]);
    expect(JSON.stringify(organization)).not.toContain("pwned");
    const cleanupMessage = "Execution environment cleanup failed: release could not be confirmed";
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "progress.updated",
      payload: {
        progress: {
          summary: "Execution cleanup could not be confirmed; execution remains uncertain.",
          items: [
            {
              id: "cleanup-1",
              status: "blocked",
              text: "Original execution error: native request timed out",
              stack: "never-render-this",
            },
            { id: "cleanup-2", status: "blocked", text: cleanupMessage },
            { id: "unrelated", status: "active", text: "never-render-this" },
          ],
          privateArguments: "never-render-this",
        },
      },
    });
    const uncertain = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(uncertain.status.attempt.phase).toBe("running");
    expect(uncertain.status.attempt.failure).toBeNull();
    expect(uncertain.status.attempt.placement).toMatchObject({
      cleanup: "unknown",
      cleanupFailure: {
        items: [
          {
            id: "cleanup-1",
            text: "Original execution error: native request timed out",
            status: "blocked",
          },
          { id: "cleanup-2", text: cleanupMessage, status: "blocked" },
        ],
      },
    });
    expect(uncertain.metadata.resourceVersion).not.toBe(priorVersion);
    expect(JSON.stringify(uncertain)).not.toContain("never-render-this");
    const uncertainDescription = await runResourceCommand(client, "describe", ["task", id]);
    expect(uncertainDescription).toContain("cleanup is unconfirmed");
    expect(uncertainDescription).toContain("Original execution error: native request timed out");
    expect(uncertainDescription).toContain(cleanupMessage);
    await store.appendTaskEvent({ taskId: id, attemptId: attempt.id, type: "execution.completed" });
    const ended = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(ended.status.attempt.placement.cleanup).toBe("confirmed");
    expect(ended.status.attempt.placement.cleanupFailure).toBeNull();
    expect(ended.metadata.resourceVersion).not.toBe(priorVersion);
    expect(ended.status.attempt.warnings).toEqual([]);
    const archiveWarning =
      "Native Session archive incomplete: Could not enumerate Codex Session transcripts: session file exceeds size limit. Kept the last archived transcript.";
    await store.appendTaskEvent({
      taskId: id,
      attemptId: attempt.id,
      type: "progress.updated",
      payload: { progress: executionWarningProgress([archiveWarning]) },
    });
    const warned = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(warned.status.attempt.failure).toBeNull();
    expect(warned.status.attempt.warnings).toMatchObject([{ message: archiveWarning }]);
    expect(await runResourceCommand(client, "describe", ["task", id])).toContain(
      `Recorded warning: ${JSON.stringify(archiveWarning)}`,
    );
    const second = await store.createTaskAttempt({
      taskId: id,
      attemptNumber: 2,
      workerProfile: profile,
      workerSnapshot: { durableExecution: true },
      startedAt: at,
    });
    await store.closeTaskAttempt({ attemptId: second.id, status: "failed", endedAt: at });
    const unknown = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(unknown.status.attempt).toMatchObject({
      id: second.id,
      workerHostId: null,
      workerId: null,
      placement: { status: "unknown", cleanup: "unknown", executionEnvironment: null },
    });
    expect(await runResourceCommand(client, "describe", ["task", id])).toContain(
      "Worker Host: not recorded",
    );
    expect(unknown.status.attempt.failure).toBeNull();
    expect(unknown.status.attempt.placement.cleanupFailure).toBeNull();
    const failureMessage =
      "Shared execution cannot yet enforce per-access network policy; credential [REDACTED]";
    await store.appendTaskEvent({
      taskId: id,
      attemptId: second.id,
      type: "execution.failed",
      payload: {
        error: {
          name: "Error",
          message: failureMessage,
          stack: "never-render-this",
          provenance: { credential: "never-render-this" },
        },
      },
    });
    const failed = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(failed.status.attempt.failure.message).toBe(failureMessage);
    expect(JSON.stringify(failed)).not.toContain("never-render-this");
    const failureText = await runResourceCommand(client, "describe", ["task", id]);
    expect(failureText).toContain(`Recorded failure: ${JSON.stringify(failureMessage)}`);
    const third = await store.createTaskAttempt({
      taskId: id,
      attemptNumber: 3,
      workerProfile: profile,
      workerSnapshot: { durableExecution: true },
      startedAt: at,
    });
    const retried = JSON.parse(await runResourceCommand(client, "get", ["task", id]));
    expect(retried.status.attempt.id).toBe(third.id);
    expect(retried.status.attempt.failure).toBeNull();
    expect(await runResourceCommand(client, "describe", ["task", id])).not.toContain(
      failureMessage,
    );
  });

  /** Opens a pending conversation Task of the Tag, as an inbound message does. */
  async function openConversationTask(
    store: DrizzleStore,
    tag: { readonly id: string; readonly name: string },
    execution: Record<string, unknown> = {},
  ) {
    const at = new Date().toISOString();
    const account = await store.saveSurfaceAccount({
      provider: "slack",
      externalAccountId: randomUUID(),
      displayName: "Slack",
      authMethod: "test",
      credentialId: "test",
      status: "connected",
      configuration: {},
      verifiedAt: at,
    });
    const route = await store.addTagRoute({
      tagId: tag.id,
      surfaceAccountId: account.id,
      scope: "channel:work",
    });
    const authorization = {
      version: 5,
      capturedAt: at,
      tag: { id: tag.id, name: tag.name },
      origin: {
        provider: "slack",
        surfaceAccountId: account.id,
        tagRouteId: route.id,
        scope: "channel:work",
      },
      requester: { id: "human", kind: "user" },
      roles: [],
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    } as const;
    const contextPlan = emptyTagContextPlan(at);
    const id = randomUUID();
    const event = {
      eventId: id,
      logicalEventId: id,
      provider: "slack",
      externalAccountId: account.externalAccountId,
      kind: "message",
      scope: "channel:work",
      sessionKey: `conversation-${id}`,
      actor: { id: "human", kind: "user" },
      text: "Do the work",
      occurredAt: at,
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: `conversation-${id}`,
        target: { channelId: "work", threadTs: id },
      },
      source: {},
      metadata: {},
    } as const;
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
      sessionKey: `conversation-${id}`,
      origin: {},
      at,
    });
    return store.openTask({
      inboundEventId: admitted.work.id,
      tagId: tag.id,
      sessionId: session.id,
      execution,
      actor: event.actor,
      trigger: {},
      workspacePlan: { version: 1, status: "none" },
      sessionHistory: [],
      authorizationSnapshot: authorization,
      contextPlan,
      createdAt: at,
    });
  }

  async function apiFixture(
    workletApi?: RemoteWorkletServer,
    server: Server = createServer(),
    worklet?: Worklet,
  ): Promise<{
    readonly url: string;
    readonly api: ControlPlaneApiServer;
    readonly store: DrizzleStore;
    readonly close: () => Promise<void>;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "supertag-control-plane-api-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqlite(databasePath);
    const store = new DrizzleStore({ url: `file:${databasePath}` });
    const credentialVault = new FileGatewayCredentialVault(join(directory, "credentials.json"));
    const controlPlane = new ControlPlane({
      store,
      credentialVault,
      worklet:
        worklet ??
        new LocalWorklet("api-worklet", "api-host", [
          new StaticWorker({
            id: "api-worker",
            profile: { id: "default", revision: "1" },
          }),
        ]),
      reply: async () => {},
    });
    await controlPlane.start();
    const api = new ControlPlaneApiServer({
      controlPlane,
      store,
      credentialVault,
      surfaceController: {
        name: "surfaces",
        status: () => ({ active: 0, errors: [] }),
      },
      startedAt: "2026-09-13T00:00:00.000Z",
      adminToken: "administrative-token",
      coordinationOperatorCredentials: [
        {
          token: "coordination-only",
          operatorId: "coordination-operator",
          actions: ["read_objective"],
        },
      ],
      ...(workletApi === undefined ? {} : { workletApi }),
    });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isControlPlaneApiPath(url.pathname)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      void api.handle(request, response, url).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      });
    });
    api.start();
    await listen(server);
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("API server did not bind");
    let closed = false;
    const closeFixture = async () => {
      if (closed) return;
      closed = true;
      api.beginDrain();
      controlPlane.beginDrain();
      await api.drain();
      await api.stop();
      await controlPlane.stop();
      await close(server);
      await rm(directory, { recursive: true, force: true });
    };
    cleanups.push(closeFixture);
    return { url: `http://127.0.0.1:${address.port}`, api, store, close: closeFixture };
  }
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
