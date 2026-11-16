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
        order: 1,
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
        order: 1,
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
        order: 1,
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
      message: { order: 1, task: { ...task, state: "running", result: undefined } },
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
      message: { order: 1, task },
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
        order: 1,
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
        message: { order: 1, task: { ...task, state, result: undefined } },
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

it("gives each message its own bubble with a copy action, and no avatar or name header", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { order: 1, task: { ...task, prompt: "Check the update." } },
      events: [
        { sequence: 1, kind: "message", text: "Looking at the lockfile now." },
        { sequence: 2, kind: "message", text: "The lockfile is current." },
      ],
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html.match(/class="[^"]*\bbubble tag-message\b/g)).toHaveLength(2);
  expect(html.match(/class="[^"]*\bbubble result-text\b/g)).toHaveLength(1);
  expect(html.match(/class="[^"]*\bbubble prompt-text\b/g)).toHaveLength(1);
  expect(html.match(/aria-label="Copy message"/g)).toHaveLength(4);
  expect(html).not.toContain('class="avatar');
  expect(html).toContain("Completed · View Task activity");
});

it("gives only the last bubble of each group a tail, and shows the operator's delivery", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { order: 1, task: { ...task, prompt: "Check the update." } },
      events: [{ sequence: 1, kind: "message", text: "Looking at the lockfile now." }],
      delivery: "Seen",
      divider: Date.now(),
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html.match(/class="[^"]*\bbubble prompt-text tail\b/g)).toHaveLength(1);
  expect(html.match(/class="[^"]*\bbubble tag-message"/g)).toHaveLength(1);
  expect(html.match(/class="[^"]*\bbubble result-text tail\b/g)).toHaveLength(1);
  expect(html).toMatch(/class="delivery" data-delivery="Seen">Seen</);
  expect(html).toMatch(/class="time-divider"[^>]*>Today /);
});

it("shows the Tag typing until it writes, then its activity line instead", () => {
  const running = { ...task, state: "running", result: undefined };
  const typing = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { order: 1, task: running },
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(typing).toContain("typing-bubble");
  expect(typing).toContain('aria-label="engineer is working"');
  const active = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { order: 1, task: running },
      events: [{ sequence: 1, kind: "activity", text: "Running pnpm test" }],
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(active).not.toContain("typing-bubble");
  expect(active).toContain("Running pnpm test");
  const done = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: { order: 1, task },
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(done).not.toContain("typing-bubble");
});
