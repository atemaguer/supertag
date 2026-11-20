import type {
  Conversation,
  Gateway,
  GatewayRelease,
  HarnessMemory,
  Message,
  Tag,
  TagAdmin,
  TaskEvent,
} from "@supertag/client/model";
import { APP_VERSION } from "./components/version";

const tags: Tag[] = [
  {
    tagId: "finch",
    lead: true,
    instructions: "Own CI health and investigate flaky builds.",
    allowedActions: ["Read build logs", "Inspect repositories"],
    revision: 1,
    harnessKind: "codex",
    appearance: {
      version: 1,
      catalog: "felt-v1",
      head: "pear",
      color: "moss",
      expression: "curious",
      hat: "plum-beanie",
      glasses: "round-charcoal",
      headphones: null,
    },
    appearanceRevision: 1,
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
/** What the preview's Tags remember, as their harnesses keep it. */
let harnessMemories: HarnessMemory[] = [
  {
    memoryId: "hmem_preview00000000000001",
    tagId: "finch",
    harness: "claude-code",
    private: false,
    kind: "feedback",
    title: "Prefer squash merges",
    hook: "merge pull requests by squashing",
    text: "Prefer squash merges.\n**Why:** linear history for bisect.",
    truncated: false,
    trust: "trusted",
    status: "owned",
    path: "feedback_squash.md",
    hostId: "local",
    updatedAtMs: Date.now() - 3 * hour,
  },
  {
    memoryId: "hmem_preview00000000000002",
    tagId: "finch",
    harness: "claude-code",
    private: false,
    kind: "fact",
    title: "Flaky deadline tests",
    text: "Flaky deadline tests usually mean the clock is read twice; check objective_sweep first.",
    truncated: false,
    trust: "proposed-only",
    status: "proposed",
    path: "fact_flaky_deadlines.md",
    hostId: "local",
    updatedAtMs: Date.now() - 4 * hour,
  },
];

const previewFiles: Record<string, import("@supertag/client/model").TaskFileEntry[]> = {
  "": [
    { name: "src", path: "src", kind: "directory", size: 96, modifiedMs: Date.now(), text: false },
    {
      name: "README.md",
      path: "README.md",
      kind: "file",
      size: 120,
      modifiedMs: Date.now(),
      text: true,
    },
    {
      name: "logo.png",
      path: "logo.png",
      kind: "file",
      size: 4096,
      modifiedMs: Date.now(),
      text: false,
    },
  ],
  src: [
    {
      name: "deadline.ts",
      path: "src/deadline.ts",
      kind: "file",
      size: 210,
      modifiedMs: Date.now(),
      text: true,
    },
  ],
};

export const previewGateway: Gateway = {
  async locateTaskFiles(taskId) {
    return taskId.startsWith("moss")
      ? {
          local: false,
          live: true,
          hostId: "build-1",
          reason: "Files on Worker Host build-1 are unreachable from here.",
        }
      : { local: true, live: true, hostId: "laptop" };
  },
  async listTaskFiles(_taskId, path) {
    return previewFiles[path] ?? [];
  },
  async readTaskFile(_taskId, path) {
    const text =
      path === "README.md"
        ? "# Deadline fix\nCovers SQLite and PostgreSQL.\n"
        : "export const grace = 5_000;\n";
    return { path, text, size: text.length };
  },
  async revealTaskFile() {},
  async tagActivity(tagId) {
    return tagId === "finch"
      ? {
          windowDays: 30,
          posted: 6,
          read: 4,
          answered: 2,
          quiet: 19,
          startRate: { starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 },
          idleObjectives: [
            {
              objectiveId: "ship-sso",
              outcome: "Ship SSO for the admin console",
              idleSinceMs: Date.now() - 40 * 60 * 1000,
            },
          ],
        }
      : { windowDays: 30, posted: 0, read: 0, answered: 0, quiet: 0 };
  },
  async harnessMemory(tagId) {
    return { memories: harnessMemories.filter((memory) => memory.tagId === tagId), keptOn: [] };
  },
  async deleteHarnessMemory(memoryId) {
    const deleted = harnessMemories.find((memory) => memory.memoryId === memoryId);
    if (!deleted) throw new Error("Memory was not found");
    harnessMemories = harnessMemories.filter((memory) => memory !== deleted);
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
  async addFolder() {
    return { workspace: "site", workspaceRef: "main" };
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
  async setAppearance(tagId, appearance, expectedRevision) {
    const index = tags.findIndex((tag) => tag.tagId === tagId);
    const current = tags[index];
    if (!current) throw new Error(`Tag ${tagId} was not found.`);
    if ((current.appearanceRevision ?? 0) !== expectedRevision) return { conflict: current };
    const saved: Tag = {
      ...current,
      ...(appearance ? { appearance } : { appearance: undefined }),
      appearanceRevision: expectedRevision + 1,
    };
    if (!appearance) delete saved.appearance;
    tags[index] = saved;
    return { saved };
  },
  async tag(tagId) {
    const found = tags.find((tag) => tag.tagId === tagId);
    if (!found) throw new Error(`Tag ${tagId} was not found.`);
    return found;
  },
};

/** Clears the preview's lead Tag, to show the sidebar without one. */
export function withoutLead() {
  for (const tag of tags) tag.lead = false;
}

/** The sample Gateway's release: the app's own, or `build` when the preview names another. */
export function previewRelease(build?: string | null): GatewayRelease {
  return { build: build || APP_VERSION, protocol: 7 };
}
