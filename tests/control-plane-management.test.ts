import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.ts";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.ts";
import { main } from "../apps/cli/src/index.ts";
import { hostClient, organizationClient, workClient } from "../apps/cli/src/operator-client.ts";
import { listWorkerHostResources } from "../apps/cli/src/operator-resources.ts";
import type { CredentialValue, GatewayCredentialVault } from "../packages/core/src/index.ts";
import { ControllerPhase, ControlPlanePhase } from "../packages/operator-api/src/index.ts";
import { DrizzleStore } from "../packages/store/src/index.ts";
import { migrateSqlite as migrateSqliteDatabase } from "./support/database.ts";

describe("remote Control Plane management", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("remembers an active Control Plane and manages it without repeated flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-control-plane-management-"));
    const serverState = join(directory, "server");
    const clientState = join(directory, "client");
    const databasePath = join(serverState, "supertag.db");
    await migrateSqliteDatabase(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", serverState);
    const token = "test-administrative-token";
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: token,
      surfaceRefreshIntervalMs: 10,
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      vi.stubEnv("SUPERTAG_STATE_DIR", clientState);
      vi.stubEnv("SUPERTAG_ADMIN_TOKEN", token);
      await expect(main(["control-plane", "connect", runtime.url])).resolves.toBe(0);
      await expect(main(["tag", "create", "engineering"])).resolves.toBe(0);
      await expect(main(["list", "tag"])).resolves.toBe(0);
      await expect(main(["get", "tag"])).resolves.toBe(0);
      await expect(main(["describe", "tag", "engineering"])).resolves.toBe(0);
      expect(output.join("")).toContain("This is now your active Control Plane");
      expect(output.join("")).toContain("engineering");

      await expect(
        main(["control-plane", "connect", runtime.url, "--name", "staging.us"]),
      ).resolves.toBe(0);
      await expect(main(["control-plane", "list"])).resolves.toBe(0);
      expect(output.join("")).toContain("staging.us");
      await expect(main(["control-plane", "use", "default"])).resolves.toBe(0);
      await expect(
        main(["--control-plane", "staging.us", "describe", "tag", "engineering"]),
      ).resolves.toBe(0);

      const client = new ControlPlaneClient({ url: runtime.url, token });
      const existingTag = await client.getTag("engineering");
      const idempotentCreate = await client.createTag({ name: "engineering" });
      expect(idempotentCreate.metadata.id).toBe(existingTag.metadata.id);
      expect(idempotentCreate.metadata.resourceVersion).toBe(existingTag.metadata.resourceVersion);
      await expect(
        client.request("/api/v1/tags", {
          method: "POST",
          body: JSON.stringify({
            apiVersion: "supertag/v1",
            kind: "Tag",
            metadata: { name: "engineering" },
            spec: { workerProfile: { id: "removed", revision: "1" } },
          }),
        }),
      ).rejects.toThrow("Tag spec contains unknown fields: workerProfile");
      await expect(client.status()).resolves.toMatchObject({
        metadata: { name: "control-plane" },
        phase: ControlPlanePhase.ACCEPTING,
        controllers: expect.arrayContaining([
          expect.objectContaining({ name: "surfaces", phase: ControllerPhase.RUNNING }),
          expect.objectContaining({ name: "task-dispatch", phase: ControllerPhase.RUNNING }),
          expect.objectContaining({ name: "reply-delivery", phase: ControllerPhase.RUNNING }),
        ]),
      });
      const account = await client.setupSurface({
        provider: "slack",
        externalAccountId: "T_REMOTE",
        displayName: "Remote Slack",
        authMethod: "slack-bot-token",
        configuration: { transport: "socket" },
        secrets: { botToken: "xoxb-test", appToken: "xapp-test" },
      });
      expect(account.kind).toBe("SurfaceAccount");
      expect(account.spec.externalAccountId).toBe("T_REMOTE");
      await expect(
        client.runTagCommand("add", [
          "engineering",
          "slack",
          "--channel-id",
          "C123ENGINEERING",
          "--account",
          account.metadata.id,
        ]),
      ).resolves.toContain("Added engineering to slack");

      const adminHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const permissionResponse = await fetch(`${runtime.url}/api/v1/permission-sets`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "PermissionSet",
          metadata: { name: "shared-engineering" },
          spec: {
            permissions: [
              {
                target: "surface",
                surfaceAccountId: account.metadata.id,
                scope: "channel:C_ENGINEERING",
                action: "history:read",
              },
              { target: "runtime", action: "commands:execute" },
            ],
          },
        }),
      });
      expect(permissionResponse.status).toBe(201);
      await expect(permissionResponse.json()).resolves.toMatchObject({
        kind: "PermissionSet",
        metadata: { name: "shared-engineering" },
        spec: {
          permissions: expect.arrayContaining([
            expect.objectContaining({ target: "surface", action: "history:read" }),
            expect.objectContaining({ target: "runtime", action: "commands:execute" }),
          ]),
        },
      });

      const manifestPath = join(directory, "permission-set.yaml");
      await writeFile(
        manifestPath,
        `apiVersion: supertag/v1\nkind: PermissionSet\nmetadata:\n  name: shared-engineering\nspec:\n  permissions:\n    - target: surface\n      surfaceAccountId: ${account.metadata.id}\n      scope: channel:C_ENGINEERING\n      action: history:read\n    - target: runtime\n      action: commands:execute\n`,
      );
      await expect(main(["diff", "-f", manifestPath])).resolves.toBe(0);
      await expect(main(["apply", "-f", manifestPath])).resolves.toBe(0);
      await expect(main(["watch", "permission-set", "shared-engineering", "--once"])).resolves.toBe(
        0,
      );
      expect(output.join("")).toContain("No changes. The Control Plane matches the input.");
      expect(output.join("")).toContain("PermissionSet/shared-engineering configured");

      const contextResponse = await fetch(`${runtime.url}/api/v1/context-sets`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "ContextSet",
          metadata: { name: "shared-guidelines" },
          spec: {
            items: [
              {
                itemKey: "skill:review",
                type: "supertag/skill",
                version: 1,
                required: true,
                config: { reference: "review-guidelines" },
              },
            ],
          },
        }),
      });
      expect(contextResponse.status).toBe(201);
      await expect(contextResponse.json()).resolves.toMatchObject({
        kind: "ContextSet",
        metadata: { name: "shared-guidelines" },
      });

      const roleManifestPath = join(directory, "role.yaml");
      await writeFile(
        roleManifestPath,
        `apiVersion: supertag/v1
kind: Role
metadata:
  name: Engineering Reviewer
spec:
  purpose: Review engineering changes before release.
  instructions: Require evidence and state unresolved risk.
  contextSets:
    - shared-guidelines
  permissionSets:
    - shared-engineering
`,
      );
      await expect(main(["diff", "-f", roleManifestPath])).resolves.toBe(0);
      await expect(main(["apply", "-f", roleManifestPath])).resolves.toBe(0);
      const unassignedRole = await client.request<{
        readonly spec: Record<string, unknown>;
        readonly status: Record<string, unknown>;
      }>("/api/v1/roles/Engineering%20Reviewer");
      expect(unassignedRole.spec).toEqual({
        purpose: "Review engineering changes before release.",
        instructions: "Require evidence and state unresolved risk.",
        contextSets: ["shared-guidelines"],
        permissionSets: ["shared-engineering"],
      });
      expect(unassignedRole.status).toEqual({ phase: "active", assignedTags: [] });
      await expect(
        client.request("/api/v1/roles", {
          method: "POST",
          body: JSON.stringify({
            apiVersion: "supertag/v1",
            kind: "Role",
            metadata: { name: "Engineering Reviewer" },
            spec: {
              purpose: "Review engineering changes before release.",
              instructions: "Require evidence and state unresolved risk.",
              contextSets: ["shared-guidelines"],
              permissionSets: ["shared-engineering"],
              tags: ["engineering"],
            },
          }),
        }),
      ).rejects.toThrow("Role spec contains unknown fields: tags");

      const tagManifestPath = join(directory, "tag.yaml");
      await writeFile(
        tagManifestPath,
        `apiVersion: supertag/v1
kind: Tag
metadata:
  name: engineering
spec:
  roles:
    - Engineering Reviewer
`,
      );
      await expect(main(["diff", "-f", tagManifestPath])).resolves.toBe(0);
      await expect(main(["apply", "-f", tagManifestPath])).resolves.toBe(0);
      await expect(main(["diff", "-f", tagManifestPath])).resolves.toBe(0);
      await expect(main(["get", "role", "Engineering Reviewer"])).resolves.toBe(0);
      const configuredTag = await client.getTag("engineering");
      expect(configuredTag).toMatchObject({
        kind: "Tag",
        metadata: { name: "engineering" },
        spec: { roles: ["Engineering Reviewer"] },
        status: {
          phase: "active",
          locations: [
            {
              provider: "slack",
              account: "Remote Slack",
              target: "channel:C123ENGINEERING",
              enabled: true,
            },
          ],
        },
      });
      expect(configuredTag.metadata.resourceVersion).not.toBe(existingTag.metadata.resourceVersion);
      const assignedRole = await client.request<{
        readonly kind: string;
        readonly metadata: { readonly name: string };
        readonly spec: Record<string, unknown>;
        readonly status: Record<string, unknown>;
      }>("/api/v1/roles/Engineering%20Reviewer");
      expect(assignedRole).toMatchObject({
        kind: "Role",
        metadata: { name: "Engineering Reviewer" },
      });
      expect(assignedRole.spec).toEqual(unassignedRole.spec);
      expect(assignedRole.status).toEqual({
        phase: "active",
        assignedTags: ["engineering"],
      });
      // Every Role is declared; nothing is seeded, so only the declared Role is listed.
      const roles = await client.request<{
        readonly items: readonly { readonly metadata: { readonly name: string } }[];
      }>("/api/v1/roles");
      expect(roles.items.map((role) => role.metadata.name)).toEqual(["Engineering Reviewer"]);

      const clearedTag = await client.request<typeof configuredTag>("/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name: "engineering" },
          spec: { roles: [] },
        }),
      });
      expect(clearedTag.spec.roles).toEqual([]);
      expect(clearedTag.metadata.resourceVersion).not.toBe(configuredTag.metadata.resourceVersion);
      const restoredTag = await client.request<typeof configuredTag>("/api/v1/tags", {
        method: "POST",
        body: JSON.stringify({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: { name: "engineering" },
          spec: { roles: ["Engineering Reviewer"], workerHosts: [] },
        }),
      });
      expect(restoredTag.spec.roles).toEqual(["Engineering Reviewer"]);
      expect(restoredTag.metadata.resourceVersion).not.toBe(configuredTag.metadata.resourceVersion);
      const createExistingTag = await client.createTag({ name: "engineering" });
      expect(createExistingTag.spec.roles).toEqual(["Engineering Reviewer"]);
      expect(createExistingTag.metadata.resourceVersion).toBe(restoredTag.metadata.resourceVersion);
      expect(output.join("")).toContain("Role/Engineering Reviewer configured");
      expect(output.join("")).toContain("Tag/engineering configured");
      expect(output.join("")).toContain("+ Role Engineering Reviewer");
      expect(output.join("")).toContain("~ Tag engineering   spec.roles: + Engineering Reviewer");

      const work = workClient(client.operator);
      await expect(work.listTasks({})).resolves.toMatchObject({ tasks: [] });
      await expect(work.listSessions({})).resolves.toMatchObject({ sessions: [] });
      for (const route of ["/api/v1/tasks", "/api/v1/sessions"])
        expect((await fetch(`${runtime.url}${route}`, { headers: adminHeaders })).status).toBe(404);
      const metrics = await organizationClient(client.operator).getMetrics({});
      expect(metrics).toMatchObject({
        tags: 1n,
        roles: 1n,
        roleAssignments: 1n,
        surfaceAccounts: 1n,
        permissionSets: 1n,
        contextSets: 1n,
        tasks: { total: 0n },
        coordinationInbox: { pending: 0n },
        recovery: { unknownControlDeliveries: 0n },
        usage: { reportingAttempts: 0n, totalTokens: 0n },
        nativeAgents: { peakConcurrent: 0n },
        mailbox: { pending: 0n },
        replyDelivery: { backlog: 0n },
      });
      expect(metrics.mailbox?.oldestPendingAt).toBeUndefined();
      await expect(listWorkerHostResources(client.operator)).resolves.toMatchObject({
        kind: "ResourceList",
        items: [expect.objectContaining({ kind: "WorkerHost" })],
      });
      await expect(client.request("/api/v1/worker-profiles")).resolves.toMatchObject({
        kind: "ResourceList",
        items: [expect.objectContaining({ kind: "WorkerProfile" })],
      });

      const unauthorized = await fetch(`${runtime.url}/api/v1/tags`);
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toMatchObject({
        kind: "Status",
        status: "Failure",
        reason: "Unauthorized",
        code: 401,
      });

      const tags = await client.listTags();
      expect(tags.kind).toBe("ResourceList");
      expect(tags.items).toEqual([
        expect.objectContaining({
          apiVersion: "supertag/v1",
          kind: "Tag",
          metadata: expect.objectContaining({ name: "engineering" }),
          spec: {
            roles: ["Engineering Reviewer"],
            workerHosts: [],
            runsOn: [],
            locations: [{ provider: "slack", account: "T_REMOTE", channelId: "C123ENGINEERING" }],
            acceptsMessagesFrom: [],
          },
          status: {
            phase: "active",
            locations: [
              {
                provider: "slack",
                account: "Remote Slack",
                target: "channel:C123ENGINEERING",
                enabled: true,
              },
            ],
            // With no effort configured, the range allows every effort and starts at low.
            execution: { effort: ["low", "medium", "high"] },
          },
        }),
      ]);
      const hosts = await listWorkerHostResources(client.operator);
      const hostId = hosts.items[0]?.metadata.id;
      if (!hostId) throw new Error("Expected embedded Worker Host");
      const tagHosts = hostClient(client.operator);
      await expect(
        tagHosts.bindWorkerHost({ tag: "engineering", workerHostId: hostId }),
      ).resolves.toMatchObject({ tag: "engineering", workerHosts: [hostId], changed: true });
      await expect(
        tagHosts.bindWorkerHost({ tag: "engineering", workerHostId: hostId }),
      ).resolves.toMatchObject({ workerHosts: [hostId], changed: false });
      await expect(client.getTag("engineering")).resolves.toMatchObject({
        spec: { workerHosts: [hostId] },
      });
      await expect(
        tagHosts.unbindWorkerHost({ tag: "engineering", workerHostId: hostId }),
      ).resolves.toMatchObject({ workerHosts: [], changed: true });
      await expect(
        tagHosts.unbindWorkerHost({ tag: "engineering", workerHostId: hostId }),
      ).resolves.toMatchObject({ changed: false });
      await expect(
        tagHosts.bindWorkerHost({ tag: "missing", workerHostId: hostId }),
      ).rejects.toMatchObject({ code: Code.NotFound });

      const store = new DrizzleStore({ url: `file:${databasePath}` });
      await store.connect();
      try {
        await expect(store.findTagByName("engineering")).resolves.toBeDefined();
        await expect(store.findSurfaceAccount("slack", "T_REMOTE")).resolves.toMatchObject({
          displayName: "Remote Slack",
        });
      } finally {
        await store.disconnect();
      }

      const controlPlaneFile = join(clientState, "control-planes.json");
      expect(JSON.parse(await readFile(controlPlaneFile, "utf8"))).toMatchObject({
        version: 1,
        activeConnection: "default",
        controlPlanes: {
          default: { url: runtime.url },
          "staging.us": { url: runtime.url },
        },
        credentials: {
          default: { provider: "file", credentialId: expect.any(String) },
          "staging.us": { provider: "file", credentialId: expect.any(String) },
        },
        connections: {
          default: { controlPlane: "default", credential: "default" },
          "staging.us": { controlPlane: "staging.us", credential: "staging.us" },
        },
      });
      expect((await stat(controlPlaneFile)).mode & 0o777).toBe(0o600);
      const credentials = await readFile(join(clientState, "credentials.json"), "utf8");
      expect(credentials).not.toContain(runtime.url);
      expect(credentials).toContain(token);
      await expect(stat(join(clientState, "supertag.db"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the same Control Plane API for an unnamed local deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-local-control-plane-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqliteDatabase(databasePath);
    vi.stubEnv("SUPERTAG_STATE_DIR", directory);
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      enableLocalAdmin: true,
      surfaceRefreshIntervalMs: 10,
    });
    vi.stubEnv("SUPERTAG_GATEWAY_PORT", new URL(runtime.url).port);
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    try {
      await expect(main(["tag", "create", "local-api"])).resolves.toBe(0);
      await expect(main(["describe", "tag", "local-api"])).resolves.toBe(0);
      expect(output.join("")).toContain("Created Tag local-api");
      expect(output.join("")).toContain("Tag: local-api");
      await expect(stat(join(directory, "control-planes.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps surface enrollment stable with an external credential vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-external-vault-"));
    const databasePath = join(directory, "supertag.db");
    await migrateSqliteDatabase(databasePath);
    const credentialVault = new SimulatedExternalCredentialVault();
    // Providers without atomic creation provision the durable coordination identity explicitly.
    await credentialVault.store("control-plane/coordination-signing-key", {
      key: randomBytes(32).toString("base64url"),
    });
    await credentialVault.store("control-plane/artifact-transfer-signing-key", {
      privateKey: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
    });
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: `file:${databasePath}`,
      adminToken: "external-vault-admin-token",
      credentialVault,
    });

    try {
      const account = await new ControlPlaneClient({
        url: runtime.url,
        token: "external-vault-admin-token",
      }).setupSurface({
        provider: "slack",
        externalAccountId: "T_EXTERNAL",
        displayName: "External Vault Slack",
        authMethod: "slack-http",
        configuration: { transport: "http" },
        secrets: { botToken: "xoxb-external", signingSecret: "signing-external" },
      });

      expect(account).toMatchObject({
        kind: "SurfaceAccount",
        spec: { provider: "slack", externalAccountId: "T_EXTERNAL" },
        status: { phase: "connected" },
      });
      expect(JSON.stringify(account)).not.toContain("xoxb-external");
      expect(JSON.stringify(account)).not.toContain("credentialId");
      await expect(credentialVault.resolve("surface/slack/T_EXTERNAL")).resolves.toEqual({
        botToken: "xoxb-external",
        signingSecret: "signing-external",
      });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class SimulatedExternalCredentialVault implements GatewayCredentialVault {
  readonly #values = new Map<string, CredentialValue>();

  async store(credentialId: string, value: CredentialValue): Promise<void> {
    this.#values.set(credentialId, value);
  }

  async resolve(credentialId: string): Promise<CredentialValue | undefined> {
    return this.#values.get(credentialId);
  }

  async delete(credentialId: string): Promise<void> {
    this.#values.delete(credentialId);
  }
}
