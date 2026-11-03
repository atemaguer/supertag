import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { createCredentialVaultFromEnvironment } from "../apps/cli/src/credential-vault.ts";
import { verifyDeployment } from "../apps/cli/src/deploy.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import { WorkletConnection } from "../packages/runtime/transport/src/index.ts";
import { migrateDatabase } from "../packages/store/src/index.ts";
import { createIsolatedPostgresDatabase } from "./support/database.ts";
import { enrollWorkerHost } from "./support/worker-host-enrollment.ts";

const address = process.env["SUPERTAG_TEST_VAULT_ADDR"];
const token = process.env["SUPERTAG_TEST_VAULT_TOKEN"];
const postgresUrl = process.env["SUPERTAG_TEST_POSTGRES_URL"];
afterEach(() => vi.unstubAllEnvs());

describe.runIf(address && token)("Control Plane recovery with external credentials", () => {
  it("reuses signing identity and authenticates an enrolled host after losing local state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-cloudflare-recovery-"));
    const databasePath = join(directory, "organization.db");
    const statePath = join(directory, "ephemeral-state");
    const isolated = postgresUrl ? await createIsolatedPostgresDatabase(postgresUrl) : undefined;
    const databaseUrl = isolated?.url ?? `file:${databasePath}`;
    await migrateDatabase({ url: databaseUrl });
    vi.stubEnv("SUPERTAG_DEPLOYMENT_PLATFORM", undefined);
    vi.stubEnv("SUPERTAG_CREDENTIAL_VAULT", "vault");
    vi.stubEnv("VAULT_ADDR", address);
    vi.stubEnv("VAULT_TOKEN", token);
    vi.stubEnv("SUPERTAG_VAULT_MOUNT", "secret");
    vi.stubEnv("SUPERTAG_VAULT_PATH_PREFIX", `recovery-${crypto.randomUUID()}`);
    vi.stubEnv("SUPERTAG_STATE_DIR", statePath);
    const vault = createCredentialVaultFromEnvironment();
    const options = {
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      adminToken: "recovery-admin-test-token",
      workletTransport: "remote" as const,
    };
    let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
    let connection: WorkletConnection | undefined;
    try {
      runtime = await startControlPlaneRuntime(options);
      const credential = await enrollWorkerHost(runtime.url, options.adminToken, "recovery-host");
      const signingKey = await vault.resolve("control-plane/coordination-signing-key");
      expect(signingKey?.["key"]).toBeTruthy();
      await runtime.close();
      runtime = undefined;
      await rm(statePath, { recursive: true, force: true });

      runtime = await startControlPlaneRuntime(options);
      expect(await vault.resolve("control-plane/coordination-signing-key")).toEqual(signingKey);
      // Exercise the verification command against the real API through a local test transport.
      const recoveredUrl = runtime.url;
      const localRequest: typeof fetch = (url, init) =>
        fetch(new URL(new URL(String(url)).pathname, recoveredUrl), init);
      await expect(
        verifyDeployment("https://deployment.test", options.adminToken, false, localRequest),
      ).resolves.toContain("not ready");
      const worker = new StaticWorker({
        id: "recovery-worker",
        profile: { id: "default", revision: "1" },
        text: "ready",
      });
      connection = new WorkletConnection({
        url: `${runtime.url.replace("http://", "ws://")}/worklets`,
        credential,
        worklet: new LocalWorklet("recovery-worklet", "recovery-host", [worker]),
      });
      await connection.start();
      expect((await fetch(`${runtime.url}/readyz`)).status).toBe(200);
      await expect(
        verifyDeployment("https://deployment.test", options.adminToken, true, localRequest),
      ).resolves.toContain("Readiness: ready");
    } finally {
      await connection?.stop();
      await runtime?.close();
      await vault.delete("control-plane/coordination-signing-key");
      await isolated?.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
