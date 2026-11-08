/** Fixture-only HTTP driver around production Control Plane ownership and scheduling. */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ControlPlane } from "../../packages/control-plane/src/index.js";
import {
  emptyTagContextPlan,
  type SurfaceTagAuthorizationSnapshot,
} from "../../packages/core/src/index.js";
import {
  RemoteWorkletServer,
  startWorkletGrpcServer,
} from "../../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.js";

const databaseUrl = "file:/state/control-plane.db";
await migrateDatabase({ url: databaseUrl });
const store = new DrizzleStore({ url: databaseUrl });
const http = createServer();
let controlPlane: ControlPlane;
const remote = new RemoteWorkletServer({
  server: http,
  authenticateWorklet: (request) => controlPlane.authenticateWorkerHost(request),
  onWorkletObserved: (observation) => controlPlane.observeWorkerHostConnection(observation),
  heartbeatIntervalMs: 200,
  heartbeatTimeoutMs: 2000,
  onError: (error) => process.stderr.write(`${String(error)}\n`),
});
controlPlane = new ControlPlane({
  store,
  credentialVault: new FileGatewayCredentialVault("/state/vault.json"),
  worklet: remote,
  reply: async () => {},
  dispatch: {
    pollIntervalMs: 100,
    onDispatchError: (error) => process.stderr.write(`${String(error)}\n`),
  },
});
await controlPlane.start();
remote.start();
const tag =
  (await store.findTagByName("Distributed research")) ??
  (await store.createTag({ name: "Distributed research" }));
// The fixture's callers name Tasks; Task ids are the Control Plane's, so it keeps the mapping.
const taskIds = new Map<string, string>();
const account = await store.saveSurfaceAccount({
  provider: "slack",
  externalAccountId: "worklet-grpc-fixture",
  displayName: "Fixture",
  authMethod: "test",
  credentialId: "test",
  status: "connected",
  configuration: {},
  verifiedAt: new Date().toISOString(),
});
const route = await store.addTagRoute({
  tagId: tag.id,
  surfaceAccountId: account.id,
  scope: "channel:fixture",
});

/** Admits one conversation turn of the Tag, placed by the profile the caller names. */
async function admitTurn(label: string, profile: string): Promise<string> {
  const at = new Date().toISOString();
  const authorization: SurfaceTagAuthorizationSnapshot = {
    version: 5,
    capturedAt: at,
    tag: { id: tag.id, name: tag.name },
    origin: {
      provider: "slack",
      surfaceAccountId: account.id,
      tagRouteId: route.id,
      scope: "channel:fixture",
    },
    requester: { id: "operator", kind: "user" },
    roles: [],
    permissionSets: [],
    resources: [],
    runtimeActions: [],
  };
  const contextPlan = emptyTagContextPlan(at);
  const sessionKey = `fixture:${label}`;
  const actor = { id: "operator", kind: "user" } as const;
  const admitted = await store.admitInboundEvent({
    surfaceAccountId: account.id,
    tagRouteId: route.id,
    tagId: tag.id,
    authorization,
    contextPlan,
    execution: { profile: { id: profile, revision: "1" } },
    event: {
      eventId: randomUUID(),
      logicalEventId: randomUUID(),
      provider: "slack",
      externalAccountId: account.externalAccountId,
      kind: "message",
      scope: "channel:fixture",
      sessionKey,
      actor,
      text: label,
      occurredAt: at,
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: sessionKey,
        target: { channelId: "fixture", threadTs: sessionKey },
      },
      source: {},
      metadata: {},
    },
  });
  const session = await store.openSession({ tagId: tag.id, sessionKey, origin: {}, at });
  const task = await store.openTask({
    inboundEventId: admitted.work.id,
    tagId: tag.id,
    sessionId: session.id,
    execution: { profile: { id: profile, revision: "1" } },
    actor,
    trigger: {},
    requestText: label,
    workspacePlan: { version: 1, status: "none" },
    sessionHistory: [],
    authorizationSnapshot: authorization,
    contextPlan,
    createdAt: at,
  });
  taskIds.set(label, task.id);
  return task.id;
}
// The deterministic Harness advertises tool support but does not call MCP; this fixture
// exercises execution scheduling and recovery, not the coordination HTTP handlers.
controlPlane.objectives.activateCoordination({ url: "https://control-plane:8789" });
const tls = {
  key: await readFile("/certificates/server.key", "utf8"),
  cert: await readFile("/certificates/server.crt", "utf8"),
};
let frontend = await startWorkletGrpcServer({ remote, host: "0.0.0.0", port: 8789, tls });
http.on("request", (request, response) => {
  void (async () => {
    if (request.headers.authorization !== `Bearer ${process.env["SUPERTAG_TEST_ADMIN_TOKEN"]}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let value: unknown;
    if (request.url === "/enroll") {
      value = await controlPlane.enrollWorkerHost({ id: body.id });
      await store.bindTagWorkerHost(tag.id, body.id);
    } else if (request.url === "/hosts") value = await controlPlane.listWorkerHosts();
    else if (request.url === "/assign")
      value = { taskId: await admitTurn(body.taskId, body.profile ?? body.host) };
    else if (request.url === "/select")
      value = await remote.selectPlacement(
        { profile: { id: body.profile, revision: "1" } },
        emptyTagContextPlan(new Date().toISOString()),
        { allowedWorkerHostIds: [body.host] },
      );
    else if (request.url === "/release") {
      await remote.releasePlacement(body.placement);
      value = { released: true };
    } else if (request.url === "/task") {
      const taskId = taskIds.get(body.taskId) ?? body.taskId;
      const task = await store.findTaskById(taskId);
      value = {
        assignment:
          task === undefined
            ? undefined
            : {
                status: task.status,
                attemptCount: (await store.listTaskAttempts(taskId)).length,
                ...(task.responseText === undefined ? {} : { result: { text: task.responseText } }),
              },
        attempts: await store.listTaskAttempts(taskId),
        events: await store.listTaskEvents(taskId),
      };
    } else if (request.url === "/inspect") value = await remote.inspect(body.attemptId);
    else if (request.url === "/cancel") {
      const taskId = taskIds.get(body.taskId) ?? body.taskId;
      const { accepted } = await controlPlane.requestTaskCancellation(taskId);
      value = { accepted };
    } else if (request.url === "/restart-frontend") {
      await frontend.close();
      frontend = await startWorkletGrpcServer({ remote, host: "0.0.0.0", port: 8789, tls });
      value = { restarted: true };
    } else throw new Error("Unknown fixture route");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(value ?? null));
  })().catch((error) => {
    response.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise<void>((resolve) => http.listen(8790, "0.0.0.0", resolve));
process.stdout.write("Control Plane fixture ready\n");
