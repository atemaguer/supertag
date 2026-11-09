import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  ActivityStatus,
  FollowEventSchema,
  ReplyPresentation,
  ReplyStatus,
  WorkSessionStatus,
} from "./src/gen/supertag/operator/v1/conversation_pb.js";
import {
  FollowEventAdapter,
  followEventsToUIMessageStream,
  type UIMessageChunk,
} from "./src/ui-message-stream.js";

type EventInit = MessageInitShape<typeof FollowEventSchema>;
const event = (init: EventInit) => create(FollowEventSchema, init);

const reply = { presentation: ReplyPresentation.FINAL_RESULT, text: "Done." };
const workSession = {
  id: "ses_work",
  title: "Fix the export",
  taskId: "task_work",
  status: WorkSessionStatus.RUNNING,
  reportStatus: ReplyStatus.WAITING,
};
const message = {
  taskId: "task_1",
  tag: "builder",
  conversation: "default",
  sessionId: "ses_1",
  text: "Fix the export",
  createdAt: timestampFromDate(new Date("2026-11-08T09:00:00Z")),
  status: ReplyStatus.REPLIED,
  reply,
  workSessions: [workSession],
};

function run(events: EventInit[]): UIMessageChunk[] {
  const adapter = new FollowEventAdapter({ messageId: "task_1" });
  return events.flatMap((init) => adapter.push(event(init)));
}

describe("FollowEventAdapter", () => {
  it("maps a running turn with text, activity, work Sessions and end", () => {
    const chunks = run([
      { sequence: 1n, part: { case: "waiting", value: { reason: "no bound Worker Host" } } },
      { sequence: 0n, part: { case: "heartbeat", value: {} } },
      { sequence: 2n, part: { case: "textDelta", value: { text: "Looking" } } },
      { sequence: 3n, part: { case: "textDelta", value: { text: " now." } } },
      {
        sequence: 4n,
        part: {
          case: "activity",
          value: {
            text: "running: pnpm test",
            detail: {
              case: "command",
              value: { id: "c1", command: "pnpm test", status: ActivityStatus.RUNNING },
            },
          },
        },
      },
      {
        sequence: 5n,
        part: {
          case: "activity",
          value: {
            detail: {
              case: "command",
              value: { id: "c1", command: "pnpm test", status: ActivityStatus.COMPLETED },
            },
          },
        },
      },
      { sequence: 6n, part: { case: "textDelta", value: { text: "Started." } } },
      { sequence: 7n, part: { case: "finish", value: { reply, message } } },
      {
        sequence: 8n,
        part: {
          case: "activity",
          value: {
            workSessionId: "ses_work",
            text: "using: github.create_pull_request",
            detail: {
              case: "tool",
              value: {
                id: "t1",
                tool: "github.create_pull_request",
                status: ActivityStatus.RUNNING,
              },
            },
          },
        },
      },
      {
        sequence: 9n,
        part: {
          case: "workSessionChanged",
          value: {
            workSession: {
              ...workSession,
              status: WorkSessionStatus.COMPLETED,
              reportStatus: ReplyStatus.REPLIED,
              reportTaskId: "task_report",
              report: { presentation: ReplyPresentation.FINAL_RESULT, text: "Merged." },
            },
          },
        },
      },
      { sequence: 10n, part: { case: "end", value: { message } } },
    ]);

    expect(chunks).toEqual([
      { type: "start", messageId: "task_1" },
      { type: "data-waiting", id: "waiting", data: { reason: "no bound Worker Host" } },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Looking" },
      { type: "text-delta", id: "text-1", delta: " now." },
      { type: "text-end", id: "text-1" },
      {
        type: "data-activity",
        id: "command:c1",
        data: {
          text: "running: pnpm test",
          command: { id: "c1", command: "pnpm test", status: "ACTIVITY_STATUS_RUNNING" },
        },
      },
      {
        type: "data-activity",
        id: "command:c1",
        data: { command: { id: "c1", command: "pnpm test", status: "ACTIVITY_STATUS_COMPLETED" } },
      },
      { type: "text-start", id: "text-2" },
      { type: "text-delta", id: "text-2", delta: "Started." },
      { type: "text-end", id: "text-2" },
      {
        type: "data-reply",
        id: "reply",
        data: { presentation: "REPLY_PRESENTATION_FINAL_RESULT", text: "Done." },
      },
      {
        type: "data-work-session",
        id: "ses_work",
        data: {
          id: "ses_work",
          title: "Fix the export",
          taskId: "task_work",
          status: "WORK_SESSION_STATUS_RUNNING",
          reportStatus: "REPLY_STATUS_WAITING",
        },
      },
      {
        type: "data-activity",
        id: "ses_work:tool:t1",
        data: {
          workSessionId: "ses_work",
          text: "using: github.create_pull_request",
          tool: {
            id: "t1",
            tool: "github.create_pull_request",
            status: "ACTIVITY_STATUS_RUNNING",
          },
        },
      },
      {
        type: "data-work-session",
        id: "ses_work",
        data: {
          id: "ses_work",
          title: "Fix the export",
          taskId: "task_work",
          status: "WORK_SESSION_STATUS_COMPLETED",
          reportStatus: "REPLY_STATUS_REPLIED",
          reportTaskId: "task_report",
          report: { presentation: "REPLY_PRESENTATION_FINAL_RESULT", text: "Merged." },
        },
      },
      {
        type: "finish",
        messageMetadata: {
          message: expect.objectContaining({
            taskId: "task_1",
            createdAt: "2026-11-08T09:00:00Z",
            status: "REPLY_STATUS_REPLIED",
          }),
        },
      },
    ]);
  });

  it("writes a finished turn's stored reply as text", () => {
    const chunks = run([
      { sequence: 1n, part: { case: "finish", value: { reply, message: { taskId: "task_1" } } } },
      { sequence: 2n, part: { case: "end", value: { message: { taskId: "task_1" } } } },
    ]);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "data-reply",
      "finish",
    ]);
    expect(chunks[2]).toEqual({ type: "text-delta", id: "text-1", delta: "Done." });
  });

  it("writes the stored reply as text once when a resumed call sends finish again", () => {
    const adapter = new FollowEventAdapter({ messageId: "task_1" });
    const first = adapter.push(event({ sequence: 1n, part: { case: "finish", value: { reply } } }));
    const resumed = adapter.push(
      event({ sequence: 2n * 2n ** 31n + 1n, part: { case: "finish", value: { reply } } }),
    );
    expect(first.filter((chunk) => chunk.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text-1", delta: "Done." },
    ]);
    expect(resumed).toEqual([
      {
        type: "data-reply",
        id: "reply",
        data: { presentation: "REPLY_PRESENTATION_FINAL_RESULT", text: "Done." },
      },
    ]);
  });

  it("maps a joined turn and its error", () => {
    const chunks = run([
      { sequence: 1n, part: { case: "joined", value: { taskId: "task_0" } } },
      { sequence: 2n, part: { case: "textDelta", value: { text: "Hm" } } },
      { sequence: 3n, part: { case: "error", value: { text: "The Task failed" } } },
      { sequence: 4n, part: { case: "end", value: {} } },
    ]);
    expect(chunks).toEqual([
      { type: "start", messageId: "task_1" },
      { type: "data-joined", id: "joined", data: { taskId: "task_0" } },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hm" },
      { type: "text-end", id: "text-1" },
      { type: "error", errorText: "The Task failed" },
      { type: "finish", messageMetadata: { message: null } },
    ]);
  });

  it("keys retries and skips repeated sequences, heartbeats, and events after end", () => {
    const adapter = new FollowEventAdapter();
    const retry = event({
      sequence: 1n,
      part: {
        case: "activity",
        value: {
          text: "retrying (Task Attempt 2)",
          detail: { case: "retry", value: { attempt: 2 } },
        },
      },
    });
    expect(adapter.push(event({ sequence: 0n, part: { case: "heartbeat", value: {} } }))).toEqual(
      [],
    );
    expect(adapter.push(retry)).toEqual([
      { type: "start" },
      {
        type: "data-activity",
        id: "retry:2",
        data: { text: "retrying (Task Attempt 2)", retry: { attempt: 2 } },
      },
    ]);
    expect(adapter.push(retry)).toEqual([]);
    expect(adapter.lastSequence).toBe(1n);
    adapter.push(event({ sequence: 2n, part: { case: "end", value: {} } }));
    expect(adapter.ended).toBe(true);
    expect(
      adapter.push(event({ sequence: 3n, part: { case: "textDelta", value: { text: "late" } } })),
    ).toEqual([]);
  });

  it("keeps text block state across a resumed call", () => {
    const adapter = new FollowEventAdapter();
    const first = adapter.push(
      event({ sequence: 1n, part: { case: "textDelta", value: { text: "a" } } }),
    );
    const resumed = adapter.push(
      event({ sequence: 2n, part: { case: "textDelta", value: { text: "b" } } }),
    );
    expect(first.at(-1)).toEqual({ type: "text-delta", id: "text-1", delta: "a" });
    expect(resumed).toEqual([{ type: "text-delta", id: "text-1", delta: "b" }]);
  });
});

describe("followEventsToUIMessageStream", () => {
  it("closes at end and stops reading the call", async () => {
    let returned = false;
    async function* events() {
      try {
        yield event({ sequence: 0n, part: { case: "heartbeat", value: {} } });
        yield event({ sequence: 1n, part: { case: "textDelta", value: { text: "Hi" } } });
        yield event({ sequence: 2n, part: { case: "end", value: {} } });
        yield event({ sequence: 3n, part: { case: "textDelta", value: { text: "never" } } });
      } finally {
        returned = true;
      }
    }
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of followEventsToUIMessageStream(events(), { messageId: "task_1" }))
      chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(returned).toBe(true);
  });
});
