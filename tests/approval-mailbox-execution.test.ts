import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApprovalCommand } from "../apps/cli/src/approvals.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { approvalArgumentsDigest } from "../packages/core/src/index.js";
import {
  DurableLocalWorklet,
  FileAttemptJournal,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { connectWorklet } from "../packages/runtime/transport/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgres)(`${dialect} action approval`, () => {
    it("holds a surface action, wakes the waiting Tag with the decision, and consumes a once approval", async () => {
      const directory = await mkdtemp(join(tmpdir(), "approval-mailbox-"));
      const isolated =
        dialect === "postgresql"
          ? await createIsolatedPostgresDatabase(postgres as string)
          : undefined;
      const url = isolated?.url ?? `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url });
      const store = new DrizzleStore({ url });
      await store.connect();
      const owner = await store.createTag({ name: `owner-${randomUUID()}` });
      await store.bindTagWorkerHost(owner.id, "approval-host");
      const account = await store.saveSurfaceAccount({
        provider: "github",
        externalAccountId: `github-${randomUUID()}`,
        displayName: "GitHub",
        authMethod: "simulation",
        credentialId: "unused",
        status: "connected",
        configuration: {},
        verifiedAt: new Date().toISOString(),
      });
      const set = await store.createTagPermissionSet({ name: `release-${randomUUID()}` });
      await store.addTagPermission({
        permissionSetId: set.id,
        target: "surface",
        surfaceAccountId: account.id,
        scope: "repository:1",
        reference: "acme/repo",
        action: "pull-requests:merge",
        approval: "required",
      });
      const role = await store.createRole({
        name: `Release ${randomUUID()}`,
        purpose: "Release",
        instructions: "Merge reviewed changes.",
        contextSetIds: [],
        permissionSetIds: [set.id],
      });
      await store.assignRole({ roleId: role.id, tagId: owner.id });
      const objective = await store.createObjective({
        id: randomUUID(),
        ownerTagId: owner.id,
        outcome: "Merge the release",
      });
      const errors: unknown[] = [];
      const hidden: boolean[] = [];
      const results: { attempt: number; statuses: string[]; decision?: unknown }[] = [];
      let requestId = "";
      let rootAttempts = 0;
      const action = {
        target: "surface",
        surfaceAccountId: account.id,
        scope: "repository:1",
        action: "pull-requests:merge",
        provider: "github",
        toolName: "merge_pull_request",
      };
      const worker: Worker = {
        async describe() {
          return {
            profileCapabilities: [
              {
                profile: { id: "approval-profile", revision: "1" },
                capabilities: [{ id: "supertag.coordination", version: 1 }],
                contextTypes: [],
              },
            ],
            id: "approval-worker",
            type: "deterministic",
            profiles: [{ id: "approval-profile", revision: "1" }],
            contextTypes: [],
            maxConcurrency: 1,
            trustLevel: "standard",
            capabilities: [{ id: "supertag.coordination", version: 1 }],
          };
        },
        async *execute(spec) {
          const identity = {
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
          yield { ...identity, type: "execution.started", workerId: "approval-worker" };
          const rpc = async (method: string, params?: Record<string, unknown>) => {
            const response = await fetch(
              `${spec.coordination?.controlPlaneUrl}/internal/v1/coordination/mcp`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${spec.coordination?.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              },
            );
            const value = await response.json();
            expect(response.status, JSON.stringify(value)).toBe(200);
            return value.result;
          };
          const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await rpc("tools/call", { name, arguments: args });
            expect(result?.isError, JSON.stringify(result)).not.toBe(true);
            return JSON.parse(result?.content[0]?.text ?? "null");
          };
          const merge = (pull: number) =>
            call("request_action_approval", {
              action,
              argumentsDigest: approvalArgumentsDigest({ owner: "acme", repo: "repo", pull }),
              summary: `github merge_pull_request on acme/repo #${pull}`,
            });
          try {
            if (spec.taskId === `${objective.id}:start`) {
              rootAttempts++;
              const tools = (await rpc("tools/list")).tools.map(
                (tool: { name: string }) => tool.name,
              );
              hidden.push(!tools.includes("request_action_approval"));
              if (rootAttempts === 1) {
                const first = await merge(1);
                requestId = first.requestId;
                results.push({ attempt: 1, statuses: [first.status, (await merge(1)).status] });
                await call("wait_for", { mailbox: true, reason: "Waiting for merge approval" });
              } else if (rootAttempts === 2) {
                const mailbox = await call("read_mailbox");
                const decision = mailbox.messages.find(
                  (message: { body: { approval?: { requestId?: string } } }) =>
                    message.body.approval?.requestId === requestId,
                );
                const granted = await merge(1);
                const consumed = await merge(1);
                results.push({
                  attempt: 2,
                  statuses: [granted.status, consumed.status],
                  decision: decision?.body.approval,
                });
              }
            }
          } catch (error) {
            errors.push(error);
            throw error;
          }
          yield {
            ...identity,
            type: "output.message",
            message: { role: "teammate", text: "Work completed" },
          };
          yield { ...identity, type: "execution.completed" };
        },
      };
      const local = new LocalWorklet("approval-worklet", "approval-host", [worker]);
      const durable = new DurableLocalWorklet(
        local,
        new FileAttemptJournal(join(directory, "journal")),
      );
      let connection: Awaited<ReturnType<typeof connectWorklet>> | undefined;
      const runtime = await startControlPlaneRuntime({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: url,
        adminToken: "test-admin",
        workletTransport: "remote",
        coordinationOperatorCredentials: [
          {
            token: "release-operator",
            operatorId: "release-operator",
            actions: ["list_approvals", "decide_approval"],
            objectiveIds: [objective.id],
          },
          {
            token: "outsider",
            operatorId: "outsider",
            actions: ["*"],
            objectiveIds: ["different-objective"],
          },
        ],
      });
      try {
        connection = await connectWorklet({
          url: `${runtime.url.replace(/^http/u, "ws")}/worklets`,
          credential: await enrollWorkerHost(runtime.url, "test-admin", "approval-host"),
          worklet: local,
          durableWorklet: durable,
          reconnectIntervalMs: 20,
        });
        const started = await fetch(`${runtime.url}/api/v1/coordination/start_objective`, {
          method: "POST",
          headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" },
          body: JSON.stringify({ objectiveId: objective.id }),
        });
        expect(started.status, await started.text()).toBe(200);
        await expect
          .poll(
            async () => {
              expect(errors).toEqual([]);
              return (await store.getTaskAssignment(`${objective.id}:start`))?.status;
            },
            { timeout: 15000 },
          )
          .toBe("waiting");
        expect(results[0]).toEqual({ attempt: 1, statuses: ["pending", "pending"] });

        const operator = { url: runtime.url, token: "release-operator" };
        const listed = await runApprovalCommand(operator, ["list", "--objective", objective.id]);
        expect(listed).toContain(requestId);
        expect(listed).toContain("pull-requests:merge");
        expect(listed).toContain(`Required by Permission Set: ${set.name}`);
        expect(listed).toContain(`supertag approve request ${requestId}`);
        const outsider = await fetch(
          `${runtime.url}/api/v1/coordination/approvals/${requestId}/approve`,
          {
            method: "POST",
            headers: { Authorization: "Bearer outsider", "Content-Type": "application/json" },
            body: "{}",
          },
        );
        expect(outsider.status).toBe(403);
        await expect(runApprovalCommand(operator, ["approve", requestId])).resolves.toContain(
          `Approval request ${requestId} approved (scope: once)`,
        );

        await expect
          .poll(
            () => {
              expect(errors).toEqual([]);
              return results.length;
            },
            { timeout: 15000 },
          )
          .toBe(2);
        expect(results[1]).toEqual({
          attempt: 2,
          statuses: ["granted", "pending"],
          decision: expect.objectContaining({
            requestId,
            decision: "approved",
            scope: "once",
          }),
        });
        expect(hidden).toEqual([true, true]);
        const approved = await runApprovalCommand(operator, [
          "list",
          "--objective",
          objective.id,
          "--status",
          "approved",
          "--output",
          "json",
        ]);
        expect(JSON.parse(approved).requests).toEqual([
          expect.objectContaining({
            id: requestId,
            status: "approved",
            decidedBy: "release-operator",
            decidedByKind: "operator",
            consumedAt: expect.any(String),
          }),
        ]);
      } finally {
        await connection?.stop();
        await runtime.close();
        await durable.shutdown("Test finished");
        await store.disconnect();
        await isolated?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    }, 45000);
  });
