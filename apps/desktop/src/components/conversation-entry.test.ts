import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Message } from "../gateway";
import { ConversationEntry } from "./conversation-entry";

const task: Message["task"] = {
  taskId: "report-task",
  tagId: "engineer",
  sessionId: "conversation/planning",
  prompt: "Private report prompt",
  state: "succeeded",
  result: "The dependency update passed verification.",
};

it("renders a Work Session report as Tag output with activity and no operator bubble", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        conversation: "planning",
        task,
        workSessionReportId: "work/dependency",
        liveInput: { taskId: "unexpected", state: "accepted" },
      },
      activeTask: "report-task",
      onActivity: () => {},
    }),
  );
  expect(html).toContain("Work Session report");
  expect(html).toContain(task.result);
  expect(html).toContain("View Task activity");
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("user-turn");
  expect(html).not.toContain(task.prompt);
  expect(html).not.toContain("Joined active Task");
});

it("keeps the operator prompt and joined Task activity on ordinary messages", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        conversation: "planning",
        task: { ...task, prompt: "Check the update." },
        liveInput: { taskId: "running-task", state: "accepted" },
      },
      activeTask: "running-task",
      onActivity: () => {},
    }),
  );
  expect(html).toContain("user-turn");
  expect(html).toContain("Check the update.");
  expect(html).toContain("Joined active Task");
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("Work Session report");
  expect(html).not.toContain(task.result);
});
