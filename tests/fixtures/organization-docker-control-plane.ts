/** Production API composition; organization resources are created through HTTP by the test. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { loadArtifactTransferSigningIdentity } from "../../apps/cli/src/artifact-transfer-key.js";
import { ControlPlaneApiServer } from "../../apps/cli/src/control-plane-api.js";
import { loadControlPlaneCoordinationKey } from "../../apps/cli/src/coordination-key.js";
import { ControlPlane } from "../../packages/control-plane/src/index.js";
import { signArtifactTransferGrant } from "../../packages/runtime/sdk/src/index.js";
import { RemoteWorkletServer } from "../../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../../packages/store/src/index.js";

const url = "https://control-plane:8790";
const adminToken = process.env["SUPERTAG_TEST_ADMIN_TOKEN"];
if (!adminToken) throw new Error("Missing administrative API credential");
const databaseUrl = "file:/state/control-plane.db";
await migrateDatabase({ url: databaseUrl });
const store = new DrizzleStore({ url: databaseUrl });
const vault = new FileGatewayCredentialVault("/state/vault.json");
const signingKey = await loadControlPlaneCoordinationKey(vault);
// Artifact bytes stay on Worker Hosts; the Control Plane only signs direct-transfer grants.
const transferIdentity = await loadArtifactTransferSigningIdentity(vault);
const server = createServer({
  key: await readFile("/certificates/server.key"),
  cert: await readFile("/certificates/server.crt"),
});
let controlPlane: ControlPlane;
const remote = new RemoteWorkletServer({
  server,
  authenticateWorklet: (request) => controlPlane.authenticateWorkerHost(request),
  onWorkletObserved: (observation) => controlPlane.observeWorkerHostConnection(observation),
  heartbeatIntervalMs: 200,
  heartbeatTimeoutMs: 2000,
});
controlPlane = new ControlPlane({
  store,
  credentialVault: vault,
  worklet: remote,
  reply: async () => {},
  dispatch: {
    pollIntervalMs: 100,
    onDispatchError: (error) => process.stderr.write(`${String(error)}\n`),
  },
});
const api = new ControlPlaneApiServer({
  controlPlane,
  store,
  credentialVault: vault,
  artifactTransfers: {
    publicKey: transferIdentity.publicKeyBase64,
    sign: (claims) => signArtifactTransferGrant(claims, transferIdentity.privateKey),
  },
  surfaceController: { name: "surfaces", status: () => ({ active: 0, errors: [] }) },
  startedAt: new Date().toISOString(),
  adminToken,
  coordinationOperatorCredentials: [],
  workletApi: remote,
});
server.on("request", (request, response) => {
  void api.handle(request, response, new URL(request.url ?? "/", url)).catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
await controlPlane.start();
api.start();
await new Promise<void>((resolve) => server.listen(8790, "0.0.0.0", resolve));
controlPlane.objectives.activateCoordination({ url, signingKey });
process.stdout.write("Organization API ready\n");
