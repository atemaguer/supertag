import type { ControlPlane, Conversation, Message, Tag, TaskEvent } from "./control-plane";
import type { TagAdmin } from "./tag-admin";

const tags: Tag[] = [
  {
    tagId: "finch",
    lead: true,
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

function sample(
  taskId: string,
  conversation: string,
  prompt: string,
  result?: string,
  minutesAgo?: number,
  tagId = "finch",
): Message {
  const state = result === undefined ? "running" : "succeeded";
  const createdAtMs = minutesAgo === undefined ? undefined : Date.now() - minutesAgo * 60_000;
  return {
    conversation,
    task: { taskId, tagId, sessionId: conversation, prompt, state, result, createdAtMs },
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
            26 * 60,
          ),
          sample(
            "ci-health-2",
            "CI-health",
            "Check whether the same race can affect SQLite.",
            "SQLite uses the same cancellation path. I’d cover both databases with one test:\n\n1. Release the deadline and cancellation paths together.\n2. Check that **one** abort was recorded in `objective_events`.",
            26 * 60 - 8,
          ),
          sample("ci-health-3", "CI-health", "Write that test for both databases.", undefined, 3),
        ],
      ],
    ]),
  ],
  [
    "moss",
    new Map([
      [
        "default",
        [
          sample(
            "moss-1",
            "default",
            "Review the deadline fix for missing coverage.",
            undefined,
            1,
            "moss",
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

export const previewControlPlane: ControlPlane = {
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
    const messages = [...(conversationsFor(tagId).get(name) ?? [])].reverse();
    return {
      messages: messages.map((message) => {
        // As the Control Plane does: each message the Tag wrote, and its latest activity.
        const events = previewEvents(message.task.taskId);
        return { ...message, events: [events[0], events.at(-1)].filter((e) => e !== undefined) };
      }),
    };
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
        result: "This is a local preview. Connect a Control Plane to run Tasks with your Tags.",
      },
    };
    threads.set(name, [...entries, message]);
    return message;
  },
  async saveArtifact() {
    return false;
  },
  async events(taskId, afterSequence) {
    return previewEvents(taskId).filter(({ sequence }) => sequence > afterSequence);
  },
  scope: "preview",
  async readCache() {
    return undefined;
  },
  async writeCache() {},
};

function previewEvents(taskId: string): TaskEvent[] {
  // Moss has not written anything yet, so it shows as typing.
  if (taskId.startsWith("moss")) return [];
  return [
    {
      sequence: 1,
      kind: "message",
      text: taskId.startsWith("ci-health")
        ? "I'll look at the deadline and cancellation paths first."
        : "I'll prepare the preview result.",
    },
    { sequence: 2, kind: "activity", text: "Reading src/runtime/deadline.ts" },
    {
      sequence: 3,
      kind: "activity",
      text: taskId.startsWith("ci-health")
        ? "Running pnpm test -- deadline"
        : "Writing the preview result",
    },
  ];
}

export const previewTagAdmin: TagAdmin = {
  async options() {
    return { harnesses: ["claude_code", "codex"], workspaces: ["supertag"] };
  },
  async create({ tagId, name, harness }) {
    if (tags.some((tag) => tag.tagId === tagId))
      throw new Error("A Tag with that ID or name already exists.");
    const tag: Tag = {
      tagId,
      name: name && name !== tagId ? name : undefined,
      instructions: "",
      allowedActions: ["commands:execute", "files:write"],
      revision: 1,
      harnessKind: harness,
    };
    tags.push(tag);
    return tag;
  },
};

/** Clears the preview's lead Tag, to show the sidebar without one. */
export function withoutLead() {
  for (const tag of tags) tag.lead = false;
}
