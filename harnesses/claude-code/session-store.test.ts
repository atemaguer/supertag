import { expect, test } from "vitest";
import { ClaudeSessionStore, type ClaudeTranscript } from "./src/session-store.js";

const key = { projectKey: "/worker-a/workspace", sessionId: "native-session" };

test("restores complete native history and subagents after replacing the adapter", async () => {
  let persisted = "[]";
  const first = new ClaudeSessionStore(async (_session, transcripts) => {
    persisted = JSON.stringify(transcripts);
  });
  const user = { type: "user", uuid: "user-1", message: { content: "original evidence" } };
  await Promise.all([
    first.append(key, [user]),
    first.append(key, [user, { type: "system", subtype: "compact_boundary", uuid: "compact-1" }]),
    first.append({ ...key, subpath: "subagents/agent-child.jsonl" }, [
      { type: "assistant", uuid: "child-1", message: "child evidence" },
    ]),
    first.append(key, [{ type: "custom-title", customTitle: "No UUID" }]),
  ]);
  await first.flush();
  const second = new ClaudeSessionStore(
    async () => {},
    JSON.parse(persisted) as ClaudeTranscript[],
  );
  const moved = { ...key, projectKey: "/worker-b/workspace" };
  expect(await second.load(moved)).toEqual([
    user,
    { type: "system", subtype: "compact_boundary", uuid: "compact-1" },
    { type: "custom-title", customTitle: "No UUID" },
  ]);
  expect(await second.listSubkeys(moved)).toEqual(["subagents/agent-child.jsonl"]);
  expect(await second.load({ ...moved, subpath: "subagents/agent-child.jsonl" })).toEqual([
    { type: "assistant", uuid: "child-1", message: "child evidence" },
  ]);
});

test("a failed batch is kept once whether or not the SDK retries it", async () => {
  let fail = true;
  let persisted: readonly ClaudeTranscript[] = [];
  const save = async (_session: string, transcripts: readonly ClaudeTranscript[]) => {
    if (fail) throw new Error("storage unavailable");
    persisted = transcripts;
  };
  const marker = [{ type: "custom-title", customTitle: "marker" }];
  const later = [{ type: "user", uuid: "user-2", message: { content: "later" } }];

  // The SDK retries the failed batch: its entries without a uuid are kept once.
  const retried = new ClaudeSessionStore(save, [], []);
  await expect(retried.append(key, marker)).rejects.toThrow("storage unavailable");
  fail = false;
  await retried.append(key, marker);
  expect(persisted[0]?.entries).toEqual(marker);
  await expect(retried.flush()).resolves.toBeUndefined();

  // No retry: the failed batch is committed before the next one, not lost.
  fail = true;
  const unretried = new ClaudeSessionStore(save, [], []);
  await expect(unretried.append(key, marker)).rejects.toThrow("storage unavailable");
  fail = false;
  await unretried.append(key, later);
  expect(persisted[0]?.entries).toEqual([...marker, ...later]);
  await expect(unretried.flush()).resolves.toBeUndefined();
});

test("flush retries an unsaved history before failing, and reports the cause", async () => {
  let failures = 2;
  let persisted: readonly ClaudeTranscript[] = [];
  const retrying = new ClaudeSessionStore(
    async (_session, transcripts) => {
      if (failures-- > 0) throw new Error("Control Plane request timed out");
      persisted = transcripts;
    },
    [],
    [0, 0],
  );
  const entries = [{ type: "user", uuid: "user-1", message: { content: "evidence" } }];
  await expect(retrying.append(key, entries)).rejects.toThrow("timed out");
  await retrying.flush();
  expect(persisted[0]?.entries).toEqual(entries);

  const failing = new ClaudeSessionStore(
    async () => {
      throw new Error("Control Plane request timed out");
    },
    [],
    [0, 0],
  );
  await expect(failing.append(key, entries)).rejects.toThrow("timed out");
  await expect(failing.flush()).rejects.toThrow(
    "Claude Session persistence failed: Control Plane request timed out",
  );
});
