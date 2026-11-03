import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";

import { TEAM_REPLY_COALESCE_WINDOW_MS } from "../packages/store/src/team-reply-triggers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

// Adopted from security-review artifact c757199a324185f02d3a7b87efcb78cbe2fc48f5f7bc6073b67d40e428d42896.
it.each(["unset", "role", "tag"] as const)(
  "reply uses current %s defaults and reserves budget without inheriting execution",
  async (settings) => {
    const directory = await mkdtemp(join(tmpdir(), "supertag-reply-effort-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const url = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url });
    const store = new DrizzleStore({ url });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const owner = await store.createTag({ name: randomUUID() });
    const sender = await store.createTag({ name: randomUUID() });
    const recipient = await store.createTag({ name: randomUUID() });
    if (settings === "tag")
      await store.setTagExecution(recipient.id, {
        harness: "codex",
        model: ["tag-model"],
        effort: ["medium", "high"],
      });
    const objective = await store.createObjective({
      id: randomUUID(),
      ownerTagId: owner.id,
      outcome: "x",
      runtimeActions: [],
      budgetLimitMinor: 200,
      budgetCurrency: "USD",
    });
    const team = await store.createTeam({
      id: randomUUID(),
      objectiveId: objective.id,
      name: "B",
      leadTagId: owner.id,
      memberTagIds: [sender.id, recipient.id],
    });
    const snap = (id: string, name: string) => ({
      version: 4 as const,
      capturedAt: new Date().toISOString(),
      tag: { id, name },
      origin: { kind: "internal" as const, objectiveId: objective.id, requestedByTagId: owner.id },
      requester: { id: owner.id, kind: "bot" as const },
      permissionSets: [],
      resources: [],
      runtimeActions: [],
    });
    const base = {
      objectiveId: objective.id,
      teamId: team.id,
      requestedByTagId: owner.id,
      acceptanceCriteria: ["x"],
      contextPlan: { version: 7 as const, capturedAt: new Date().toISOString(), sets: [] },
      workspacePlan: { version: 1 as const, status: "none" as const },
    };
    const start = await store.admitTaskAssignment({
      ...base,
      taskId: randomUUID(),
      assignedTagId: owner.id,
      startObjectiveExecution: true,
      instruction: "Start",
      execution: {},
      authorizationSnapshot: snap(owner.id, owner.name),
    });
    await store.cancelTaskAssignment(start.taskId, owner.id);
    const prior = await store.admitTaskAssignment({
      ...base,
      taskId: randomUUID(),
      assignedTagId: recipient.id,
      instruction: "Deep review",
      maxCostMinor: 20,
      execution: {
        harness: "opencode",
        effort: "high",
        model: "big-model",
        limits: { maxReportedCost: { amountMinor: 20, currency: "USD" } },
      },
      authorizationSnapshot: snap(recipient.id, recipient.name),
    });
    await store.cancelTaskAssignment(prior.taskId, owner.id);
    if (settings !== "unset") {
      // Create in reverse name order to exercise the same Role precedence as ordinary assignment.
      for (const name of ["Z", "A"]) {
        const role = await store.createRole({
          name: `${name}-${randomUUID()}`,
          purpose: "Answer",
          instructions: "",
          contextSetIds: [],
          permissionSetIds: [],
          execution: { harness: "codex", model: [`role-${name}`], effort: ["low", "high"] },
        });
        await store.assignRole({ roleId: role.id, tagId: recipient.id });
      }
    }
    await store.postWorkstream({
      workstreamId: team.id,
      authorTagId: sender.id,
      type: "question",
      to: [recipient.id],
      body: "?",
      idempotencyKey: randomUUID(),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + TEAM_REPLY_COALESCE_WINDOW_MS);
    const [reply] = (await store.admitMailboxTaskAssignments()).filter(
      (t) => t.assignedTagId === recipient.id,
    );
    const execution = await store.findTaskById(reply?.taskId ?? "missing");
    expect(execution?.execution).toEqual(
      settings === "unset"
        ? { effort: "low" }
        : {
            harness: "codex",
            model: settings === "tag" ? "tag-model" : "role-A",
            effort: settings === "tag" ? "medium" : "low",
          },
    );
    expect(reply?.reservedMinor).toBe(100);
    expect((await store.getObjective(objective.id)).reservedMinor).toBe(100);
  },
);
