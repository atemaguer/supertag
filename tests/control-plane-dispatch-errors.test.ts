import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DispatchErrorReporter } from "../packages/control-plane/src/dispatch-errors.ts";
import { ControlPlane } from "../packages/control-plane/src/index.ts";
import { LocalWorklet, StaticWorker } from "../packages/runtime/sdk/src/index.ts";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.ts";

it("reports distinct errors immediately and counts repeated errors without an unbounded cache", () => {
  let now = 0;
  const sink = vi.fn();
  const reporter = new DispatchErrorReporter(sink, () => now);
  const absent = new Error("No remote Worklet is connected");
  reporter.report(absent);
  for (let index = 0; index < 100; index++) reporter.report(new Error(absent.message));
  expect(sink).toHaveBeenCalledTimes(1);
  reporter.report(new Error("Database unavailable"));
  expect(sink).toHaveBeenCalledTimes(2);
  now = 5000;
  reporter.report(absent);
  expect(sink.mock.calls[2]?.[0].message).toContain("(101 additional occurrences)");
  reporter.report(absent);
  for (let index = 0; index < 128; index++) reporter.report(new Error(`distinct ${index}`));
  expect(
    sink.mock.calls.some(([error]) => error.message.includes("(1 additional occurrence)")),
  ).toBe(true);
  const before = sink.mock.calls.length;
  reporter.report(absent);
  expect(sink).toHaveBeenCalledTimes(before + 1);
  reporter.report(absent);
  reporter.flush();
  expect(sink.mock.calls.at(-1)?.[0].message).toContain("(1 additional occurrence)");
});
it("isolates diagnostics callback failures", () => {
  const reporter = new DispatchErrorReporter(() => {
    throw new Error("sink failed");
  });
  expect(() => {
    reporter.report(new Error("dispatch failed"));
    reporter.report(new Error("dispatch failed"));
    reporter.flush();
  }).not.toThrow();
});
it("paces missing Worklet checks and dispatches when capacity returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-dispatch-pacing-"));
  const url = `file:${join(directory, "state.db")}`;
  await migrateDatabase({ url });
  const store = new DrizzleStore({ url });
  const native = new LocalWorklet("test-worklet", "test-host", [new StaticWorker()]);
  let available = false;
  let failedChecks = 0;
  const errors = vi.fn();
  const controlPlane = new ControlPlane({
    store,
    credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    worklet: {
      id: "test-worklet",
      describe: async () => {
        if (!available) {
          failedChecks++;
          throw new Error("No remote Worklet is connected");
        }
        return native.describe();
      },
      selectExecution: (...args) => native.selectExecution(...args),
      execute: (...args) => native.execute(...args),
    },
    reply: async () => {},
    dispatch: { pollIntervalMs: 5, onDispatchError: errors },
  });
  try {
    await controlPlane.start();
    const account = await controlPlane.setupSurfaceAccount({
      provider: "slack",
      externalAccountId: "T-PACE",
      displayName: "Pacing",
      authMethod: "slack-socket-mode",
      configuration: {},
      secrets: { botToken: "fake", appToken: "fake" },
    });
    const tag = await store.createTag({ name: "Pacing" });
    await store.bindTagWorkerHost(tag.id, "test-host");
    await store.addTagRoute({ tagId: tag.id, surfaceAccountId: account.id, scope: "channel:C1" });
    const admission = await controlPlane.ingestSurfaceEvent({
      eventId: "one",
      logicalEventId: "one",
      provider: "slack",
      externalAccountId: "T-PACE",
      kind: "mention",
      scope: "channel:C1",
      sessionKey: "slack:T-PACE:C1:1",
      actor: { id: "U1", kind: "user" },
      text: "Say hello",
      occurredAt: new Date().toISOString(),
      callback: {
        provider: "slack",
        mode: "slack_thread",
        threadKey: "T-PACE|C1|1",
        target: { channelId: "C1", threadTs: "1" },
      },
      source: {},
      metadata: {},
    });
    await expect.poll(() => failedChecks, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    expect(failedChecks).toBeLessThanOrEqual(4);
    expect(errors).toHaveBeenCalledTimes(1);
    available = true;
    await expect
      .poll(async () => (await store.findTaskById(admission.taskId as string))?.status, {
        timeout: 3000,
      })
      .toBe("completed");
    expect(await store.listTaskAttempts(admission.taskId as string)).toHaveLength(1);
  } finally {
    await controlPlane.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
