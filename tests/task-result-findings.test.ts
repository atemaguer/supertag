import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskResourceFromStore } from "../apps/cli/src/control-plane-resources.ts";
import type { SurfaceTagAuthorizationSnapshot, Task } from "../packages/core/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { createIsolatedPostgresDatabase } from "./support/database.js";

const postgres = process.env["SUPERTAG_POSTGRES_URL"];
const lists = { decisions: [], changes: [], unresolved: [], references: [], artifacts: [] };

function storedFindings(task: Task | undefined): unknown {
  return (task?.result as Record<string, unknown> | undefined)?.["findings"];
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgres)(
    `${dialect} Task result findings`,
    // Each fixture migrates a fresh database, which can take seconds under a parallel run.
    { timeout: 30_000 },
    () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      });

      /** A store, and a way to open a pending Session Task of a Tag, as an inbound message does. */
      async function fixture() {
        let url: string;
        if (dialect === "postgresql") {
          if (!postgres) throw new Error("Missing test database");
          const isolated = await createIsolatedPostgresDatabase(postgres);
          cleanups.push(isolated.cleanup);
          url = isolated.url;
        } else {
          const directory = await mkdtemp(join(tmpdir(), "supertag-findings-"));
          cleanups.push(() => rm(directory, { recursive: true, force: true }));
          url = `file:${join(directory, "state.db")}`;
        }
        await migrateDatabase({ url });
        const store = new DrizzleStore({ url });
        await store.connect();
        cleanups.push(() => store.disconnect());
        const tag = await store.createTag({ name: `reviewer-${randomUUID()}` });
        await store.bindTagWorkerHost(tag.id, "fixture-host");
        const account = await store.saveSurfaceAccount({
          provider: "slack",
          externalAccountId: randomUUID(),
          displayName: "Slack",
          authMethod: "test",
          credentialId: "test",
          status: "connected",
          configuration: {},
          verifiedAt: new Date().toISOString(),
        });
        const route = await store.addTagRoute({
          tagId: tag.id,
          surfaceAccountId: account.id,
          scope: "channel:review",
        });

        const openTask = async (sessionKey: string): Promise<Task> => {
          const at = new Date().toISOString();
          const authorization: SurfaceTagAuthorizationSnapshot = {
            version: 5,
            capturedAt: at,
            tag: { id: tag.id, name: tag.name },
            origin: {
              provider: "slack",
              surfaceAccountId: account.id,
              tagRouteId: route.id,
              scope: "channel:review",
            },
            requester: { id: "human", kind: "user" },
            roles: [],
            permissionSets: [],
            resources: [],
            runtimeActions: [],
          };
          const contextPlan = { version: 7, capturedAt: at, sets: [] } as const;
          const event = {
            eventId: randomUUID(),
            logicalEventId: randomUUID(),
            provider: "slack",
            externalAccountId: account.externalAccountId,
            kind: "message",
            scope: "channel:review",
            sessionKey,
            actor: { id: "human", kind: "user" },
            text: "Review the change",
            occurredAt: at,
            callback: {
              provider: "slack",
              mode: "slack_thread",
              threadKey: sessionKey,
              target: { channelId: "review", threadTs: sessionKey },
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
            sessionKey,
            origin: {},
            at,
          });
          return store.openTask({
            inboundEventId: admitted.work.id,
            tagId: tag.id,
            sessionId: session.id,
            execution: {},
            actor: event.actor,
            trigger: {},
            workspacePlan: { version: 1, status: "none" },
            sessionHistory: [],
            authorizationSnapshot: authorization,
            contextPlan,
            createdAt: at,
          });
        };

        const close = (task: Task, findings: unknown[]) =>
          store.closeTask({
            taskId: task.id,
            status: "completed",
            endedAt: new Date().toISOString(),
            result: {
              summary: "Reviewed",
              ...lists,
              findings,
            } as never,
          });

        return {
          store,
          tag,
          a: await openTask(`conversation-a-${randomUUID()}`),
          b: await openTask(`conversation-b-${randomUUID()}`),
          close,
        };
      }

      it("records findings for the settling Task only, with Control Plane ids", async () => {
        const f = await fixture();
        await f.close(f.a, [
          // The Worker's own identifier is replaced, in result order.
          { id: "F9", severity: "medium", summary: "Missing guard", location: "src/a.ts:10" },
          { severity: "high", summary: "Unchecked input" },
        ]);

        const recorded = [
          { id: "F1", severity: "medium", summary: "Missing guard", location: "src/a.ts:10" },
          { id: "F2", severity: "high", summary: "Unchecked input" },
        ];
        expect(storedFindings(await f.store.findTaskById(f.a.id))).toEqual(recorded);
        const b = await f.store.findTaskById(f.b.id);
        expect(b).toMatchObject({ status: "pending" });
        expect(b?.result ?? null).toBeNull();
      });

      it("shows a Task's stored findings grouped by severity in `describe task`", async () => {
        const f = await fixture();
        await f.close(f.a, [
          { severity: "medium", summary: "Missing guard", location: "src/a.ts:10" },
          { severity: "high", summary: "Unchecked input" },
        ]);
        const resource = await taskResourceFromStore(
          f.store,
          (await f.store.findTaskById(f.a.id)) as Task,
        );
        expect(resource.status.findings).toEqual({
          high: [{ id: "F2", severity: "high", summary: "Unchecked input" }],
          medium: [
            { id: "F1", severity: "medium", summary: "Missing guard", location: "src/a.ts:10" },
          ],
          low: [],
        });
        const other = await taskResourceFromStore(
          f.store,
          (await f.store.findTaskById(f.b.id)) as Task,
        );
        expect(other.status.findings).toBeUndefined();
      });

      it("reads a corrupt stored findings record as unreadable instead of failing the view", async () => {
        const f = await fixture();
        await f.close(f.a, [{ severity: "high", summary: "Unchecked input" }]);
        const task = (await f.store.findTaskById(f.a.id)) as Task;
        // Simulates a record corrupted in storage: settlement itself refuses such findings.
        const corrupt = {
          ...task,
          result: { ...(task.result as object), findings: [{ id: "F1", severity: "critical" }] },
        } as Task;
        const resource = await taskResourceFromStore(f.store, corrupt);
        expect(resource.status.findings).toEqual({
          unreadable:
            "Stored Task result findings are invalid: Task finding severity must be high, medium, or low",
        });
      });

      it("refuses a finding that names a Task or carries an unknown severity", async () => {
        const f = await fixture();
        await expect(
          f.close(f.a, [{ severity: "high", summary: "Belongs elsewhere", taskId: f.b.id }]),
        ).rejects.toThrow(/not allowed/u);
        await expect(
          f.close(f.a, [{ severity: "critical", summary: "Unknown severity" }]),
        ).rejects.toThrow(/high, medium, or low/u);

        for (const task of [f.a, f.b]) {
          const stored = await f.store.findTaskById(task.id);
          expect(stored).toMatchObject({ status: "pending" });
          expect(stored?.result ?? null).toBeNull();
        }
      });

      it("refuses findings that are not a list, and an empty or hidden-character summary", async () => {
        const f = await fixture();
        await expect(f.close(f.a, "F1: broken" as never)).rejects.toThrow(/must be an array/u);
        await expect(f.close(f.a, [{ severity: "low", summary: "   " }])).rejects.toThrow(
          /must not be empty/u,
        );
        await expect(
          f.close(f.a, [{ severity: "low", summary: "Hidden​character" }]),
        ).rejects.toThrow(/invisible characters/u);
      });

      it("records no findings when the result carries none", async () => {
        const f = await fixture();
        await f.close(f.a, []);
        expect(storedFindings(await f.store.findTaskById(f.a.id))).toEqual([]);
        const resource = await taskResourceFromStore(
          f.store,
          (await f.store.findTaskById(f.a.id)) as Task,
        );
        expect(resource.status.findings).toBeUndefined();
      });
    },
  );
}
