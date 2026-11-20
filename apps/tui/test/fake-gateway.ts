/**
 * An in-memory Gateway for screen tests and benches: the services the terminal UI calls,
 * served through `createRouterTransport`, so `GatewayState`, the follow and the Watch run their
 * real code against it. A test drives it: a Tag replies, streams text, or a message arrives.
 */
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { Memories } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/memories_pb";
import { Enrollments } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/placement_pb";
import {
  ApprovalState,
  type ConversationMessage,
  Conversations,
  type FollowConversationResponse,
  HarnessKind,
  HostPhase,
  Inbox,
  type InboxItemKind,
  NetworkLogs,
  ObjectiveStatus,
  Objectives,
  Operator,
  OperatorEvents,
  type TaskEvent,
  TaskEventKind,
  TaskState,
  Teams,
  type WatchEvent,
  WatchKind,
  WorkSessions,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import {
  ScheduleState,
  Schedules,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/schedules_pb";
import { WorkspaceLandings } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/workspace_landings_pb";
import type { CacheScope } from "../../client/src/node/cache";
import { type GatewayClient, Session } from "../../client/src/node/index";

type Init<T> = Partial<T> & Record<string, unknown>;

export interface FakeTag {
  tagId: string;
  name?: string;
  lead?: boolean;
  instructions?: string;
  harnessKind?: HarnessKind;
  allowedActions?: string[];
  workspaceId?: string;
}

export interface FakeObjective {
  objectiveId: string;
  ownerTagId: string;
  outcome: string;
  status?: ObjectiveStatus;
  teamId?: string;
  budgetLimitMinor?: bigint;
  budgetCurrency?: string;
  reportedSpendMinor?: bigint;
  startingTaskId?: string;
  completionSummary?: string;
}

export interface FakeInboxItem {
  key: string;
  kind: InboxItemKind;
  taskId: string;
  objectiveId?: string;
  reason?: string;
  question?: string;
  approval?: {
    approvalId: string;
    tagId: string;
    action: string;
    resource: string;
    summary: string;
  };
}

export interface FakeWorkSession {
  workSessionId: string;
  title: string;
  tagId: string;
  parentSessionId: string;
  latestTaskId: string;
  latestTaskState: TaskState;
  reportTaskId?: string;
  headCommit?: string;
  baseCommit?: string;
  pullRequest?: string;
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
  objectives: FakeObjective[] = [];
  /** Objectives created through the Gateway, in order, with each request. */
  readonly createdObjectives: Record<string, unknown>[] = [];
  /** When set, `CreateObjective` answers with no started turn this many times. */
  unstartedObjectives = 0;
  inbox: FakeInboxItem[] = [];
  readonly answers: { taskId: string; text: string }[] = [];
  readonly decisions: { approvalId: string; approve: boolean; reason: string }[] = [];
  readonly reviews: { objectiveId: string; approved: boolean; feedback: string }[] = [];
  teams: { teamId: string; name: string; memberTagIds: string[]; maxConcurrency?: number }[] = [];
  posts: { postId: string; teamId: string; authorTagId: string; body: string; sequence: number }[] =
    [];
  workSessions: FakeWorkSession[] = [];
  /** Activity lines of a Task, for `ListEvents`. */
  activity = new Map<string, string[]>();
  notes: { memoryId: string; tagId: string; text: string; private?: boolean }[] = [];
  schedules: { scheduleId: string; tagId: string; note: string; state: ScheduleState }[] = [];
  networkLogs: {
    tagId: string;
    taskId: string;
    allowed: number;
    denied: number;
    requests: { method: string; origin: string; path: string; allowed: boolean; reason?: string }[];
  }[] = [];
  /** Worker Hosts and the harnesses and Workspaces they offer. */
  hosts: { hostId: string; harnesses: HarnessKind[]; workspaces: string[] }[] = [
    { hostId: "laptop", harnesses: [HarnessKind.CODEX], workspaces: [] },
  ];
  /** Tags created through the Gateway, with each `PutTag` request. */
  readonly putTags: Record<string, unknown>[] = [];
  /** Follow-ups submitted to Objectives' owners, answered at once. */
  readonly submitted: { tagId: string; sessionId: string; prompt: string; taskId: string }[] = [];

  constructor(
    tags: FakeTag[],
    readonly principal = "operator:local",
  ) {
    this.tags = [...tags];
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

  /** Tells every Watch that `kind` changed, as an Objective, Team or Work Session change does. */
  notify(change: {
    kind: WatchKind;
    tagId?: string;
    sessionId?: string;
    objectiveId?: string;
    teamId?: string;
  }) {
    for (const watch of this.watches) {
      watch.push({
        resumeToken: `t${Date.now()}`,
        update: { case: "change", value: { reason: 2, id: "x", ...change } },
      } as never);
    }
  }

  private objectiveMessage(objective: FakeObjective) {
    return {
      objectiveId: objective.objectiveId,
      ownerTagId: objective.ownerTagId,
      sessionId: `objective/${objective.objectiveId}`,
      outcome: objective.outcome,
      status: objective.status ?? ObjectiveStatus.WORKING,
      revision: 1n,
      ongoing: false,
      startingTaskId: objective.startingTaskId ?? "",
      ...(objective.teamId ? { teamId: objective.teamId } : {}),
      ...(objective.budgetLimitMinor !== undefined
        ? { budgetLimitMinor: objective.budgetLimitMinor, budgetCurrency: objective.budgetCurrency }
        : {}),
      ...(objective.reportedSpendMinor !== undefined
        ? { reportedSpendMinor: objective.reportedSpendMinor }
        : {}),
      ...(objective.completionSummary ? { completionSummary: objective.completionSummary } : {}),
      createdBy: "operator:local",
    };
  }

  private workSessionMessage(work: FakeWorkSession) {
    return {
      workSessionId: work.workSessionId,
      title: work.title,
      parentTagId: work.tagId,
      parentSessionId: work.parentSessionId,
      starterTaskId: "starter",
      tagId: work.tagId,
      latestTaskId: work.latestTaskId,
      latestTaskState: work.latestTaskState,
      ...(work.reportTaskId
        ? { reportTaskId: work.reportTaskId, reportTaskState: TaskState.SUCCEEDED }
        : {}),
      ...(work.headCommit
        ? {
            workspaceDelivery: {
              workspaceId: "app",
              baseCommit: work.baseCommit ?? "",
              headCommit: work.headCommit,
              committed: true,
              changedFiles: 2n,
            },
          }
        : {}),
      createdOrder: 1n,
    };
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
            allowedActions: tag.allowedActions ?? [],
            revision: 1n,
            harnessKind: tag.harnessKind ?? HarnessKind.CODEX,
            lead: tag.lead ?? false,
            ...(tag.workspaceId
              ? { workspace: { workspaceId: tag.workspaceId, baseRef: "main", baseCommit: "" } }
              : {}),
          })),
          nextCursor: "",
        }),
        listHosts: () => ({
          hosts: fake.hosts.map((host) => ({
            hostId: host.hostId,
            phase: HostPhase.READY,
            harnessKind: host.harnesses[0] ?? HarnessKind.UNSPECIFIED,
            harnesses: host.harnesses.slice(1).map((harnessKind) => ({ harnessKind })),
            workspaceIds: host.workspaces,
          })),
          nextCursor: "",
        }),
        listEvents: (request: { taskId: string; afterSequence: bigint }) => ({
          events: (fake.activity.get(request.taskId) ?? [])
            .map((text, index) => ({
              taskId: request.taskId,
              sequence: BigInt(index + 1),
              kind: TaskEventKind.ACTIVITY,
              text,
            }))
            .filter((event) => event.sequence > request.afterSequence),
        }),
        putTag: (request: Record<string, unknown> & { tagId: string; name?: string }) => {
          fake.putTags.push(request);
          fake.tags.push({ tagId: request.tagId, name: request.name || request.tagId });
          return {
            tagId: request.tagId,
            name: request.name || request.tagId,
            instructions: "",
            allowedActions: request["allowedActions"] ?? [],
            revision: 1n,
            harnessKind: request["harnessKind"] ?? HarnessKind.CODEX,
            lead: false,
          };
        },
        getTag: (request: { tagId: string }) => ({
          tagId: request.tagId,
          attention: { windowDays: 7, posted: 4, read: 3, answered: 1, quiet: 2 },
          idleObjectives: [],
        }),
        submitTask: (request: { tagId: string; sessionId: string; prompt: string }) => {
          const taskId = `task-${++fake.nextTask}`;
          fake.submitted.push({ ...request, taskId });
          return {
            taskId,
            tagId: request.tagId,
            sessionId: request.sessionId,
            state: TaskState.QUEUED,
          };
        },
        getTask: (request: { taskId: string }) => {
          const submitted = fake.submitted.find((task) => task.taskId === request.taskId);
          if (submitted)
            return {
              taskId: request.taskId,
              tagId: submitted.tagId,
              state: TaskState.SUCCEEDED,
              result: `Noted: ${submitted.prompt}`,
            };
          return {
            taskId: request.taskId,
            state: TaskState.SUCCEEDED,
            result: `The report of ${request.taskId}`,
          };
        },
      } as never);
      router.service(Objectives, {
        listObjectives: (request: { afterId: string }) => ({
          objectives: fake.objectives
            .filter((objective) => !request.afterId || objective.objectiveId > request.afterId)
            .map((objective) => fake.objectiveMessage(objective)),
        }),
        getObjective: (request: { objectiveId: string }) => {
          const found = fake.objectives.find(
            (objective) => objective.objectiveId === request.objectiveId,
          );
          if (!found) throw new ConnectError("no Objective", Code.NotFound);
          return fake.objectiveMessage(found);
        },
        createObjective: (
          request: Record<string, unknown> & {
            objectiveId: string;
            ownerTagId: string;
            outcome: string;
          },
        ) => {
          fake.createdObjectives.push(request);
          let found = fake.objectives.find(
            (objective) => objective.objectiveId === request.objectiveId,
          );
          if (!found) {
            found = {
              objectiveId: request.objectiveId,
              ownerTagId: request.ownerTagId,
              outcome: request.outcome,
              ...(request["teamId"] ? { teamId: request["teamId"] as string } : {}),
              ...(request["budgetLimitMinor"] !== undefined
                ? {
                    budgetLimitMinor: request["budgetLimitMinor"] as bigint,
                    budgetCurrency: request["budgetCurrency"] as string,
                  }
                : {}),
            };
            fake.objectives.push(found);
          }
          if (fake.unstartedObjectives > 0) fake.unstartedObjectives--;
          else found.startingTaskId ||= `task-${++fake.nextTask}`;
          return fake.objectiveMessage(found);
        },
        reviewObjective: (request: {
          objectiveId: string;
          approved: boolean;
          feedback: string;
        }) => {
          fake.reviews.push({
            objectiveId: request.objectiveId,
            approved: request.approved,
            feedback: request.feedback,
          });
          const found = fake.objectives.find(
            (objective) => objective.objectiveId === request.objectiveId,
          );
          if (!found) throw new ConnectError("no Objective", Code.NotFound);
          found.status = request.approved ? ObjectiveStatus.COMPLETED : ObjectiveStatus.WORKING;
          return fake.objectiveMessage(found);
        },
      } as never);
      router.service(Inbox, {
        listItems: () => ({
          asOfMs: BigInt(Date.now()),
          items: fake.inbox.map((item) => ({
            key: item.key,
            occurrence: "1",
            kind: item.kind,
            objectiveId: item.objectiveId ?? "",
            taskId: item.taskId,
            operatorEligible: true,
            actionableSinceMs: BigInt(Date.now()),
            reason: item.reason ?? "",
            ...(item.question
              ? {
                  question: {
                    text: item.question,
                    askedAtMs: BigInt(Date.now()),
                    truncated: false,
                  },
                }
              : {}),
            ...(item.approval ? { approval: item.approval } : {}),
          })),
          nextCursor: "",
        }),
        getApproval: (request: { approvalId: string }) => {
          const item = fake.inbox.find(
            (entry) => entry.approval?.approvalId === request.approvalId,
          );
          const decided = fake.decisions.find((entry) => entry.approvalId === request.approvalId);
          return {
            approvalId: request.approvalId,
            action: item?.approval?.action ?? "workstream:post",
            resource: item?.approval?.resource ?? "",
            summary: item?.approval?.summary ?? "",
            canonicalArgumentsJson: '{"body":"The rollout is ready."}',
            state: decided
              ? decided.approve
                ? ApprovalState.APPROVED
                : ApprovalState.DENIED
              : ApprovalState.PENDING,
          };
        },
        answerQuestion: (request: { taskId: string; text: string }) => {
          fake.answers.push({ taskId: request.taskId, text: request.text });
          fake.inbox = fake.inbox.filter((item) => item.taskId !== request.taskId);
          return { taskId: `task-${++fake.nextTask}` };
        },
        decideApproval: (request: { approvalId: string; approve: boolean; reason: string }) => {
          fake.decisions.push({
            approvalId: request.approvalId,
            approve: request.approve,
            reason: request.reason,
          });
          const item = fake.inbox.find(
            (entry) => entry.approval?.approvalId === request.approvalId,
          );
          fake.inbox = fake.inbox.filter((entry) => entry !== item);
          return {
            approvalId: request.approvalId,
            action: item?.approval?.action ?? "workstream:post",
            resource: item?.approval?.resource ?? "",
            summary: item?.approval?.summary ?? "",
            canonicalArgumentsJson: "{}",
            state: request.approve ? ApprovalState.APPROVED : ApprovalState.DENIED,
          };
        },
      } as never);
      router.service(Teams, {
        listTeams: () => ({
          teams: fake.teams.map((team) => ({ ...team, revision: 1n })),
          nextCursor: "",
        }),
        listWorkstreamPosts: (request: { team: string }) => ({
          posts: fake.posts
            .filter((post) => post.teamId === request.team)
            .map((post) => ({
              ...post,
              toTagIds: [],
              sourceTaskId: "",
              sequence: BigInt(post.sequence),
              createdAtMs: BigInt(Date.now()),
            })),
          nextCursor: "",
        }),
      } as never);
      router.service(WorkSessions, {
        list: (request: { parentTagId: string; parentSessionId: string }) => ({
          workSessions: fake.workSessions
            .filter(
              (work) =>
                work.tagId === request.parentTagId &&
                work.parentSessionId === request.parentSessionId,
            )
            .map((work) => fake.workSessionMessage(work)),
          nextCursor: "",
        }),
      } as never);
      router.service(WorkspaceLandings, {
        list: (request: { sessionId: string }) => {
          const work = fake.workSessions.find((entry) => entry.workSessionId === request.sessionId);
          return {
            landings: work?.pullRequest
              ? [
                  {
                    landingId: "landing-1",
                    sessionId: work.workSessionId,
                    branch: "",
                    target: "main",
                    createdOrder: 1n,
                    pullRequest: { repository: "acme/app", number: 7n, url: work.pullRequest },
                  },
                ]
              : [],
          };
        },
      } as never);
      router.service(Memories, {
        list: (request: { tagId: string }) => ({
          memories: fake.notes
            .filter((note) => note.tagId === request.tagId)
            .map((note) => ({
              memoryId: note.memoryId,
              tagId: note.tagId,
              text: note.text,
              createdBy: "task:1",
              createdAtMs: BigInt(Date.now()),
              updatedAtMs: BigInt(Date.now()),
              ...(note.private ? { audience: { principal: "operator:local" } } : {}),
            })),
        }),
        delete: (request: { memoryId: string }) => {
          const note = fake.notes.find((entry) => entry.memoryId === request.memoryId);
          fake.notes = fake.notes.filter((entry) => entry !== note);
          if (note) fake.notify({ kind: WatchKind.MEMORY, tagId: note.tagId });
          return { memoryId: request.memoryId, tagId: note?.tagId ?? "", text: note?.text ?? "" };
        },
      } as never);
      const scheduleMessage = (schedule: (typeof fake.schedules)[number]) => ({
        scheduleId: schedule.scheduleId,
        tagId: schedule.tagId,
        note: schedule.note,
        state: schedule.state,
        atMs: BigInt(Date.now() + 3_600_000),
        createdBy: "task:1",
        fireCount: 0n,
        missedCount: 0n,
      });
      const changeSchedule =
        (state: ScheduleState | undefined) => (request: { scheduleId: string }) => {
          const schedule = fake.schedules.find((entry) => entry.scheduleId === request.scheduleId);
          if (!schedule) throw new ConnectError("no Schedule", Code.NotFound);
          if (state === undefined)
            fake.schedules = fake.schedules.filter((entry) => entry !== schedule);
          else schedule.state = state;
          fake.notify({ kind: WatchKind.SCHEDULE, tagId: schedule.tagId });
          return scheduleMessage(schedule);
        };
      router.service(Schedules, {
        list: (request: { tagId: string }) => ({
          schedules: fake.schedules
            .filter((schedule) => schedule.tagId === request.tagId)
            .map(scheduleMessage),
        }),
        pause: changeSchedule(ScheduleState.PAUSED),
        resume: changeSchedule(ScheduleState.ACTIVE),
        delete: changeSchedule(undefined),
      } as never);
      router.service(NetworkLogs, {
        list: (request: { tagId: string }) => ({
          logs: fake.networkLogs
            .filter((log) => log.tagId === request.tagId)
            .map((log) => ({
              taskId: log.taskId,
              attemptId: `${log.taskId}-1`,
              log: {
                allowed: BigInt(log.allowed),
                denied: BigInt(log.denied),
                unrecorded: 0n,
                requests: log.requests.map((request) => ({
                  atMs: BigInt(Date.now()),
                  method: request.method,
                  origin: request.origin,
                  path: request.path,
                  allowed: request.allowed,
                  reason: request.reason ?? "",
                  status: request.allowed ? 200 : 0,
                  credential: "",
                })),
              },
            })),
        }),
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
      objectives: createClient(Objectives, transport),
      inbox: createClient(Inbox, transport),
      teams: createClient(Teams, transport),
      workSessions: createClient(WorkSessions, transport),
      workspaceLandings: createClient(WorkspaceLandings, transport),
      memories: createClient(Memories, transport),
      schedules: createClient(Schedules, transport),
      networkLogs: createClient(NetworkLogs, transport),
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
