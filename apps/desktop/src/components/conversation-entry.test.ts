import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Message } from "../control-plane";
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
      onSaveArtifact: async () => false,
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
      onSaveArtifact: async () => false,
    }),
  );
  expect(html).toContain("user-turn");
  expect(html).toContain("Check the update.");
  expect(html).toContain("Joined active Task");
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("Work Session report");
  expect(html).not.toContain(task.result);
});

it("offers the selected Task result files in the Tag reply", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        conversation: "planning",
        task: { ...task, artifacts: [{ artifactId: "capture", paths: ["outputs/report.md"] }] },
      },
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html).toContain('aria-label="Task result files"');
  expect(html).toContain('aria-label="Save outputs/report.md"');
});

it("shows each message the Tag wrote, its current activity, and then its reply once", () => {
  const running = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { conversation: "planning", task: { ...task, state: "running", result: undefined } },
      events: [
        { sequence: 1, kind: "message", text: "I'll check the lockfile first." },
        { sequence: 2, kind: "activity", text: "Running pnpm install" },
      ],
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(running).toContain("I&#x27;ll check the lockfile first.");
  expect(running).toContain("Running pnpm install");
  const done = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { conversation: "planning", task },
      events: [
        { sequence: 1, kind: "message", text: "I'll check the lockfile first." },
        { sequence: 2, kind: "activity", text: "Running pnpm install" },
        { sequence: 3, kind: "message", text: task.result ?? "" },
      ],
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(done).toContain("I&#x27;ll check the lockfile first.");
  expect(done).not.toContain("Running pnpm install");
  expect(done.split(task.result ?? "").length - 1).toBe(1);
});

it("renders the operator's prompt as written and the Tag's messages and result as markdown", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        conversation: "planning",
        task: {
          ...task,
          prompt: "Ship **v2**",
          result: "Updated `pnpm-lock.yaml`.\n\n- tests pass",
        },
      },
      events: [{ sequence: 1, kind: "message", text: "Checking the **lockfile**." }],
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html).toContain("is-user");
  expect(html).toContain("Ship **v2**");
  expect(html).toContain("is-assistant");
  expect(html).toMatch(/data-streamdown="strong">lockfile</);
  expect(html).toMatch(/data-streamdown="inline-code">pnpm-lock.yaml</);
  expect(html).toMatch(/data-streamdown="list-item">tests pass</);
});

it("animates the activity line only while the Task runs", () => {
  const render = (state: string) =>
    renderToStaticMarkup(
      createElement(ConversationEntry, {
        message: { conversation: "planning", task: { ...task, state, result: undefined } },
        events: [{ sequence: 1, kind: "activity", text: "Running pnpm test" }],
        onActivity: () => {},
        onSaveArtifact: async () => false,
      }),
    );
  const running = render("running");
  expect(running).toContain("Running pnpm test");
  expect(running).toContain("bg-clip-text");
  const failed = render("failed");
  expect(failed).toContain("Running pnpm test");
  expect(failed).not.toContain("bg-clip-text");
});
