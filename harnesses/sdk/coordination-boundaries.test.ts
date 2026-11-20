import { expect, it } from "vitest";
import type { harnessClient } from "./src/rust-harness/client.js";
import { registerCoordinationTools } from "./src/rust-harness/coordination.js";
import {
  type HarnessRun,
  MessageKind,
  TagMessageOrigin,
} from "./src/rust-harness/gen/supertag/runtime/v2/runtime_pb.js";

type Handler = (
  input: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

/** The tools a turn with these capabilities registers, and the requests its calls send. */
function register(coordination: Partial<NonNullable<HarnessRun["coordination"]>>) {
  const registered = new Map<string, { spec: { inputSchema: unknown }; handler: Handler }>();
  const requests: { method: string; input: Record<string, unknown> }[] = [];
  const server = {
    registerTool(name: string, spec: { inputSchema: unknown }, handler: Handler) {
      registered.set(name, { spec, handler });
    },
  };
  const mailbox = {
    async askTag(input: Record<string, unknown>) {
      requests.push({ method: "askTag", input });
      return { messageId: "ask-1", duplicate: false, wakeDeferred: "" };
    },
    async sendMessage(input: Record<string, unknown>) {
      requests.push({ method: "sendMessage", input });
      return {
        duplicate: false,
        wakeDeferred: "",
        message: {
          messageId: "answer-1",
          senderTagId: "lead",
          recipientTagId: "",
          sourceTaskId: "task",
          objectiveId: input.recipientObjectiveId,
          text: input.text,
          origin: TagMessageOrigin.DIRECT,
          kind: MessageKind.NOTE,
        },
      };
    },
  };
  const clients = {
    mailbox,
    options: () => ({}),
  } as unknown as ReturnType<typeof harnessClient>;
  const result = registerCoordinationTools(
    server as never,
    clients,
    {
      task: { taskId: "task", tagId: "lead", sessionId: "session" } as HarnessRun["task"],
      mayAskObjectiveQuestion: coordination.mayAskObjectiveQuestion ?? false,
      coordination: coordination as HarnessRun["coordination"],
    },
    {
      taskId: "task",
      tagId: "lead",
      attemptId: "attempt",
      secrets: [],
      signal: new AbortController().signal,
      active: () => true,
    },
    { questionOperationPrefix: "test" },
  );
  return { tools: result.tools, registered, requests };
}

const call = (handler: Handler | undefined, input: Record<string, unknown>) =>
  handler?.(input, { signal: new AbortController().signal });

it("gives an Objective's Session ask_tag and no tool that reaches another Tag", async () => {
  const objective = register({
    mayAskObjectiveQuestion: true,
    mayStartWorkSession: true,
    mayContinueWorkSession: true,
    mayAskTag: true,
  });
  expect(objective.tools).toEqual(
    expect.arrayContaining(["ask", "ask_tag", "start_session", "continue_session"]),
  );
  for (const tool of ["send_message", "read_mailbox", "post", "read_workstream"])
    expect(objective.tools).not.toContain(tool);
  // A Work Session always runs on its parent's Tag: start_session takes no Tag.
  const start = objective.registered.get("start_session")?.spec.inputSchema as {
    shape: Record<string, unknown>;
  };
  expect(Object.keys(start.shape)).not.toContain("tag");

  const asked = await call(objective.registered.get("ask_tag")?.handler, {
    text: "Have a Tag review commit abc",
  });
  expect(asked?.isError).toBeUndefined();
  expect(JSON.parse(asked?.content[0]?.text ?? "{}")).toMatchObject({
    status: "asked",
    messageId: "ask-1",
  });
  expect(objective.requests).toEqual([
    {
      method: "askTag",
      input: expect.objectContaining({ text: "Have a Tag review commit abc" }),
    },
  ]);
});

it("lets the inbox Session reach other Tags and answer its Objectives", async () => {
  const inbox = register({ maySendTagMessage: true, mayReadMailbox: true, mayUseWorkstream: true });
  expect(inbox.tools).toEqual(
    expect.arrayContaining(["send_message", "read_mailbox", "post", "read_workstream"]),
  );
  expect(inbox.tools).not.toContain("ask_tag");
  const send = inbox.registered.get("send_message")?.handler;
  const answered = await call(send, { objective: "goal", text: "Reviewed: approved." });
  expect(JSON.parse(answered?.content[0]?.text ?? "{}")).toMatchObject({
    status: "answered",
    messageId: "answer-1",
  });
  expect(inbox.requests).toEqual([
    {
      method: "sendMessage",
      input: expect.objectContaining({
        recipientObjectiveId: "goal",
        text: "Reviewed: approved.",
      }),
    },
  ]);
  // An answer names one recipient and carries no review.
  for (const input of [
    { objective: "goal", to: "other", text: "Both." },
    { objective: "goal", text: "Answer.", review: { commit: "ab".repeat(20) } },
  ])
    expect((await call(send, input))?.isError).toBe(true);
});

it("keeps a person conversation's reach to other Tags", () => {
  const conversation = register({
    maySendTagMessage: true,
    mayReadMailbox: true,
    mayStartWorkSession: true,
  });
  expect(conversation.tools).toEqual(expect.arrayContaining(["send_message", "read_mailbox"]));
  expect(conversation.tools).not.toContain("ask_tag");
});
