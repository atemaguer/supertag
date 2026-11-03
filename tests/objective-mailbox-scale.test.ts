import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ObjectiveController } from "../packages/control-plane/src/objective-controller.js";
import {
  COORDINATION_CAPABILITY,
  LocalWorklet,
  type Worker,
} from "../packages/runtime/sdk/src/index.js";
import { DrizzleStore, migrateDatabase } from "../packages/store/src/index.js";
import { durableTestWorklet } from "./support/durable-test-worklet.js";

it("drains a duplicated 100-recipient mailbox burst through bounded Worker execution after Control Plane restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-mailbox-scale-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  await store.connect();
  let controller: ObjectiveController | undefined;
  const errors: unknown[] = [];
  const received = new Map<string, number>();
  let active = 0,
    peak = 0;
  try {
    const prefix = randomUUID();
    const profile = { id: "mailbox-burst", revision: "1" };
    const owner = await store.createTag({ name: `${prefix}-owner` });
    await store.bindTagWorkerHost(owner.id, "burst-host");
    const objective = await store.createObjective({
      id: prefix,
      ownerTagId: owner.id,
      outcome: "Handle a burst of findings",
      budgetLimitMinor: 100,
    });
    const recipients = [];
    for (let i = 0; i < 100; i++) {
      const recipient = await store.createTag({ name: `${prefix}-${i}` });
      await store.bindTagWorkerHost(recipient.id, "burst-host");
      recipients.push(recipient);
    }
    // A separate lead keeps the owner outside these Teams, so its messages cross a Team boundary,
    // use the grants below, and become Tasks instead of same-Team direct messages.
    const lead = await store.createTag({ name: `${prefix}-lead` });
    for (let offset = 0; offset < 100; offset += 50)
      await store.createTeam({
        id: `${prefix}-team-${offset}`,
        objectiveId: prefix,
        name: `Team ${offset}`,
        leadTagId: lead.id,
        memberTagIds: recipients.slice(offset, offset + 50).map((tag) => tag.id),
        maxConcurrency: 7,
      });
    for (const recipient of recipients)
      await store.setTagMessagingGrant({
        senderTagId: owner.id,
        recipientTagId: recipient.id,
        messageTypes: ["progress.updated"],
      });
    const worker: Worker = {
      async describe() {
        return {
          profileCapabilities: [
            { profile: profile, capabilities: [COORDINATION_CAPABILITY], contextTypes: [] },
          ],
          id: "burst-worker",
          type: "deterministic",
          capabilities: [COORDINATION_CAPABILITY],
          profiles: [profile],
          contextTypes: [],
          maxConcurrency: 7,
        };
      },
      async *execute(spec, signal) {
        active++;
        peak = Math.max(peak, active);
        try {
          if (spec.tag.id !== owner.id) {
            const source = await store.getTaskAssignmentSourceMessage(spec.taskId);
            expect(source).toBeDefined();
            expect(source?.recipientTagId).toBe(spec.tag.id);
            expect(source?.body["finding"]).toBe(`Evidence for ${spec.tag.id}`);
            expect(spec.authorization.runtimeActions).toEqual([]);
            const serializedContext = spec.input.messages
              .filter((m) => m.role === "system")
              .map((m) => m.text)
              .join("\n");
            expect(serializedContext).toContain(source?.id);
            received.set(spec.tag.id, (received.get(spec.tag.id) ?? 0) + 1);
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          signal?.throwIfAborted();
          const identity = {
            taskId: spec.taskId,
            attemptId: spec.attemptId,
            at: new Date().toISOString(),
          };
          yield {
            ...identity,
            type: "output.message",
            message: {
              role: "teammate",
              text: "Finding assessed; no automatic acknowledgement reply needed.",
            },
          };
          yield { ...identity, type: "execution.completed" };
        } finally {
          active--;
        }
      },
    };
    const worklet = durableTestWorklet(new LocalWorklet("burst-worklet", "burst-host", [worker]));
    controller = new ObjectiveController(store, worklet, (error) => errors.push(error));
    controller.activateCoordination({ url: "http://127.0.0.1:3434" });
    await controller.command("start_objective", { objectiveId: objective.id });
    const admissions = await Promise.all(
      recipients.flatMap((recipient) =>
        Array.from({ length: 3 }, () =>
          store.enqueueTagMessage({
            senderTagId: owner.id,
            recipientTagId: recipient.id,
            objectiveId: objective.id,
            type: "progress.updated",
            body: { finding: `Evidence for ${recipient.id}`, runtimeActions: ["commands:execute"] },
            idempotencyKey: `${prefix}:${recipient.id}`,
          }),
        ),
      ),
    );
    expect(admissions.filter((result) => !result.duplicate)).toHaveLength(100);
    expect(new Set(admissions.map((result) => result.message.id)).size).toBe(100);
    await store.admitMailboxTaskAssignments();
    expect(
      (await store.listTaskAssignments(prefix)).filter((task) => task.sourceMessageId),
    ).toHaveLength(100);
    await controller.stop();
    await store.disconnect();
    await store.connect();
    controller = new ObjectiveController(store, worklet, (error) => errors.push(error));
    controller.activateCoordination({ url: "http://127.0.0.1:3434" });
    controller.start();
    // 100 Mailbox Tasks run at most 7 at a time on controller ticks; a 2-CPU runner took 24 s.
    await expect
      .poll(
        async () =>
          (await store.listTagMessages(owner.id, 200)).filter((m) => m.status === "processed")
            .length,
        { timeout: 50000 },
      )
      .toBe(100);
    await controller.stop();
    expect(received.size).toBe(100);
    expect([...received.values()].every((count) => count === 1)).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(7);
    expect(active).toBe(0);
    expect(errors).toEqual([]);
    const tasks = await store.listTaskAssignments(prefix);
    expect(tasks).toHaveLength(101);
    expect(tasks.every((task) => task.attemptCount === 1)).toBe(true);
    // Deliveries close on settlement, and so does the owner's own start activation.
    expect(
      tasks.filter((task) => task.sourceMessageId).every((task) => task.status === "accepted"),
    ).toBe(true);
    expect(tasks.filter((task) => !task.sourceMessageId).map((task) => task.status)).toEqual([
      "accepted",
    ]);
    expect((await store.getObjective(prefix)).reservedMinor).toBe(0);
  } finally {
    await controller?.stop();
    await store.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
