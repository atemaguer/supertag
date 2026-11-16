import { expect, it } from "vitest";
import type { Message } from "../control-plane";
import {
  conversationSummary,
  deliveryStatus,
  dividerLabel,
  lastOperatorMessage,
  timeDividers,
} from "./transcript";

const message = (
  taskId: string,
  extra: Partial<Message["task"]> = {},
  more: Partial<Message> = {},
) =>
  ({
    conversation: "default",
    task: {
      taskId,
      tagId: "lead",
      sessionId: "s",
      prompt: "Check it",
      state: "succeeded",
      ...extra,
    },
    ...more,
  }) as Message;

it("shows Sent until a Worker Host takes the message up, then Seen, or why it did not arrive", () => {
  expect(deliveryStatus(message("a", { state: "queued" }))).toBe("Sent");
  for (const state of ["claimed", "running", "succeeded", "failed"])
    expect(deliveryStatus(message("a", { state }))).toBe("Seen");
  const joined = (state: string) =>
    message("a", { state: "running" }, { liveInput: { taskId: "b", state } });
  expect(deliveryStatus(joined("pending"))).toBe("Sent");
  expect(deliveryStatus(joined("accepted"))).toBe("Seen");
  expect(deliveryStatus(joined("unknown"))).toBe("Delivery uncertain");
  expect(deliveryStatus(joined("withdrawn"))).toBe("Not delivered");
  expect(deliveryStatus(message("a", {}, { workSessionReportId: "work/x" }))).toBeUndefined();
});

it("puts a time divider first and after every pause longer than fifteen minutes", () => {
  const at = Date.UTC(2026, 10, 16, 9);
  const dividers = timeDividers([
    message("a", { createdAtMs: at }),
    message("b", { createdAtMs: at + 10 * 60_000 }),
    message("c", { createdAtMs: at + 30 * 60_000 }),
    message("d"),
    message("e", { createdAtMs: at + 31 * 60_000 }),
  ]);
  expect([...dividers.keys()]).toEqual(["a", "c"]);
  expect(timeDividers([message("a")]).size).toBe(0);
  const now = new Date(2026, 10, 16, 18, 0).getTime();
  expect(dividerLabel(new Date(2026, 10, 16, 9, 5).getTime(), now)).toMatch(/^Today /);
  expect(dividerLabel(new Date(2026, 10, 15, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
  expect(dividerLabel(new Date(2026, 9, 1, 9, 5).getTime(), now)).toMatch(/2026/);
});

it("finds the operator's last message and summarises the conversation for the sidebar", () => {
  const messages = [
    message("a", { result: "First line of the reply\nMore detail" }),
    message("b", { result: "A report" }, { workSessionReportId: "work/x" }),
  ];
  expect(lastOperatorMessage(messages)).toBe("a");
  expect(conversationSummary(messages)).toEqual({ preview: "A report" });
  expect(conversationSummary([messages[0] as Message])).toEqual({
    preview: "First line of the reply",
  });
  expect(
    conversationSummary([message("c", { state: "running", result: undefined, createdAtMs: 5 })]),
  ).toEqual({ preview: "You: Check it", lastActivityMs: 5, working: true });
  expect(conversationSummary([])).toEqual({});
});
