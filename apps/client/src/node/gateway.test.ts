/**
 * Unit tests of the main process's Gateway backend: the cache, task files, new Tags, activity,
 * memories, network, schedules, and Watch registration.
 */
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MemorySchema } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/memories_pb";
import {
  ConversationMessageSchema,
  ConversationSchema,
  HarnessKind,
  HostPhase,
  LiveInputState,
  TagSchema,
  TaskEventKind,
  TaskFileLocationSchema,
  TaskNetworkLogSchema,
  TaskState,
  WatchChangeSchema,
  WatchKind,
  WatchReason,
  WorkerHostStatusSchema,
  WorkSessionCloseReason,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import {
  ScheduleSchema,
  ScheduleState,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/schedules_pb";
import {
  type CacheScope,
  entryPath,
  forget,
  gatewayDirectory,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  readEntry,
  validKey,
  writeEntry,
} from "./cache";
import { conversation, message } from "./convert";
import { activity, networkLog, note, schedule } from "./details";
import { endpoint, gatewayOrigin } from "./endpoint";
import { checkBearer, rpcError } from "./errors";
import { parseLocalGateway } from "./local";
import { branchToFollow, optionsOf, putTagRequest } from "./new-tag";
import { Code, ConnectError, createGatewayClient } from "./sdk";
import { Session } from "./session";
import { deviceName, GatewayState } from "./state";
import { list, looksLikeText, place, read } from "./task-files";
import { invalidation } from "./watch";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-gateway-unit-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("accepts only origin or tunnel URLs, and plaintext only on a loopback IP", () => {
  for (const value of [
    "http://127.0.0.1:4545",
    "http://[::1]:4545/",
    "https://gateway.example.com",
    "https://127.0.0.1:4545",
    "ws://127.0.0.1:4545",
    "ws://[::1]:4545/supertag",
    "wss://gateway.example.com",
    "wss://gateway.example.com:8443/supertag",
  ]) {
    expect(() => endpoint(value), value).not.toThrow();
  }
  for (const value of [
    "http://localhost:4545",
    "http://gateway.example.com",
    "http://192.168.0.1",
    "http://127.0.0.1:0",
    "file:///tmp/socket",
    "https://token@gateway.example.com",
    "https://gateway.example.com/path",
    "https://gateway.example.com/?token=secret",
    "https://gateway.example.com/#secret",
    "http://127.0.0.1\\@example.com",
    "127.0.0.1:4545",
    "ws://localhost:4545",
    "ws://gateway.example.com",
    "wss://token@gateway.example.com",
    "wss://gateway.example.com/?token=secret",
    "wss://gateway.example.com/#secret",
    "wss://gateway.example.com:0",
  ]) {
    expect(() => endpoint(value), value).toThrow();
  }
  expect(() => endpoint("http://gateway.example.com")).toThrow(
    "HTTP and WS require a loopback IP address. Use HTTPS or WSS for a remote Gateway.",
  );
  for (const token of ["", "secret\nvalue", "secret value", "secret\tvalue", "x".repeat(8193)]) {
    expect(() => checkBearer(token)).toThrow("Enter a valid operator token or Auth Key.");
  }
  expect(checkBearer("operator-test-token")).toBe("operator-test-token");
});

it("saves a Gateway under its origin, keeping only a tunnel's path", () => {
  expect(gatewayOrigin("http://127.0.0.1:4545/")).toBe("http://127.0.0.1:4545");
  expect(gatewayOrigin(" https://gateway.example.com:443 ")).toBe("https://gateway.example.com");
  expect(gatewayOrigin("ws://127.0.0.1:9/supertag")).toBe("ws://127.0.0.1:9/supertag");
  expect(gatewayOrigin("wss://gateway.example.com/")).toBe("wss://gateway.example.com");
  expect(() => gatewayOrigin(`https://${"a".repeat(2050)}.example`)).toThrow(
    "Enter a Gateway URL of up to 2048 characters.",
  );
});

it("never exposes upstream diagnostics, only the Gateway's invalid-argument reason", () => {
  const secret = "token-that-an-untrusted-server-echoed";
  for (const code of [Code.Unauthenticated, Code.Unknown, Code.Internal, Code.Unavailable]) {
    expect(rpcError(new ConnectError(secret, code))).not.toContain(secret);
  }
  expect(rpcError(new ConnectError(secret, Code.Unauthenticated))).toBe(
    "The Gateway rejected the saved credential.",
  );
  expect(rpcError(new Error(secret))).toBe("The Gateway request failed.");
  expect(
    rpcError(
      new ConnectError(
        "tag_id must be 1 to 64 lowercase letters, digits, or hyphens.\u001b[2J",
        Code.InvalidArgument,
      ),
    ),
  ).toBe(
    "The Gateway rejected this request: tag_id must be 1 to 64 lowercase letters, digits, or hyphens.[2J.",
  );
  expect(rpcError(new ConnectError("", Code.InvalidArgument))).toBe(
    "The Gateway rejected this request. Check its values.",
  );
  expect(rpcError(new ConnectError("x".repeat(5000), Code.InvalidArgument)).length).toBeLessThan(
    400,
  );
});

it("keeps structured live input state and camel-cased fields", () => {
  const shown = message(
    create(ConversationMessageSchema, {
      task: {
        taskId: "follower",
        tagId: "engineer",
        prompt: "Operator message",
        state: TaskState.QUEUED,
      },
      liveInput: {
        inputId: "input",
        taskId: "running",
        followerTaskId: "follower",
        state: LiveInputState.DISPATCHING,
        order: 4n,
      },
      events: [{ sequence: 3n, text: "Looking at the build.", kind: TaskEventKind.MESSAGE }],
      eventsTruncated: true,
      order: 9n,
      sentAtMs: 1000n,
    }),
  ) as unknown as Record<string, Record<string, unknown> & { [key: string]: unknown }>;
  const task = shown["task"] as Record<string, unknown>;
  expect(task["taskId"]).toBe("follower");
  expect(task["state"]).toBe("queued");
  expect(task["prompt"]).toBe("Operator message");
  expect(task).not.toHaveProperty("result");
  expect(task).not.toHaveProperty("quiet");
  expect(task["createdAtMs"]).toBe(1000);
  expect(shown).not.toHaveProperty("workSessionReportId");
  expect(shown).not.toHaveProperty("completedAtMs");
  expect(shown["liveInput"]).toMatchObject({ state: "dispatching", followerTaskId: "follower" });
  expect(shown["events"]).toEqual([
    { sequence: 3, kind: "message", text: "Looking at the build." },
  ]);
  expect(shown["eventsTruncated"]).toBe(true);
  expect(shown["order"]).toBe(9);
  expect(JSON.parse(JSON.stringify(shown))).toEqual(shown);
});

it("shows quiet turns and open questions", () => {
  const quiet = message(
    create(ConversationMessageSchema, {
      task: {
        taskId: "check",
        tagId: "engineer",
        state: TaskState.SUCCEEDED,
        result: "CI is green",
        quiet: true,
      },
      scheduleId: "schedule",
      order: 12n,
    }),
  );
  expect(quiet.task.quiet).toBe(true);
  const asking = conversation(
    create(ConversationSchema, {
      tagId: "engineer",
      preview: "Which branch should I release?",
      previewFromTag: true,
      unreadCount: 1,
      asking: true,
    }),
  );
  expect(asking.asking).toBe(true);
});

it("keeps a work Session report's result and identity but strips internal input", () => {
  const report = message(
    create(ConversationMessageSchema, {
      task: {
        taskId: "report-task",
        tagId: "engineer",
        sessionId: "conversation/planning",
        state: TaskState.SUCCEEDED,
        prompt: "Internal report instructions with raw child output",
        result: "The dependency update passed verification.",
        artifacts: [{ artifactId: "report-capture", paths: ["outputs/review.md"] }],
      },
      liveInput: { text: "Unexpected internal input" },
      workSessionReportId: "work/dependency",
      workSessionCloseReason: WorkSessionCloseReason.IDLE,
      order: 10n,
      sentAtMs: 1000n,
      completedAtMs: 2000n,
    }),
  );
  expect(report.workSessionReportId).toBe("work/dependency");
  expect(report.workSessionClosed).toBe("idle");
  expect(report.task).toMatchObject({
    taskId: "report-task",
    state: "succeeded",
    result: "The dependency update passed verification.",
  });
  expect(report.task).not.toHaveProperty("artifacts");
  expect(report.task).not.toHaveProperty("prompt");
  expect(report).not.toHaveProperty("liveInput");
  expect(report).not.toHaveProperty("eventsTruncated");
  expect(report.completedAtMs).toBe(2000);

  const summary = conversation(
    create(ConversationSchema, {
      tagId: "engineer",
      preview: "The dependency update passed verification.",
      previewFromTag: true,
      unreadCount: 2,
      working: true,
    }),
  );
  expect(summary).toMatchObject({ tagId: "engineer", previewFromTag: true, unreadCount: 2 });
  expect(summary.working).toBe(true);

  const scheduled = message(
    create(ConversationMessageSchema, {
      task: {
        taskId: "woken",
        tagId: "engineer",
        sessionId: "conversation/planning",
        state: TaskState.SUCCEEDED,
        prompt: "Scheduled wake-up.",
        result: "CI is green.",
      },
      liveInput: {},
      scheduleId: "sch_1",
      order: 11n,
    }),
  );
  expect(scheduled.scheduleId).toBe("sch_1");
  expect(scheduled.task).not.toHaveProperty("prompt");
  expect(scheduled).not.toHaveProperty("liveInput");
  expect(scheduled.task.result).toBe("CI is green.");
  expect(() => message(create(ConversationMessageSchema, {}))).toThrow(
    "The Gateway returned an incomplete message.",
  );
});

it("keeps cache entries scoped, private, bounded and forgettable", async () => {
  const cache = path.join(root, "cache");
  const alice: CacheScope = { gateway: "https://one.example.com", principal: "operator:alice" };
  const bob: CacheScope = { ...alice, principal: "client:bob" };
  const other: CacheScope = { ...alice, gateway: "https://two.example.com" };
  const value = { messages: [{ task: { taskId: "one" } }] };
  const file = entryPath(cache, alice, "tag:engineer");
  await writeEntry(file, value);
  expect(await readEntry(file)).toEqual(value);
  for (const scope of [bob, other]) {
    expect(entryPath(cache, scope, "tag:engineer")).not.toBe(file);
    expect(await readEntry(entryPath(cache, scope, "tag:engineer"))).toBeUndefined();
  }
  for (const key of ["roster", "outbox", "tag:engineer"]) expect(validKey(key)).toBe(true);
  for (const key of ["", "tag:", "other", "tag:a\nb", "../roster"])
    expect(validKey(key)).toBe(false);
  const mode = async (target: string) => (await stat(target)).mode & 0o777;
  expect(await mode(file)).toBe(0o600);
  expect(await mode(path.dirname(file))).toBe(0o700);
  await chmod(file, 0o644);
  expect(await readEntry(file)).toBeUndefined();

  for (let index = 0; index < MAX_ENTRIES + 3; index++) {
    await writeEntry(entryPath(cache, alice, `tag:t${index}`), index);
  }
  const kept = (await readdir(path.dirname(file))).filter((name) => name.endsWith(".json"));
  expect(kept).toHaveLength(MAX_ENTRIES);
  const latest = entryPath(cache, alice, `tag:t${MAX_ENTRIES + 2}`);
  await writeEntry(latest, "x".repeat(MAX_ENTRY_BYTES));
  expect(await readEntry(latest)).toBeUndefined();

  await forget(cache, alice.gateway);
  await expect(stat(gatewayDirectory(cache, alice.gateway))).rejects.toThrow();
});

it("lists and reads text only beneath the located root", async () => {
  const checkout = path.join(root, "checkout");
  await mkdir(path.join(checkout, "src"), { recursive: true });
  await mkdir(path.join(checkout, ".git"), { recursive: true });
  await writeFile(path.join(checkout, "src/app.py"), "print('hi')\n");
  await writeFile(path.join(checkout, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(checkout, "blob"), Buffer.from("a\0b"));
  await symlink("/etc/hosts", path.join(checkout, "hosts"));
  const located = (directory: string) =>
    create(TaskFileLocationSchema, {
      id: "attempt:a",
      kind: { case: "localPath", value: { path: directory } },
      live: true,
      hostId: "laptop",
    });

  const found = await place("c1", "t1", located(checkout));
  expect(found).toEqual({ local: true, live: true, hostId: "laptop" });
  const top = await list("c1", "t1", "");
  expect(top.map((entry) => [entry.name, entry.kind, entry.text])).toEqual([
    ["src", "directory", false],
    ["blob", "file", false],
    ["hosts", "link", false],
    ["logo.png", "file", false],
  ]);
  const nested = await list("c1", "t1", "src");
  expect(nested[0]?.path).toBe("src/app.py");
  expect(nested[0]?.text).toBe(true);
  expect((await read("c1", "t1", "src/app.py")).text).toBe("print('hi')\n");
  for (const refused of [
    "blob",
    "logo.png",
    "hosts",
    "../etc/passwd",
    "/etc/hosts",
    ".git/config",
  ]) {
    await expect(read("c1", "t1", refused), refused).rejects.toBeTypeOf("string");
  }
  await expect(list("c1", "t1", "..")).rejects.toBe("That path is outside the Task's files.");
  await expect(list("c1", "other-task", "")).rejects.toBe(
    "This Task's files aren't on this machine.",
  );

  // A path on another machine is unreachable and forgets the root.
  await place("c2", "t2", located(checkout));
  const gone = await place("c2", "t2", located("/no/such/checkout"));
  expect(gone.local).toBe(false);
  expect(gone.reason).toBe("Files on Worker Host laptop are unreachable from here.");
  await expect(list("c2", "t2", "")).rejects.toBeTypeOf("string");
  const remote = await place(
    "c2",
    "t3",
    create(TaskFileLocationSchema, {
      unavailableReason: "Files on Worker Host build-1 are unreachable from here.",
      hostId: "build-1",
    }),
  );
  expect(remote.reason).toBe("Files on Worker Host build-1 are unreachable from here.");
  expect(await place("c2", "t4", undefined)).toEqual({
    local: false,
    live: false,
    reason: "SuperTag doesn't know where this Task's files are.",
  });
});

it("sniffs text from its first bytes", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(looksLikeText(bytes("plain text"))).toBe(true);
  expect(looksLikeText(bytes("nul\0inside"))).toBe(false);
  expect(looksLikeText(bytes("café"))).toBe(true);
  expect(looksLikeText(bytes("café").subarray(0, 4)), "a cut character is still text").toBe(true);
  expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
});

it("gives a new Tag the lead Tag defaults and never replaces another", () => {
  const base = { tagId: "lead", harness: "claude_code" };
  const request = putTagRequest(
    { ...base, tagId: "reviewer", name: " Reviewer ", maxWorkSessions: 3, workspaceId: "supertag" },
    true,
  );
  expect(request).toMatchObject({
    tagId: "reviewer",
    name: "Reviewer",
    maxWorkSessions: 3,
    harnessKind: HarnessKind.CLAUDE_CODE,
    allowedActions: [
      "commands:execute",
      "files:read",
      "files:write",
      "schedule:create",
      "web:fetch",
    ],
    workspace: { workspaceId: "supertag", baseRef: "" },
    expectedRevision: 0n,
  });
  const plain = putTagRequest({ ...base, harness: "codex", name: "lead", workspaceId: "" }, true);
  expect(plain).not.toHaveProperty("name");
  expect(plain).not.toHaveProperty("workspace");
  expect(plain.allowedActions).toEqual([
    "commands:execute",
    "files:read",
    "files:write",
    "schedule:create",
    "web:fetch",
  ]);
  for (const harness of ["", "unspecified", "unknown", "1"]) {
    expect(() => putTagRequest({ ...base, harness }, true)).toThrow(
      "Choose a harness for the Tag.",
    );
  }
  // A Tag whose hosts run no commands gets none.
  expect(putTagRequest(base, false).allowedActions).toEqual([
    "files:read",
    "files:write",
    "schedule:create",
    "web:fetch",
  ]);
  // Cursor has no web fetch tool, and runs no Task that may use one.
  expect(putTagRequest({ ...base, harness: "cursor" }, true).allowedActions).not.toContain(
    "web:fetch",
  );
  // Web access is on unless the form switched it off.
  for (const harness of ["claude_code", "codex"]) {
    expect(putTagRequest({ ...base, harness, webAccess: false }, true).allowedActions).toEqual([
      "commands:execute",
      "files:read",
      "files:write",
      "schedule:create",
    ]);
  }
  // A folder just added names where Sessions start.
  expect(
    putTagRequest({ ...base, harness: "codex", workspaceId: "site", workspaceRef: "trunk" }, true)
      .workspace,
  ).toMatchObject({ workspaceId: "site", baseRef: "trunk" });
  const commit = "4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
  expect(
    putTagRequest({ ...base, workspaceId: "site", workspaceCommit: commit }, true).workspace
      ?.baseCommit,
  ).toBe(commit);
});

it("follows the branch its Workspace's lead follows", () => {
  const tag = (tagId: string, lead: boolean, workspaceId: string, baseRef: string) =>
    create(TagSchema, { tagId, lead, workspace: { workspaceId, baseRef } });
  const tags = [
    tag("other", false, "demo", "feature"),
    tag("lead", true, "demo", "main"),
    tag("elsewhere", true, "site", "trunk"),
    tag("pinned", false, "pinned", ""),
  ];
  expect(branchToFollow(tags, "demo")).toBe("main");
  expect(branchToFollow(tags, "site")).toBe("trunk");
  expect(branchToFollow(tags.slice(0, 1), "demo")).toBe("feature");
  expect(branchToFollow(tags, "pinned")).toBeUndefined();
  expect(branchToFollow(tags, "unknown")).toBeUndefined();
});

it("offers every ready host's harnesses and Workspaces", () => {
  const slot = (
    harnessKind: HarnessKind,
    unsandboxed: boolean,
    commandSandbox = false,
    remoteFileWorkspace = false,
  ) => ({
    harnessKind,
    executionProfile: {
      allowUnsandboxedCommands: unsandboxed,
      commandSandbox,
      remoteFileWorkspace,
    },
  });
  const host = (
    phase: HostPhase,
    harnesses: ReturnType<typeof slot>[],
    workspaceIds: string[],
    revokedAtMs?: bigint,
  ) =>
    create(WorkerHostStatusSchema, {
      phase,
      harnesses,
      workspaceIds,
      ...(revokedAtMs === undefined ? {} : { revokedAtMs }),
    });
  const laptop = host(
    HostPhase.READY,
    [slot(HarnessKind.CODEX, false), slot(HarnessKind.CLAUDE_CODE, false)],
    ["supertag", "site"],
  );
  expect(optionsOf([laptop])).toEqual({
    harnesses: ["claude_code", "codex"],
    workspaces: ["site", "supertag"],
    noCommands: ["claude_code"],
    noWeb: [],
  });
  expect(
    optionsOf([
      laptop,
      host(HostPhase.BUSY, [slot(HarnessKind.CLAUDE_CODE, true)], []),
      host(HostPhase.OFFLINE, [slot(HarnessKind.OPENCODE, false)], ["stale"]),
      host(HostPhase.READY, [slot(HarnessKind.CURSOR, true)], ["revoked"], 1n),
    ]),
  ).toEqual({
    harnesses: ["claude_code", "codex"],
    workspaces: ["site", "supertag"],
    noCommands: [],
    noWeb: [],
  });
  // A Claude Code lane that runs commands in Claude Code's own sandbox runs them too.
  const sandboxed = host(
    HostPhase.READY,
    [slot(HarnessKind.CLAUDE_CODE, false, true)],
    ["supertag"],
  );
  expect(optionsOf([sandboxed]).noCommands).toEqual([]);
  // A lane that runs Tasks in a remote sandbox or local-vm container has no network.
  const vm = host(
    HostPhase.READY,
    [slot(HarnessKind.CLAUDE_CODE, false, false, true)],
    ["supertag"],
  );
  expect(optionsOf([vm])).toMatchObject({ noCommands: [], noWeb: ["claude_code"] });
  expect(optionsOf([vm, sandboxed]).noWeb).toEqual([]);
  expect(optionsOf([])).toEqual({ harnesses: [], workspaces: [], noCommands: [], noWeb: [] });
});

it("shows a Tag's activity, notes, network log and Schedules as the window reads them", () => {
  const shown = activity(
    create(TagSchema, {
      attention: { posted: 4, read: 2, answered: 1, quiet: 7, windowDays: 30 },
      startRate: { starts: 10, perMs: 3_600_000n },
      startsInWindow: 3,
      idleObjectives: [
        { objectiveId: "ship", outcome: "Ship SSO", idleSinceMs: 1_900_000_000_000n },
      ],
    }),
  );
  expect(shown).toEqual({
    windowDays: 30,
    posted: 4,
    read: 2,
    answered: 1,
    quiet: 7,
    startRate: { starts: 10, perMs: 3_600_000, inWindow: 3 },
    idleObjectives: [{ objectiveId: "ship", outcome: "Ship SSO", idleSinceMs: 1_900_000_000_000 }],
  });
  const without = activity(create(TagSchema, {}));
  expect(without).not.toHaveProperty("startRate");
  expect(without).not.toHaveProperty("idleObjectives");

  const kept = note(
    create(MemorySchema, {
      memoryId: "mem_1",
      tagId: "lead",
      text: "Alice prefers squash merges.",
      audience: "operator:alice",
      createdBy: "tag:lead",
      createdAtMs: 1n,
      updatedAtMs: 2n,
      lastSeenAtMs: 3n,
    }),
  );
  expect(kept).toMatchObject({ memoryId: "mem_1", private: true, lastSeenAtMs: 3 });
  expect(kept).not.toHaveProperty("audience");
  const shared = note(create(MemorySchema, {}));
  expect(shared.private).toBe(false);
  expect(shared).not.toHaveProperty("lastSeenAtMs");

  const log = networkLog(
    create(TaskNetworkLogSchema, {
      taskId: "task",
      attemptId: "attempt",
      log: {
        requests: [
          {
            atMs: 5n,
            method: "CONNECT",
            origin: "https://example.org",
            allowed: false,
            reason: "origin is not in the Task's network scope",
          },
        ],
        allowed: 3n,
        denied: 1n,
      },
    }),
  );
  expect([log.allowed, log.denied]).toEqual([3, 1]);
  expect(log.requests[0]?.origin).toBe("https://example.org");
  expect(log.requests[0]).not.toHaveProperty("status");
  expect(log.requests[0]).not.toHaveProperty("credential");

  const paused = schedule(
    create(ScheduleSchema, {
      scheduleId: "sch_1",
      tagId: "lead",
      note: "Summarize open work",
      state: ScheduleState.PAUSED,
      every: { cron: "0 9 * * MON", timeZone: "Europe/Berlin" },
      nextDueAtMs: 1_900_000_000_000n,
      createdBy: "tag:lead",
    }),
  );
  expect(paused.state).toBe("paused");
  expect(paused.every?.timeZone).toBe("Europe/Berlin");
  expect(paused.nextDueAtMs).toBe(1_900_000_000_000);
  expect(paused).not.toHaveProperty("atMs");
});

it("tells the window which views a Watch change invalidates", () => {
  const change = (init: Parameters<typeof create<typeof WatchChangeSchema>>[1]) =>
    invalidation(create(WatchChangeSchema, init));
  expect(change({ kind: WatchKind.TAG, id: "engineer" })).toEqual({ kind: "tag" });
  expect(change({ kind: WatchKind.CONVERSATION_MESSAGE, tagId: "engineer" })).toEqual({
    kind: "conversation",
    tagId: "engineer",
  });
  // Creation has the message's own notice; later changes to a conversation's Tasks count.
  expect(
    change({
      kind: WatchKind.TASK,
      tagId: "engineer",
      sessionId: "conversation/x",
      reason: WatchReason.CREATED,
    }),
  ).toBeUndefined();
  expect(
    change({
      kind: WatchKind.TASK,
      tagId: "engineer",
      sessionId: "conversation/x",
      reason: WatchReason.CHANGED,
    }),
  ).toEqual({ kind: "conversation", tagId: "engineer" });
  // A Task outside a conversation (a Work Session's, an Objective's, a surface thread's) is work.
  expect(change({ kind: WatchKind.TASK, tagId: "engineer", sessionId: "slack:T1/C1/1.0" })).toEqual(
    { kind: "work", tagId: "engineer", sessionId: "slack:T1/C1/1.0" },
  );
  expect(change({ kind: WatchKind.TASK, tagId: "engineer", sessionId: "" })).toBeUndefined();
  expect(change({ kind: WatchKind.OBJECTIVE, id: "ship", objectiveId: "ship" })).toEqual({
    kind: "objective",
    objectiveId: "ship",
  });
  expect(change({ kind: WatchKind.WORKSTREAM_POST, id: "p", teamId: "release" })).toEqual({
    kind: "team",
    teamId: "release",
  });
  expect(change({ kind: WatchKind.TEAM, teamId: "" })).toBeUndefined();
  expect(change({ kind: WatchKind.MEMORY, tagId: "engineer" })).toEqual({
    kind: "memory",
    tagId: "engineer",
  });
  expect(change({ kind: WatchKind.MEMORY, tagId: "" })).toBeUndefined();
  expect(change({ kind: WatchKind.SCHEDULE, tagId: "lead" })).toEqual({
    kind: "schedule",
    tagId: "lead",
  });
});

it("fences the Watch registration by epoch, stop and disconnect", () => {
  const state = new GatewayState({
    store: path.join(root, "unused.json"),
    cache: path.join(root, "unused-cache"),
    buildVersion: "test",
    discoverLocal: async () => {
      throw "none";
    },
  });
  // Nothing is dialed: the SDK negotiates on the first call, which never comes.
  const session = () =>
    new Session(createGatewayClient({ url: "http://127.0.0.1:1", token: "operator-token" }));
  const scope = { gateway: "https://example.com", principal: "operator:test" };
  const first = state.adopt(session(), "https://example.com", scope);
  const old = state.registerWatch(first, 1);
  const current = state.registerWatch(first, 3);
  expect(old.stop.aborted).toBe(true);
  expect(() => state.registerWatch(first, 2)).toThrow("The Watch subscription changed.");
  state.stopWatch(old.id);
  expect(current.stop.aborted).toBe(false);

  state.disconnect();
  expect(current.stop.aborted).toBe(true);
  const second = state.adopt(session(), "https://example.com", scope);
  expect(second).not.toBe(first);
  const replacement = state.registerWatch(second, 1);
  expect(() => state.registerWatch(first, 4)).toThrow("The connection changed. Refresh this view.");
  state.stopWatch(current.id);
  expect(replacement.stop.aborted).toBe(false);
  state.disconnect();
});

it("reads the local Gateway as __local-gateway reports it, never trusting other shapes", () => {
  expect(
    parseLocalGateway(
      JSON.stringify({
        protocol: "local-gateway.v2",
        running: false,
        state_directory: "/s",
        set_up: false,
        machine_id: null,
        message: "SuperTag isn't set up on this machine yet.",
      }),
    ),
  ).toEqual({
    running: false,
    stateDirectory: "/s",
    setUp: false,
    machineId: null,
    message: "SuperTag isn't set up on this machine yet.",
  });
  expect(() =>
    parseLocalGateway(
      JSON.stringify({ protocol: "local-gateway.v2", running: true, state_directory: "/s" }),
    ),
  ).toThrow();
});

it("names this device as a client from its host name", () => {
  expect(deviceName("alice's MacBook Pro.local")).toBe("alice-s-MacBook-Pro.local");
  expect(deviceName("")).toBe("device");
  expect(deviceName("x".repeat(300))).toHaveLength(250);
});
