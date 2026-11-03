/** Fixture-only HTTP driver around production Control Plane ownership and scheduling. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ControlPlane } from "../../packages/control-plane/src/index.js";
import { emptyTagContextPlan } from "../../packages/core/src/index.js";
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
const existingObjective = await store.getObjective("pooled-objective").catch(() => undefined);
const tag = existingObjective
  ? await store.findTagById(existingObjective.ownerTagId)
  : await store.createTag({ name: "Distributed research" });
if (!tag) throw new Error("Missing objective owner");
if (!existingObjective) {
  await store.createObjective({
    id: "pooled-objective",
    ownerTagId: tag.id,
    outcome: "Produce one pooled conclusion",
    budgetLimitMinor: 100,
  });
  await store.createTeam({
    id: "pooled-team",
    objectiveId: "pooled-objective",
    name: "Distributed team",
    leadTagId: tag.id,
    memberTagIds: [tag.id],
    maxConcurrency: 2,
  });
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
      value = await controlPlane.objectives.commandAsAdministrator("assign_task", {
        objectiveId: "pooled-objective",
        teamId: "pooled-team",
        assignedTagId: tag.id,
        taskId: body.taskId,
        instruction: body.taskId,
        acceptanceCriteria: ["Complete the requested operation"],
        maxCostMinor: 0,
        execution: { profile: { id: body.profile ?? body.host, revision: "1" } },
      });
    else if (request.url === "/select")
      value = await remote.selectPlacement(
        { profile: { id: body.profile, revision: "1" } },
        emptyTagContextPlan(new Date().toISOString()),
        { allowedWorkerHostIds: [body.host] },
      );
    else if (request.url === "/release") {
      await remote.releasePlacement(body.placement);
      value = { released: true };
    } else if (request.url === "/task")
      value = {
        assignment: await store.getTaskAssignment(body.taskId),
        attempts: await store.listTaskAttempts(body.taskId),
        events: await store.listTaskEvents(body.taskId),
      };
    else if (request.url === "/inspect") value = await remote.inspect(body.attemptId);
    else if (request.url === "/cancel")
      value = await controlPlane.objectives.commandAsAdministrator("update_task", {
        objectiveId: "pooled-objective",
        taskId: body.taskId,
        expectedStatus: "running",
        status: "cancelled",
      });
    else if (request.url === "/restart-frontend") {
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
