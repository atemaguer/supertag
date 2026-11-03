import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { loadControlPlaneCoordinationKey } from "../apps/cli/src/coordination-key.js";
import type { TaskAttemptSpec, Worker } from "../packages/runtime/sdk/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
} from "../packages/runtime/sdk/src/index.js";
import {
  CoordinationService,
  connectWorklet,
  GrpcCoordinationClient,
  GrpcExecutionAuthorityClient,
  GrpcSessionStateStore,
} from "../packages/runtime/transport/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const transportRequire = createRequire(
  new URL("../packages/runtime/transport/package.json", import.meta.url),
);
const { createClient } = transportRequire("@connectrpc/connect");
const { createGrpcTransport } = transportRequire("@connectrpc/connect-node");

const PostgresqlPool = createRequire(new URL("../packages/store/package.json", import.meta.url))(
  "pg",
).Pool as new (options: {
  connectionString: string;
  max: number;
}) => {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
};

for (const dialect of ["sqlite", "postgresql"] as const)
  it.skipIf(dialect === "postgresql" && !process.env["SUPERTAG_POSTGRES_URL"])(
    `${dialect}: rebinds manager gRPC authority to the recovered lease generation`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-authority-recovery-"));
      let databaseUrl = `file:${join(directory, "state.db")}`;
      let dropDatabase = async () => {};
      if (dialect === "postgresql") {
        const postgres = process.env["SUPERTAG_POSTGRES_URL"];
        if (!postgres) throw new Error("Missing PostgreSQL URL");
        const name = `supertag_authority_${randomUUID().replaceAll("-", "")}`;
        const admin = new PostgresqlPool({ connectionString: postgres, max: 1 });
        try {
          await admin.query(`CREATE DATABASE "${name}"`);
        } finally {
          await admin.end();
        }
        const isolated = new URL(postgres);
        isolated.pathname = `/${name}`;
        databaseUrl = isolated.toString();
        dropDatabase = async () => {
          const cleanup = new PostgresqlPool({ connectionString: postgres, max: 1 });
          try {
            await cleanup.query(`DROP DATABASE "${name}"`);
          } finally {
            await cleanup.end();
          }
        };
      }
      await migrateDatabase({ url: databaseUrl });
      const store = new DrizzleStore({ url: databaseUrl });
      await store.connect();
      const tag = await store.createTag({ name: `Recovery manager ${randomUUID()}` });
      await store.bindTagWorkerHost(tag.id, "authority-host");
      const objectiveId = randomUUID();
      await store.createObjective({
        id: objectiveId,
        ownerTagId: tag.id,
        outcome: "Keep live coordination authority across restart",
      });
      await store.createTeam({
        id: objectiveId,
        objectiveId,
        name: "Recovery",
        leadTagId: tag.id,
        memberTagIds: [],
        maxConcurrency: 1,
      });
      const profile = { id: `authority-${objectiveId}`, revision: "1" };
      let captured: TaskAttemptSpec | undefined;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker: Worker = {
        async describe() {
          return {
            profileCapabilities: [
              {
                profile: profile,
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "authority-worker",
            type: "test",
            profiles: [profile],
            capabilities: [{ id: "supertag.coordination", version: 1 }],
            contextTypes: [],
            maxConcurrency: 1,
          };
        },
        async *execute(spec) {
          captured = spec;
          yield {
            type: "execution.started",
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
            workerId: "authority-worker",
          };
          await gate;
          yield {
            type: "output.message",
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
            message: { role: "teammate", text: "Recovered" },
          };
          yield {
            type: "execution.completed",
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
        },
      };
      const local = new LocalWorklet("authority-worklet", "authority-host", [worker]);
      const durable = new DurableLocalWorklet(
        local,
        new FileAttemptJournal(join(directory, "journal")),
      );
      const vault = new FileGatewayCredentialVault(join(directory, "vault.json"));
      let runtime: Awaited<ReturnType<typeof startControlPlaneRuntime>> | undefined;
      let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
      let credential: string | undefined;
      let manager: GrpcCoordinationClient | undefined;
      let grpcPort = 0;
      const boot = async (port = 0) => {
        runtime = await startControlPlaneRuntime({
          host: "127.0.0.1",
          port,
          databaseUrl,
          workletTransport: "remote",
          workletGrpc: { host: "127.0.0.1", port: grpcPort },
          adminToken: "authority-admin",
          credentialVault: vault,
        });
        grpcPort = Number(new URL(runtime.workletGrpcUrl as string).port);
        return runtime;
      };
      const mcp = async (token: string) => {
        const client = createClient(
          CoordinationService,
          createGrpcTransport({ baseUrl: runtime?.workletGrpcUrl }),
        );
        try {
          await client.listTools(
            {},
            { headers: { authorization: `Bearer ${token}` }, timeoutMs: 5000 },
          );
          return { status: 200 };
        } catch (error) {
          return { status: (error as { code?: number }).code === 16 ? 401 : 500 };
        }
      };
      const managerCall = async () => {
        if (!manager) throw new Error("Missing manager");
        const response = await manager.fetch(`${runtime?.url}/internal/v1/coordination/mcp`, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "tools/call",
            params: { name: "read_objective", arguments: {} },
          }),
        });
        return (await response.json()).result;
      };
      try {
        await boot();
        credential = await enrollWorkerHost(runtime.url, "authority-admin", "authority-host");
        connection = await connectWorklet({
          url: runtime.workletGrpcUrl as string,
          transport: "grpc",
          credential,
          worklet: local,
          durableWorklet: durable,
        });
        const response = await fetch(`${runtime.url}/api/v1/coordination/assign_task`, {
          method: "POST",
          headers: {
            authorization: "Bearer authority-admin",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            objectiveId,
            taskId: objectiveId,
            teamId: objectiveId,
            assignedTagId: tag.id,
            instruction: "Remain available through restart",
            acceptanceCriteria: ["Coordinate after recovery"],
            execution: { profile },
          }),
        });
        expect(response.status, await response.text()).toBe(200);
        await expect.poll(() => captured?.coordination?.token, { timeout: 10_000 }).toBeTruthy();
        const oldToken = captured?.coordination?.token;
        if (!oldToken) throw new Error("Missing original coordination credential");
        expect((await mcp(oldToken)).status).toBe(200);
        manager = new GrpcCoordinationClient({
          baseUrl: runtime.workletGrpcUrl as string,
          token: oldToken,
        });
        expect(await managerCall()).toMatchObject({ content: expect.any(Array) });
        const oldOwner = (await store.getTaskAssignment(objectiveId))?.leaseOwner;
        const port = Number(new URL(runtime.url).port);
        await runtime.close();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 31_000);
        await boot(port);
        manager = new GrpcCoordinationClient({
          baseUrl: runtime.workletGrpcUrl as string,
          token: oldToken,
        });
        const concurrentRecoveryCalls = Promise.all(Array.from({ length: 4 }, () => managerCall()));
        await expect
          .poll(async () => (await store.getTaskAssignment(objectiveId))?.leaseOwner, {
            timeout: 12_000,
          })
          .not.toBe(oldOwner);

        expect((await mcp(oldToken)).status).toBe(401);
        expect(await concurrentRecoveryCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: expect.any(Array) }),
            expect.objectContaining({ content: expect.any(Array) }),
            expect.objectContaining({ content: expect.any(Array) }),
            expect.objectContaining({ content: expect.any(Array) }),
          ]),
        );
        const value = {
          token: await new GrpcExecutionAuthorityClient({
            baseUrl: runtime.workletGrpcUrl as string,
          }).rebind(oldToken),
        };
        expect(value.token).toBeTypeOf("string");
        expect(value.token).not.toBe(oldToken);
        expect((await mcp(value.token as string)).status).toBe(200);
        expect((await mcp(oldToken)).status).toBe(401);

        const current = await store.getTaskAssignment(objectiveId);
        if (!current?.leaseOwner) throw new Error("Missing recovered lease generation");
        const body = Buffer.from(
          JSON.stringify({
            version: 2,
            id: objectiveId,
            attempt: current.attemptCount,
            attemptId: randomUUID(),
            generation: current.leaseOwner,
          }),
        ).toString("base64url");
        const key = await loadControlPlaneCoordinationKey(vault);
        const wrongAttempt = `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
        expect((await mcp(wrongAttempt)).status).toBe(401);

        await store.registerTaskAssignmentWait({
          taskId: objectiveId,
          leaseOwner: current.leaseOwner,
          attemptCount: current.attemptCount,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        });
        expect((await mcp(value.token)).status).toBe(401);
        const archive = {
          harnessId: "codex",
          ref: { id: randomUUID(), uri: "supertag:wait-archive", format: "test-native" },
          data: { threadId: "native-before-wait", transcript: "final cleanup state" },
        };
        const sessionUrl = runtime.workletGrpcUrl as string;
        const session = (token: string) =>
          new GrpcSessionStateStore({
            baseUrl: sessionUrl,
            token,
            renewAuthority: false,
          });
        await expect(session(oldToken).save(archive)).rejects.toThrow();
        await expect(session(wrongAttempt).save(archive)).rejects.toThrow();
        await session(value.token).save(archive);
        expect((await store.findSessionState(archive.ref.id))?.data).toEqual(archive.data);
        const httpSave = await fetch(`${runtime.url}/internal/v1/sessions/save`, {
          method: "POST",
          headers: { authorization: `Bearer ${value.token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...archive, writeVersion: 2 }),
        });
        expect(httpSave.status).toBe(200);

        const cancelled = await fetch(`${runtime.url}/api/v1/coordination/update_task`, {
          method: "POST",
          headers: {
            authorization: "Bearer authority-admin",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            objectiveId,
            taskId: objectiveId,
            expectedStatus: "running",
            status: "cancelled",
          }),
        });
        expect(cancelled.status, await cancelled.text()).toBe(200);
        await expect
          .poll(async () => (await store.getTaskAssignment(objectiveId))?.status, {
            timeout: 12_000,
          })
          .toBe("cancelled");
        expect((await mcp(value.token as string)).status).toBe(401);
        await expect(
          session(value.token).save({ ...archive, ref: { ...archive.ref, id: randomUUID() } }),
        ).rejects.toThrow();
        expect(await store.listTaskAttempts(objectiveId)).toHaveLength(1);
      } finally {
        release();
        vi.useRealTimers();
        await connection?.stop();
        await runtime?.close();
        await durable.shutdown("Test cleanup");
        await store.disconnect();
        await dropDatabase();
        await rm(directory, { recursive: true, force: true });
      }
    },
    40_000,
  );
