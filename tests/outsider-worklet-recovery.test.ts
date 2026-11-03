import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { emptyTagContextPlan } from "../packages/core/src/index.js";
import { FileAttemptJournal } from "../packages/runtime/sdk/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

for (const termination of process.env["SUPERTAG_LIVE_CLEANUP_RECOVERY"] === "1"
  ? ["SIGKILL-codex"]
  : ["SIGTERM", "SIGTERM-cancelled", "SIGKILL"])
  it(
    `real gRPC Worklet ${termination} preserves recovery safety across Control Plane restart`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "supertag-outsider-recovery-"));
      const databaseUrl = `file:${join(directory, "state.db")}`;
      await migrateDatabase({ url: databaseUrl });
      const store = new DrizzleStore({ url: databaseUrl });
      await store.connect();
      const options = {
        host: "127.0.0.1",
        port: 0,
        databaseUrl,
        workletTransport: "remote" as const,
        workletGrpc: { port: 0 },
        adminToken: "test-admin",
        credentialVault: new FileGatewayCredentialVault(join(directory, "vault")),
      };
      let runtime = await startControlPlaneRuntime(options);
      let child: ChildProcess | undefined;
      let stderr = "";
      const stopChild = async (signal: NodeJS.Signals) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill(signal);
        await exited;
      };
      try {
        const hostId = "recovery-host";
        const credential = await enrollWorkerHost(runtime.url, "test-admin", hostId);
        const tag = await store.createTag({ name: "recovery" });
        await store.bindTagWorkerHost(tag.id, hostId);
        const objective = await store.createObjective({
          id: "objective",
          ownerTagId: tag.id,
          outcome: "Recover safely",
        });
        const team = await store.createTeam({
          id: "team",
          objectiveId: objective.id,
          leadTagId: tag.id,
          memberTagIds: [],
          maxConcurrency: 1,
          name: "Recovery",
        });
        const assign = async (taskId: string) => {
          const at = new Date().toISOString();
          await store.admitTaskAssignment({
            taskId,
            objectiveId: objective.id,
            teamId: team.id,
            assignedTagId: tag.id,
            requestedByTagId: tag.id,
            instruction:
              termination === "SIGKILL-codex"
                ? taskId === "interrupt"
                  ? "Run the command sleep 120 and wait for it to finish before replying. Do not do anything else."
                  : "Reply with exactly RECOVERY_OK. Do not run tools or delegate."
                : taskId,
            acceptanceCriteria: ["Complete"],
            execution: { profile: { id: "recovery", revision: "1" } },
            authorizationSnapshot: {
              version: 4,
              capturedAt: at,
              tag: { id: tag.id, name: tag.name },
              origin: { kind: "internal", objectiveId: objective.id, requestedByTagId: tag.id },
              requester: { id: tag.id, kind: "user" },
              permissionSets: [],
              resources: [],
              runtimeActions: termination === "SIGKILL-codex" ? ["commands:execute"] : [],
            },
            contextPlan: emptyTagContextPlan(at),
            workspacePlan: { version: 1, status: "none" },
          });
        };
        const connect = async () => {
          if (!runtime.workletGrpcUrl) throw new Error("Missing gRPC endpoint");
          child = spawn(
            process.execPath,
            [
              "--conditions=development",
              "--import",
              "tsx",
              resolve("tests/fixtures/outsider-recovery-worklet.ts"),
              runtime.workletGrpcUrl,
              directory,
              hostId,
            ],
            {
              cwd: resolve("."),
              env: { ...process.env, SUPERTAG_TEST_WORKLET_CREDENTIAL: credential },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let ready = false;
          child.stdout?.on("data", (value) => {
            if (String(value).includes("ready")) ready = true;
          });
          child.stderr?.on("data", (value) => {
            stderr += String(value);
          });
          await expect
            .poll(
              () => {
                if (child?.exitCode !== null) throw new Error(stderr);
                return ready;
              },
              { timeout: 15000 },
            )
            .toBe(true);
        };
        await connect();
        await assign("interrupt");
        await expect
          .poll(
            async () =>
              (await store.listTaskEvents("interrupt")).some((e) => e.type === "execution.started"),
            { timeout: 15000 },
          )
          .toBe(true);
        if (termination === "SIGKILL-codex") {
          // Wait for a recorded native process group, not merely the Worker's started event.
          const groups = async () => {
            const registry = join(
              directory,
              "attempt-roots",
              `.supertag-attempt-owners-${process.getuid?.() ?? "local"}`,
            );
            const result: number[] = [];
            for (const root of await readdir(registry).catch(() => [])) {
              if (!root.startsWith("supertag-attempt-")) continue;
              for (const name of await readdir(join(registry, root))) {
                if (!name.startsWith("process-") || !name.endsWith(".json")) continue;
                const record = JSON.parse(await readFile(join(registry, root, name), "utf8"));
                if (record.state === "recorded") result.push(record.groupPid);
              }
            }
            return result;
          };
          await expect
            .poll(
              async () =>
                (await groups()).some((group) => {
                  try {
                    return /codex/i.test(
                      execFileSync("ps", ["-p", String(group), "-o", "command="], {
                        encoding: "utf8",
                      }),
                    );
                  } catch {
                    return false;
                  }
                }),
              { timeout: 30000 },
            )
            .toBe(true);
          // Kill the supervisor first so it cannot publish a graceful terminal receipt.
          await stopChild("SIGKILL");
          for (const group of await groups()) {
            try {
              process.kill(-group, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        }
        // Cancel with the original observer absent, while the Worklet journals cleanup offline.
        if (termination === "SIGTERM-cancelled") await runtime.close();
        await stopChild(termination.startsWith("SIGKILL") ? "SIGKILL" : "SIGTERM");
        if (termination !== "SIGTERM-cancelled") await runtime.close();
        if (termination === "SIGTERM-cancelled")
          await store.updateTaskAssignment(
            "interrupt",
            { expectedStatus: "running", status: "cancelled" },
            tag.id,
          );
        await assign("after-restart");
        runtime = await startControlPlaneRuntime(options);
        await connect();
        if (termination === "SIGKILL") {
          // Abrupt death leaves an unknown outcome: never replay a possibly side-effecting Attempt.
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(
            (await readFile(join(directory, "executions"), "utf8"))
              .split("\n")
              .filter((x) => x === "interrupt"),
          ).toHaveLength(1);
          await store.updateTaskAssignment(
            "interrupt",
            { expectedStatus: "running", status: "cancelled" },
            tag.id,
          );
          // Unknown execution cannot safely be declared stopped merely by cancelling its Task.
          expect((await store.getTaskAssignment("after-restart"))?.status).toBe("queued");
          // Explicit recovery is allowed only offline and only after operator confirmation.
          await stopChild("SIGKILL");
          const journal = new FileAttemptJournal(join(directory, "journal"));
          await journal.initialize();
          try {
            const attempt = (await store.listTaskAttempts("interrupt"))[0];
            if (!attempt) throw new Error("Missing interrupted Attempt");
            journal.confirmStopped(
              attempt.id,
              "interrupt",
              "Test operator verified all fixture execution stopped",
            );
          } finally {
            await journal.close();
          }
          await connect();
          await expect
            .poll(async () => (await store.getTaskAssignment("after-restart"))?.status, {
              timeout: 15000,
            })
            .toBe("submitted");
          await expect
            .poll(
              async () =>
                (await store.listTaskEvents("interrupt")).some(
                  (e) => e.type === "task.cancellation-cleanup-confirmed",
                ),
              { timeout: 10000 },
            )
            .toBe(true);
          const evidence = (await store.listTaskEvents("interrupt")).find(
            (e) => e.type === "task.cancellation-cleanup-confirmed",
          );
          expect(evidence?.payload?.["cleanupEvidence"]).toEqual([
            expect.stringContaining("Test operator verified"),
          ]);
          expect(
            (await readFile(join(directory, "executions"), "utf8")).trim().split("\n"),
          ).toEqual(["interrupt", "after-restart"]);
        } else {
          await expect
            .poll(async () => (await store.getTaskAssignment("after-restart"))?.status, {
              timeout: termination === "SIGKILL-codex" ? 120000 : 45000,
            })
            .toBe("submitted");
          if (termination === "SIGKILL-codex") {
            expect((await store.getTaskAssignment("after-restart"))?.result?.["text"]).toContain(
              "RECOVERY_OK",
            );
            expect((await store.getTaskAssignment("interrupt"))?.status).toBe("failed");
            expect(
              (await store.listTaskEvents("interrupt")).some(
                (e) =>
                  e.type === "execution.failed" &&
                  JSON.stringify(e.payload).includes("InterruptedExecutionOutcomeUnknown"),
              ),
            ).toBe(true);
          }
          if (termination === "SIGTERM-cancelled") {
            expect((await store.getTaskAssignment("interrupt"))?.status).toBe("cancelled");
            await expect
              .poll(
                async () =>
                  (await store.listTaskEvents("interrupt")).some(
                    (event) => event.type === "task.cancellation-cleanup-confirmed",
                  ),
                { timeout: 5000 },
              )
              .toBe(true);
            expect((await store.listTaskAttempts("interrupt"))[0]?.status).toBe("cancelled");
          }
          expect(
            (await readFile(join(directory, "executions"), "utf8")).trim().split("\n"),
          ).toEqual(["interrupt", "after-restart"]);
        }
      } finally {
        await stopChild("SIGKILL");
        await runtime.close();
        await store.disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    },
    process.env["SUPERTAG_LIVE_CLEANUP_RECOVERY"] === "1" ? 180000 : 75000,
  );
