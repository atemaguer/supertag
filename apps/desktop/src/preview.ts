import type { Conversation, Gateway, Message, Tag, TaskEvent } from "./gateway";

const tags: Tag[] = [
  {
    tagId: "finch",
    instructions: "Own CI health and investigate flaky builds.",
    allowedActions: ["Read build logs", "Inspect repositories"],
    revision: 1,
    harnessKind: "codex",
  },
  {
    tagId: "moss",
    instructions: "Review changes for regressions and missing test coverage.",
    allowedActions: ["Read pull requests"],
    revision: 1,
    harnessKind: "claude_code",
  },
  {
    tagId: "kite",
    instructions: "Keep release notes and developer docs up to date.",
    allowedActions: ["Read repositories"],
    revision: 1,
    harnessKind: "codex",
  },
];

function sample(taskId: string, conversation: string, prompt: string, result: string): Message {
  return {
    conversation,
    task: { taskId, tagId: "finch", sessionId: conversation, prompt, state: "succeeded", result },
  };
}

const messages = new Map<string, Map<string, Message[]>>([
  [
    "finch",
    new Map([
      [
        "CI-health",
        [
          sample(
            "ci-health-1",
            "CI-health",
            "Can you look at the PostgreSQL deadline test? It counted two aborts in the last CI run.",
            "I traced both aborts to the same Objective. Its deadline and the worker’s cancellation path each recorded an abort. The fix is to make the terminal transition atomic so only the first writer can record it.",
          ),
          sample(
            "ci-health-2",
            "CI-health",
            "Check whether the same race can affect SQLite.",
            "SQLite uses the same cancellation path. I’d cover both databases with a test that releases the deadline and cancellation paths together, then checks that one abort was recorded.",
          ),
        ],
      ],
      [
        "release-checks",
        [
          sample(
            "release-checks-1",
            "release-checks",
            "What should we verify before cutting the release?",
            "Build the installers, test a fresh setup, and run a conversation through both the desktop app and Go TUI.",
          ),
        ],
      ],
    ]),
  ],
]);

function conversationsFor(tagId: string): Map<string, Message[]> {
  let threads = messages.get(tagId);
  if (!threads) {
    threads = new Map();
    messages.set(tagId, threads);
  }
  return threads;
}

export const previewGateway: Gateway = {
  async tags() {
    return tags;
  },
  async conversations(tagId) {
    return [...conversationsFor(tagId)].map(
      ([name, entries]): Conversation => ({
        tagId,
        name,
        sessionId: name,
        latestTask: entries.at(-1)?.task,
      }),
    );
  },
  async messages(tagId, name) {
    return { messages: [...(conversationsFor(tagId).get(name) ?? [])].reverse() };
  },
  async send(tagId, name, text, operationId) {
    const threads = conversationsFor(tagId);
    const entries = threads.get(name) ?? [];
    const prior = entries.find(({ task }) => task.taskId === operationId);
    if (prior) return prior;
    const message = {
      conversation: name,
      task: {
        taskId: operationId,
        tagId,
        sessionId: name,
        prompt: text,
        state: "succeeded",
        result: "This is a local preview. Connect a Gateway to run Tasks with your Tags.",
      },
    };
    threads.set(name, [...entries, message]);
    return message;
  },
  async events(_tagId, taskId, afterSequence) {
    const events: TaskEvent[] = [
      { sequence: 1, text: "Task accepted" },
      { sequence: 2, text: "Worker started" },
      {
        sequence: 3,
        text: taskId.startsWith("ci-health")
          ? "Inspected the deadline and cancellation paths"
          : "Prepared the preview result",
      },
      { sequence: 4, text: "Task completed" },
    ];
    return events.filter(({ sequence }) => sequence > afterSequence);
  },
};
