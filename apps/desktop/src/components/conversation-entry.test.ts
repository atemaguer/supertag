import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Message } from "../gateway";
import { ConversationEntry, turnNotice } from "./conversation-entry";

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
  expect(html).not.toContain("Joined the running Task");
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
  expect(html).toContain("Joined the running Task");
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

/** What a reader sees: the text, without markup or attributes such as accessible labels. */
const visible = (html: string) => html.replace(/<[^>]*>/g, "");

it("shows each message the Tag wrote, and then its reply once, but never its activity", () => {
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
  expect(visible(running)).not.toContain("Running pnpm install");
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

it("keeps activity and progress out of the transcript, running or ended without a result", () => {
  const render = (state: string) =>
    renderToStaticMarkup(
      createElement(ConversationEntry, {
        message: { order: 1, task: { ...task, state, result: undefined } },
        events: [
          { sequence: 1, kind: "activity", text: "Running pnpm test" },
          {
            sequence: 2,
            kind: "progress",
            text: JSON.stringify({ progress: { summary: "Fix the race" } }),
          },
        ],
        onActivity: () => {},
        onSaveArtifact: async () => false,
      }),
    );
  const running = render("running");
  expect(visible(running)).not.toMatch(/Running pnpm test|Fix the race/);
  // Only the dots' accessible label names the current step.
  expect(running).toContain('aria-label="engineer is working: Fix the race · View Task activity"');
  const failed = render("failed");
  expect(visible(failed)).not.toMatch(/Running pnpm test|Fix the race/);
  expect(visible(failed)).toContain("Failed");
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
  // A turn that succeeded says nothing under its reply; its last bubble's actions open the activity.
  expect(html).not.toContain("task-status");
  expect(html).not.toContain("Completed");
  expect(html.match(/aria-label="View Task activity"/g)).toHaveLength(1);
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

it("shows the Tag typing for the whole running turn, last, as dots alone", () => {
  const running = { ...task, state: "running", result: undefined };
  const render = (props: Partial<Parameters<typeof ConversationEntry>[0]>) =>
    renderToStaticMarkup(
      createElement(ConversationEntry, {
        message: { order: 1, task: running },
        onActivity: () => {},
        onSaveArtifact: async () => false,
        ...props,
      }),
    );
  // Before the first line: the dots alone, and no "Working" status.
  const waiting = render({});
  expect(waiting).toContain("typing-bubble");
  expect(waiting).toContain('aria-label="engineer is working · View Task activity"');
  expect(waiting).not.toContain("task-status");

  // After an intermediate message: the message, then the dots alone, last.
  const working = render({
    events: [
      { sequence: 1, kind: "message", text: "I'll check the lockfile first." },
      { sequence: 2, kind: "activity", text: "Running pnpm test" },
    ],
  });
  expect(working.indexOf("tag-message")).toBeLessThan(working.indexOf("typing-bubble"));
  expect(working).toMatch(/class="[^"]*\bbubble tag-message"/);
  expect(working).toContain("typing-bubble tail");
  expect(visible(working)).not.toContain("Running pnpm test");
  expect(working).toContain(
    'aria-label="engineer is working: Running pnpm test · View Task activity"',
  );
  expect(working).not.toContain("task-status");

  // Finished: no dots, and the status returns as the way into the activity.
  const done = render({ message: { order: 1, task } });
  expect(done).not.toContain("typing-bubble");
  expect(done).not.toContain("task-status");
  expect(done).toContain('aria-label="View Task activity"');
});

it("says how a turn ended only when it did not simply succeed", () => {
  const render = (state: string, liveInput?: { taskId: string; state: string }) =>
    renderToStaticMarkup(
      createElement(ConversationEntry, {
        message: { order: 1, task: { ...task, state, result: undefined }, liveInput },
        onActivity: () => {},
        onSaveArtifact: async () => false,
      }),
    );
  expect(render("failed")).toMatch(/data-tone="error"[^>]*>.*Failed/);
  expect(render("cancelled")).toMatch(/data-tone="warning"[^>]*>.*Cancelled/);
  expect(render("uncertain")).toContain("Interrupted: needs attention");
  expect(render("cancelled", { taskId: "x", state: "withdrawn" })).toContain(
    "Not delivered to the running Task",
  );
  expect(render("succeeded", { taskId: "x", state: "unknown" })).toMatch(
    /data-tone="warning"[^>]*>.*Delivery uncertain/,
  );
  expect(turnNotice("succeeded")).toBeUndefined();
  // A succeeded turn with nothing to show still offers its activity.
  expect(render("succeeded")).toContain("View activity");
});

it("renders a Schedule's turn as the Tag's reply under a muted caption, with no operator bubble", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        order: 2,
        task: { ...task, taskId: "woken", prompt: "", result: "CI is green." },
        scheduleId: "sch_1",
      },
      delivery: "Seen",
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html).toContain("CI is green.");
  expect(html).toContain('<span class="report-label">Scheduled</span>');
  expect(html.indexOf("CI is green.")).toBeLessThan(html.indexOf(">Scheduled<"));
  expect(html).not.toContain("user-turn");
  expect(html).not.toContain("Work Session report");
});

it("says why a report's work Session closed", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationEntry, {
      message: {
        order: 3,
        task,
        workSessionReportId: "work/dependency",
        workSessionClosed: "idle",
      },
      onActivity: () => {},
      onSaveArtifact: async () => false,
    }),
  );
  expect(html).toContain("Work Session report · closed: idle");
});
