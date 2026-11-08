import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import {
  objectiveSessionKey,
  type SurfaceTagAuthorizationSnapshot,
  type Task,
} from "../packages/core/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";
import { enrollWorkerHost } from "./support/worker-host-enrollment.js";

/**
 * Recovery parity for the surface path. The two turns belong to one Objective Session, so the
 * second is due only once the first settles: whatever a real gRPC Worklet's abrupt death leaves
 * behind, SuperTag never replays the interrupted Attempt and never starts the next turn until
 * the interrupted one is resolved.
 */
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
        // The Objective has no home thread, so its turns run on the Tag's CLI account and their
        // replies are recorded rather than sent: no surface credential is involved.
        const account = await store.saveSurfaceAccount({
          provider: "cli",
          externalAccountId: "control-plane",
          displayName: "CLI",
          authMethod: "operator",
          credentialId: "surface/cli/control-plane",
          status: "connected",
          configuration: {},
          verifiedAt: new Date().toISOString(),
        });
        const route = { id: `cli:${tag.id}`, scope: "cli" };
        const sessionKey = objectiveSessionKey(objective.id);
        const at = new Date().toISOString();
        const authorization: SurfaceTagAuthorizationSnapshot = {
          version: 5,
          capturedAt: at,
          tag: { id: tag.id, name: tag.name },
          origin: {
            provider: "cli",
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            scope: route.scope,
          },
          requester: { id: "supertag", kind: "bot" },
          roles: [],
          permissionSets: [],
          resources: [],
          runtimeActions: termination === "SIGKILL-codex" ? ["commands:execute"] : [],
        };

        /** One turn of the Objective's conversation; its request text names the turn. */
        const deliver = async (turn: "interrupt" | "after-restart") => {
          const text =
            termination === "SIGKILL-codex"
              ? turn === "interrupt"
                ? "INTERRUPT: run the command sleep 120 and wait for it to finish before replying. Do not do anything else."
                : "Reply with exactly RECOVERY_OK. Do not run tools or delegate."
              : turn === "interrupt"
                ? "INTERRUPT and wait"
                : "Reply after the restart";
          const admitted = await store.admitInboundEvent({
            surfaceAccountId: account.id,
            tagRouteId: route.id,
            tagId: tag.id,
            authorization,
            contextPlan: { version: 7, capturedAt: new Date().toISOString(), sets: [] },
            execution: { profile: { id: "recovery", revision: "1" } },
            event: {
              eventId: `${turn}-${randomUUID()}`,
              logicalEventId: `${turn}-${randomUUID()}`,
              provider: "cli",
              externalAccountId: account.externalAccountId,
              kind: "message",
              scope: route.scope,
              sessionKey,
              actor: { id: "supertag", displayName: "SuperTag", kind: "bot" },
              text,
              occurredAt: new Date().toISOString(),
              callback: {
                provider: "cli",
                mode: "cli_conversation",
                threadKey: sessionKey,
                target: {},
              },
              source: {},
              metadata: {},
              internal: {
                kind: "delivery",
                from: { kind: "supertag" },
                reason: turn === "interrupt" ? "objective_start" : "objective_message",
                objectiveId: objective.id,
              },
            },
          });
          return admitted.work.id;
        };
        /** The Task the Control Plane opened for one admitted turn. */
        const taskOf = async (inboundEventId: string, timeout = 15000): Promise<Task> => {
          await expect
            .poll(
              async () =>
                (await store.listTasks({})).some((task) => task.inboundEventId === inboundEventId),
              { timeout },
            )
            .toBe(true);
          const task = (await store.listTasks({})).find(
            (candidate) => candidate.inboundEventId === inboundEventId,
          );
          if (!task) throw new Error("Missing Task");
          return task;
        };
        const cancel = async (taskId: string) => {
          const response = await fetch(`${runtime.url}/api/v1/tasks/${taskId}/cancel`, {
            method: "POST",
            headers: { authorization: "Bearer test-admin" },
          });
          expect([200, 202]).toContain(response.status);
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
        const interruptEvent = await deliver("interrupt");
        const interrupt = await taskOf(interruptEvent);
        await expect
          .poll(
            async () =>
              (await store.listTaskEvents(interrupt.id)).some(
                (event) => event.type === "execution.started",
              ),
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
        if (termination === "SIGTERM-cancelled") await cancel(interrupt.id);
        await stopChild(termination.startsWith("SIGKILL") ? "SIGKILL" : "SIGTERM");
        await runtime.close();
        const afterEvent = await deliver("after-restart");
        runtime = await startControlPlaneRuntime(options);
        await connect();

        // The interrupted Attempt is recorded once and never replayed, whatever killed its host.
        await expect
          .poll(async () => (await store.findInboundEventById(interruptEvent))?.sessionBlocked, {
            timeout: 30000,
          })
          .toBe(true);
        expect(
          (await readFile(join(directory, "executions"), "utf8"))
            .split("\n")
            .filter((line) => line === "interrupt"),
        ).toHaveLength(1);
        expect(await store.listTaskAttempts(interrupt.id)).toHaveLength(1);
        expect((await store.findInboundEventById(interruptEvent))?.lastError).toContain(
          termination === "SIGTERM-cancelled"
            ? "Cancellation cleanup has not been confirmed"
            : "Execution completion could not be confirmed",
        );

        // Its Session takes no further turn: the next turn stays pending and never executes.
        await new Promise((settle) => setTimeout(settle, 1000));
        expect((await store.findInboundEventById(afterEvent))?.status).toBe("pending");
        expect((await store.listTasks({})).some((task) => task.inboundEventId === afterEvent)).toBe(
          false,
        );
        expect((await readFile(join(directory, "executions"), "utf8")).trim().split("\n")).toEqual([
          "interrupt",
        ]);

        // Only an operator on the Worker Host can settle it; the inbox names the exact command.
        const inbox = await store.readCoordinationInbox({ objectiveId: objective.id });
        expect(
          inbox.items.find(
            (item) =>
              item.kind === "task_attention" &&
              item.evidence.some((entry) => entry.kind === "task" && entry.id === interrupt.id),
          ),
        ).toMatchObject({ operatorEligible: true });
      } finally {
        await stopChild("SIGKILL");
        await runtime.close();
        await store.disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    },
    process.env["SUPERTAG_LIVE_CLEANUP_RECOVERY"] === "1" ? 180000 : 75000,
  );
