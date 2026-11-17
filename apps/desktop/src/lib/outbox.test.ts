import { beforeEach, expect, it, vi } from "vitest";
import type { CacheKey, Gateway, Message } from "../gateway";
import { SCHEMA_VERSION } from "./conversation-cache";
import { clearOutbox, discard, resumeOutbox, retry, send } from "./outbox";

function gateway(fail: () => boolean) {
  const disk = new Map<CacheKey, unknown>();
  const sent = vi.fn(async (tagId: string, text: string, operationId: string): Promise<Message> => {
    if (fail()) throw new Error("The Gateway is unavailable.");
    return {
      order: 1,
      task: { taskId: operationId, tagId, sessionId: "s", prompt: text, state: "queued" },
    };
  });
  const plane = {
    scope: "scope",
    send: sent,
    readCache: async (key: CacheKey) => disk.get(key),
    writeCache: async (key: CacheKey, value: unknown) => {
      disk.set(key, structuredClone(value));
    },
  } as unknown as Gateway;
  return { plane, disk, sent };
}

const queued = (disk: Map<CacheKey, unknown>) =>
  (disk.get("outbox") as { value: { text: string; error?: string }[] }).value;

beforeEach(() => clearOutbox());

it("keeps a failed message queued, on disk, and retries it with its operation ID", async () => {
  let failing = true;
  const { plane, disk, sent } = gateway(() => failing);
  expect(await send(plane, "lead", "Fix the build")).toBeUndefined();
  expect(queued(disk)).toMatchObject([{ text: "Fix the build", error: expect.any(String) }]);
  const operationId = sent.mock.calls[0]?.[2] ?? "";
  failing = false;
  const accepted = await retry(plane, operationId);
  expect(accepted?.task.taskId).toBe(operationId);
  expect(sent.mock.calls[1]?.[2]).toBe(operationId);
  expect(queued(disk)).toEqual([]);
});

it("sends what a previous run left queued, once", async () => {
  const { plane, disk, sent } = gateway(() => false);
  disk.set("outbox", {
    schemaVersion: SCHEMA_VERSION,
    value: [{ tagId: "lead", text: "Left over", operationId: "op-1", createdAtMs: 1 }],
  });
  await resumeOutbox(plane);
  await resumeOutbox(plane);
  expect(sent.mock.calls).toEqual([["lead", "Left over", "op-1"]]);
  expect(queued(disk)).toEqual([]);
});

it("discards a message on request", async () => {
  const { plane, disk, sent } = gateway(() => true);
  await send(plane, "lead", "Never mind");
  discard(plane, sent.mock.calls[0]?.[2] ?? "");
  expect(queued(disk)).toEqual([]);
});
