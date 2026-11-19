/**
 * An in-memory Gateway for screen tests and benches: the services the terminal UI calls,
 * served through `createRouterTransport`, so `GatewayState`, the follow and the Watch run their
 * real code against it. A test drives it: a Tag replies, streams text, or a message arrives.
 */
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { Enrollments } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/placement_pb";
import {
  type ConversationMessage,
  Conversations,
  type FollowConversationResponse,
  HarnessKind,
  HostPhase,
  Operator,
  OperatorEvents,
  type TaskEvent,
  type TaskEventKind,
  TaskState,
  type WatchEvent,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { CacheScope } from "../../client/src/node/cache";
import { type GatewayClient, Session } from "../../client/src/node/index";

type Init<T> = Partial<T> & Record<string, unknown>;

export interface FakeTag {
  tagId: string;
  name?: string;
  lead?: boolean;
  instructions?: string;
}

interface Turn {
  taskId: string;
  order: number;
  prompt: string;
  state: TaskState;
  result?: string;
  sentAtMs: number;
  events: { sequence: number; kind: TaskEventKind; text: string }[];
}

/** Waits until a value is pushed or `signal` aborts. */
class Queue<T> {
  private items: T[] = [];
  private wake: (() => void) | undefined;
  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }
  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift() as T;
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.wake = undefined;
      if (signal.aborted) return;
    }
  }
}

export class FakeGateway {
  readonly tags: FakeTag[];
  private turns = new Map<string, Turn[]>();
  private follows = new Map<string, Set<Queue<Init<FollowConversationResponse>>>>();
  private watches = new Set<Queue<Init<WatchEvent>>>();
  private nextTask = 0;
  /** Messages the Gateway accepted, in order. */
  readonly sent: { tagId: string; text: string; operationId: string }[] = [];
  /** When set, `SendMessage` fails with this message. */
  refuseSends: string | undefined;
  /** When true, a sent message gets an automatic reply. */
  autoReply = true;

  constructor(
    tags: FakeTag[],
    readonly principal = "operator:local",
  ) {
    this.tags = tags;
  }

  turnsOf(tagId: string): Turn[] {
    let turns = this.turns.get(tagId);
    if (!turns) {
      turns = [];
      this.turns.set(tagId, turns);
    }
    return turns;
  }

  /** Adds a finished turn: the person's prompt and the Tag's reply. */
  addTurn(tagId: string, prompt: string, result: string, sentAtMs = Date.now()) {
    const turns = this.turnsOf(tagId);
    const turn: Turn = {
      taskId: `task-${++this.nextTask}`,
      order: turns.length + 1,
      prompt,
      state: TaskState.SUCCEEDED,
      result,
      sentAtMs,
      events: [],
    };
    turns.push(turn);
    return turn;
  }

  private message(tagId: string, turn: Turn): Init<ConversationMessage> {
    return {
      task: {
        taskId: turn.taskId,
        tagId,
        sessionId: `conversation/${tagId}`,
        prompt: turn.prompt,
        state: turn.state,
        ...(turn.result !== undefined ? { result: turn.result } : {}),
      } as never,
      order: BigInt(turn.order),
      sentAtMs: BigInt(turn.sentAtMs),
      events: turn.events.map((event) => ({
        sequence: BigInt(event.sequence),
        kind: event.kind,
        text: event.text,
        taskId: turn.taskId,
      })) as never as TaskEvent[],
    };
  }

  private page(tagId: string, turns: Turn[], incremental: boolean) {
    return {
      messages: [...turns].reverse().map((turn) => this.message(tagId, turn)) as never,
      nextCursor: "",
      conversationId: `conversation-${tagId}`,
      incremental,
    };
  }

  private conversation(tagId: string) {
    const turns = this.turnsOf(tagId);
    const last = turns.at(-1);
    return {
      tagId,
      conversationId: `conversation-${tagId}`,
      sessionId: `conversation/${tagId}`,
      preview: last?.result ?? last?.prompt ?? "",
      previewFromTag: last?.result !== undefined,
      lastActivityAtMs: BigInt(last?.sentAtMs ?? 0),
      latestOrder: BigInt(last?.order ?? 0),
      readOrder: BigInt(this.read.get(tagId) ?? 0),
      unreadCount: turns.filter(
        (turn) => turn.result !== undefined && turn.order > (this.read.get(tagId) ?? 0),
      ).length,
      working: turns.some(
        (turn) => turn.state === TaskState.RUNNING || turn.state === TaskState.QUEUED,
      ),
    };
  }

  private read = new Map<string, number>();

  /** Pushes the turn's current state to every follow of its conversation, and a Watch change. */
  changed(tagId: string, turn: Turn, texts: { taskId: string; text: string }[] = []) {
    for (const follow of this.follows.get(tagId) ?? []) {
      follow.push({ messages: this.page(tagId, [turn], true) as never, waits: [], texts } as never);
    }
    for (const watch of this.watches) {
      watch.push({
        resumeToken: `t${Date.now()}`,
        update: {
          case: "change",
          value: { kind: 3, tagId, sessionId: `conversation/${tagId}`, reason: 2 },
        },
      } as never);
    }
  }

  /** Streams `text` as the text the running turn is writing. */
  writing(tagId: string, taskId: string, text: string) {
    for (const follow of this.follows.get(tagId) ?? []) {
      follow.push({ waits: [], texts: [{ taskId, text }] } as never);
    }
  }

  /** The running turn finishes with `result`. */
  finish(tagId: string, taskId: string, result: string) {
    const turn = this.turnsOf(tagId).find((candidate) => candidate.taskId === taskId);
    if (!turn) throw new Error(`no turn ${taskId}`);
    turn.state = TaskState.SUCCEEDED;
    turn.result = result;
    this.changed(tagId, turn, [{ taskId, text: "" }]);
  }

  /** A `GatewayClient` over this fake. */
  client(): GatewayClient {
    const fake = this;
    const transport = createRouterTransport((router) => {
      router.service(Enrollments, {
        whoAmI: () => ({ principal: fake.principal, role: 1 }),
      } as never);
      router.service(Operator, {
        listTags: () => ({
          tags: fake.tags.map((tag) => ({
            tagId: tag.tagId,
            name: tag.name ?? tag.tagId,
            instructions: tag.instructions ?? "Process requests",
            allowedActions: [],
            revision: 1n,
            harnessKind: HarnessKind.CODEX,
            lead: tag.lead ?? false,
          })),
          nextCursor: "",
        }),
        listHosts: () => ({
          hosts: [{ hostId: "laptop", phase: HostPhase.READY }],
          nextCursor: "",
        }),
        listEvents: () => ({ events: [] }),
      } as never);
      router.service(Conversations, {
        listConversations: () => ({
          conversations: fake.tags
            .filter((tag) => fake.turnsOf(tag.tagId).length > 0)
            .map((tag) => fake.conversation(tag.tagId)),
        }),
        listMessages: (request: { tagId: string; after: bigint; conversationId: string }) => {
          const turns = fake.turnsOf(request.tagId);
          if (request.conversationId) {
            return fake.page(
              request.tagId,
              turns.filter((turn) => turn.order > Number(request.after)),
              true,
            );
          }
          return fake.page(request.tagId, turns.slice(-50), false);
        },
        sendMessage: (request: { tagId: string; text: string; operationId: string }) => {
          if (fake.refuseSends) throw new Error(fake.refuseSends);
          fake.sent.push({
            tagId: request.tagId,
            text: request.text,
            operationId: request.operationId,
          });
          const turns = fake.turnsOf(request.tagId);
          const turn: Turn = {
            taskId: `task-${++fake.nextTask}`,
            order: turns.length + 1,
            prompt: request.text,
            state: TaskState.RUNNING,
            sentAtMs: Date.now(),
            events: [],
          };
          turns.push(turn);
          queueMicrotask(() => {
            fake.changed(request.tagId, turn);
            if (fake.autoReply)
              setTimeout(
                () => fake.finish(request.tagId, turn.taskId, `Process requests: ${request.text}`),
                5,
              );
          });
          return fake.message(request.tagId, turn);
        },
        markConversationRead: (request: { tagId: string; order: bigint }) => {
          fake.read.set(request.tagId, Number(request.order));
          return fake.conversation(request.tagId);
        },
        async *followConversation(
          request: { tagId: string; after: bigint; conversationId: string },
          context: { signal: AbortSignal },
        ) {
          const queue = new Queue<Init<FollowConversationResponse>>();
          let set = fake.follows.get(request.tagId);
          if (!set) {
            set = new Set();
            fake.follows.set(request.tagId, set);
          }
          set.add(queue);
          try {
            const turns = fake.turnsOf(request.tagId);
            yield {
              messages: request.conversationId
                ? fake.page(
                    request.tagId,
                    turns.filter((turn) => turn.order > Number(request.after)),
                    true,
                  )
                : fake.page(request.tagId, turns.slice(-50), false),
              waits: [],
              texts: [],
            };
            yield* queue.drain(context.signal);
          } finally {
            set.delete(queue);
          }
        },
      } as never);
      router.service(OperatorEvents, {
        async *watch(_request: unknown, context: { signal: AbortSignal }) {
          const queue = new Queue<Init<WatchEvent>>();
          fake.watches.add(queue);
          try {
            yield { resumeToken: "t0", update: { case: "heartbeat", value: {} } };
            yield* queue.drain(context.signal);
          } finally {
            fake.watches.delete(queue);
          }
        },
      } as never);
    });
    const services = {
      operator: createClient(Operator, transport),
      conversations: createClient(Conversations, transport),
      events: createClient(OperatorEvents, transport),
      enrollments: createClient(Enrollments, transport),
      negotiate: async () => 7,
      close: () => {},
    };
    return services as unknown as GatewayClient;
  }

  /** A session over this fake, as `GatewayState.adopt` takes it. */
  session(): Session {
    return new Session(this.client());
  }

  scope(gateway = "local test"): CacheScope {
    return { gateway, principal: this.principal };
  }
}
