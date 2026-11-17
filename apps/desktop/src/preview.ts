import type { Conversation, Gateway, Message, Note, Tag, TaskEvent } from "./gateway";
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

let order = 0;

function sample(
  taskId: string,
  prompt: string,
  result?: string,
  minutesAgo?: number,
  tagId = "finch",
): Message {
  const state = result === undefined ? "running" : "succeeded";
  const createdAtMs = minutesAgo === undefined ? undefined : Date.now() - minutesAgo * 60_000;
  order += 1;
  return {
    order,
    task: { taskId, tagId, sessionId: `preview/${tagId}`, prompt, state, result, createdAtMs },
  };
}

const messages = new Map<string, Message[]>([
  [
    "finch",
    [
      sample(
        "ci-health-1",
        "Can you look at the PostgreSQL deadline test? It counted two aborts in the last CI run.",
        "I traced both aborts to the same Objective. Its deadline and the worker’s cancellation path each recorded an abort. The fix is to make the terminal transition atomic so only the first writer can record it.",
        26 * 60,
      ),
      sample(
        "ci-health-2",
        "Check whether the same race can affect SQLite.",
        "SQLite uses the same cancellation path. I’d cover both databases with one test:\n\n1. Release the deadline and cancellation paths together.\n2. Check that **one** abort was recorded in `objective_events`.\n\n```sh\nSUPERTAG_RUST_TEST_POSTGRES_URL_FILE=/tmp/pg-url cargo test -p supertag-control-plane --test objective_overview_contract -- --include-ignored postgres_objective_completion_and_overview\n```\n\n| Database | Aborts recorded | Expected |\n| --- | --- | --- |\n| SQLite | 1 | 1 |\n| PostgreSQL | 2 | 1 |",
        26 * 60 - 8,
      ),
      sample("ci-health-3", "Write that test for both databases.", undefined, 3),
    ],
  ],
  [
    "moss",
    [sample("moss-1", "Review the deadline fix for missing coverage.", undefined, 1, "moss")],
  ],
]);

function conversationFor(tagId: string): Message[] {
  let entries = messages.get(tagId);
  if (!entries) {
    entries = [];
    messages.set(tagId, entries);
  }
  return entries;
}

const hour = 60 * 60 * 1000;
/** What the preview's Tags remember, newest first. */
let notes: Note[] = [
  {
    memoryId: "mem_preview_1",
    tagId: "finch",
    text: "Flaky deadline tests usually mean the clock is read twice; check objective_sweep first.",
    private: false,
    createdBy: "tag:finch",
    createdAtMs: Date.now() - 2 * hour,
    updatedAtMs: Date.now() - 2 * hour,
    lastSeenAtMs: Date.now() - 10 * 60 * 1000,
  },
  {
    memoryId: "mem_preview_2",
    tagId: "finch",
    text: "You prefer one test covering both databases over two separate tests.",
    private: true,
    createdBy: "tag:finch",
    createdAtMs: Date.now() - 30 * hour,
    updatedAtMs: Date.now() - 30 * hour,
  },
];

export const previewGateway: Gateway = {
  async tagActivity(tagId) {
    return tagId === "finch"
      ? {
          windowDays: 30,
          posted: 6,
          read: 4,
          answered: 2,
          quiet: 19,
          startRate: { starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 },
        }
      : { windowDays: 30, posted: 0, read: 0, answered: 0, quiet: 0 };
  },
  async notes(tagId) {
    return notes.filter((note) => note.tagId === tagId);
  },
  async deleteNote(memoryId) {
    const deleted = notes.find((note) => note.memoryId === memoryId);
    if (!deleted) throw new Error("Memory was not found");
    notes = notes.filter((note) => note !== deleted);
    return deleted;
  },
  async tags() {
    return tags;
  },
  async conversations() {
    return [...messages].flatMap(([tagId, entries]): Conversation[] => {
      const latest = entries.at(-1);
      if (!latest) return [];
      const reply = latest.task.result;
      return [
        {
          tagId,
          conversationId: `preview/${tagId}`,
          preview: reply ?? latest.task.prompt ?? "",
          previewFromTag: reply !== undefined,
          lastActivityAtMs: latest.task.createdAtMs ?? 0,
          latestOrder: latest.order,
          readOrder: latest.order,
          unreadCount: 0,
          working: latest.task.state === "running",
        },
      ];
    });
  },
  async messages({ tagId }) {
    return {
      conversationId: `preview/${tagId}`,
      messages: [...conversationFor(tagId)].reverse().map((message) => {
        // As the Gateway does: each message the Tag wrote, and its latest activity.
        const events = previewEvents(message.task.taskId);
        return { ...message, events: [events[0], events.at(-1)].filter((e) => e !== undefined) };
      }),
    };
  },
  async send(tagId, text, operationId) {
    const entries = conversationFor(tagId);
    const prior = entries.find(({ task }) => task.taskId === operationId);
    if (prior) return prior;
    order += 1;
    const message: Message = {
      order,
      task: {
        taskId: operationId,
        tagId,
        sessionId: `preview/${tagId}`,
        prompt: text,
        state: "succeeded",
        result: "This is a local preview. Connect a Gateway to run Tasks with your Tags.",
        createdAtMs: Date.now(),
      },
    };
    entries.push(message);
    return message;
  },
  async markRead(tagId) {
    const conversation = (await previewGateway.conversations()).find(
      (entry) => entry.tagId === tagId,
    );
    if (!conversation) throw new Error("No conversation with that Tag yet.");
    return conversation;
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
