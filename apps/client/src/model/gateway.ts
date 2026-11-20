/**
 * What a SuperTag front end shows of a Gateway: Tags, conversations and their messages, memory,
 * Schedules, and the saved Gateways, as the desktop window and the terminal UI receive them.
 * `Gateway` is one connection as a view uses it. No DOM and no Node.js here.
 */
import type {
  ApprovalDetails,
  InboxItem,
  NewObjective,
  Objective,
  Team,
  WorkBranch,
  WorkSession,
  WorkstreamPost,
} from "./coordination";

export interface Tag {
  tagId: string;
  name?: string;
  instructions: string;
  allowedActions: string[];
  revision: number;
  harnessKind: string;
  /** Whether this is the Gateway's lead Tag, the one `supertag init` creates. */
  lead?: boolean;
  /** How many Work Sessions the Tag may have open at once, and has open. */
  maxWorkSessions?: number;
  openWorkSessions?: number;
}

export interface Task {
  taskId: string;
  tagId: string;
  sessionId: string;
  prompt?: string;
  state: string;
  result?: string;
  /** When the operator sent it, in milliseconds since the epoch, once the Gateway says. */
  createdAtMs?: number;
  /** The turn finished quietly: no person was waiting and it found nothing to say. */
  quiet?: boolean;
  /** The Worker Host holding the Session's last delivery, which the running turn waits for. */
  waitingForHolder?: string;
  /** The turn's current Task Attempt, which an uncertain turn's decision names. */
  attemptId?: string;
}

export interface Message {
  task: Task;
  /** The message's place in its conversation. Later messages have larger orders. */
  order: number;
  /** When its turn finished, if the Gateway recorded it. */
  completedAtMs?: number;
  liveInput?: { taskId: string; state: string };
  workSessionReportId?: string;
  /** The Schedule that queued this turn. It has no message from the operator. */
  scheduleId?: string;
  /** For a report turn whose work Session has since closed: why, such as `idle`. */
  workSessionClosed?: string;
  /**
   * What the turn shows from its events, oldest first: each message the Tag wrote and its latest
   * activity or plan. The last is the turn's latest event.
   */
  events?: TaskEvent[];
  /** Earlier messages the Tag wrote were left out; `events` reads them. */
  eventsTruncated?: boolean;
}

/** The caller's one conversation with a Tag, as a conversation list shows it. */
export interface Conversation {
  tagId: string;
  conversationId: string;
  /** The latest message: the Tag's reply when it finished, otherwise the caller's message. */
  preview: string;
  previewFromTag: boolean;
  lastActivityAtMs: number;
  latestOrder: number;
  /** How far the caller has read, as a message order. */
  readOrder: number;
  /** Finished replies after `readOrder`. */
  unreadCount: number;
  /** A Task of the conversation is queued or running. */
  working: boolean;
  /** The latest message is the Tag's question, still unanswered. */
  asking?: boolean;
}

export interface MessagePage {
  messages: Message[];
  nextCursor?: string;
  /** Empty before the caller's first message to the Tag. */
  conversationId: string;
  /** The page holds only what changed after the request's `after`; otherwise it is the newest. */
  incremental?: boolean;
}

/**
 * A page of the caller's conversation with a Tag before `cursor`, or the changes after `after`
 * to a copy of conversation `conversationId`, with the current state of `refreshTaskIds`.
 */
export interface ReadMessages {
  tagId: string;
  cursor?: string;
  after?: number;
  conversationId?: string;
  refreshTaskIds?: string[];
}

export interface TaskEvent {
  sequence: number;
  /**
   * `message`: a message the Tag wrote while its turn ran. `activity`: one line saying what it
   * was doing. `progress`: its plan, as `progress.updated` JSON.
   */
  kind: "message" | "activity" | "progress" | "unspecified";
  text: string;
}

export interface Gateway {
  tags(): Promise<Tag[]>;
  /** The caller's conversation with each Tag it has talked to, the latest active first. */
  conversations(): Promise<Conversation[]>;
  messages(read: ReadMessages): Promise<MessagePage>;
  send(tagId: string, text: string, operationId: string): Promise<Message>;
  /** Records that the caller read its conversation with a Tag up to a finished turn. */
  markRead(tagId: string, order: number): Promise<Conversation>;
  /** All of a Task's events after a sequence, oldest first. */
  events(taskId: string, afterSequence: number): Promise<TaskEvent[]>;
  /**
   * Pushes the changes of the caller's conversation with `read.tagId` after the copy `read`
   * describes, until the returned stop is called.
   */
  follow?(
    read: ReadMessages,
    receive: (update: FollowUpdate) => void,
  ): Promise<() => Promise<void>>;
  /** The Tag's memory that a Worker Host on this machine keeps, newest first. */
  harnessMemory?(tagId: string): Promise<HarnessMemoryList>;
  /** Removes one memory, or a proposed change to it, from its harness's files at once. */
  deleteHarnessMemory?(memoryId: string): Promise<HarnessMemory>;
  /** How the Tag's unprompted messages landed lately, and its start rate. */
  tagActivity?(tagId: string): Promise<TagActivity>;
  /** Where a Task's files are; a running Task's checkout on this machine is read here. */
  locateTaskFiles?(taskId: string): Promise<TaskFilesPlace>;
  /** One directory of a located Task's files. */
  listTaskFiles?(taskId: string, path: string): Promise<TaskFileEntry[]>;
  /** One text file of a located Task's files; binary files are refused. */
  readTaskFile?(
    taskId: string,
    path: string,
  ): Promise<{ path: string; text: string; size: number }>;
  /** Shows one of a located Task's files in Finder. */
  revealTaskFile?(taskId: string, path: string): Promise<void>;
  /** The Tag's newest Task Attempts with a network log, newest first. Operators only. */
  networkLogs?(tagId: string): Promise<NetworkLog[]>;
  /** The Tag's Schedules the caller can see. */
  schedules?(tagId: string): Promise<Schedule[]>;
  /** Pauses, resumes, or deletes a Schedule. A deleted Schedule never fires again. */
  changeSchedule?(scheduleId: string, action: ScheduleAction): Promise<Schedule>;
  /** Every Objective the caller can see, open and closed. */
  objectives?(): Promise<Objective[]>;
  objective?(objectiveId: string): Promise<Objective>;
  /** Creates an Objective, which starts its owner's first turn; the same ID again retries it. */
  createObjective?(created: NewObjective): Promise<Objective>;
  /** Sends a follow-up to an Objective's owner in its Session. */
  messageObjective?(objectiveId: string, text: string): Promise<{ taskId: string; tagId: string }>;
  /** Approves an Objective ready for review, or asks for changes. */
  reviewObjective?(objectiveId: string, approved: boolean, feedback: string): Promise<Objective>;
  /** A Task's state and, once finished, its result. */
  taskResult?(taskId: string): Promise<{ state: string; result: string }>;
  /** The inbox items an operator decides. */
  inbox?(): Promise<InboxItem[]>;
  approval?(approvalId: string): Promise<ApprovalDetails>;
  answerQuestion?(taskId: string, text: string): Promise<{ taskId: string }>;
  /** Approves an approval request once, or denies it with a reason. */
  decideApproval?(approvalId: string, approve: boolean, reason: string): Promise<ApprovalDetails>;
  /**
   * Decides about an uncertain turn whose Worker Host confirmed it stopped: run it again, or
   * record it as failed so the Session's next turn runs. The app writes the audited evidence.
   */
  resolveAttempt?(
    taskId: string,
    attemptId: string,
    decision: AttemptDecisionName,
  ): Promise<{ state: string }>;
  teams?(): Promise<Team[]>;
  /** A Team's newest Workstream posts, oldest first. */
  workstreamPosts?(teamId: string): Promise<WorkstreamPost[]>;
  /** The Work Sessions the turns of a Tag's Session started. */
  workSessions?(tagId: string, sessionId: string): Promise<WorkSession[]>;
  /** Where a Work Session's delivery is; nothing before it delivered a commit. */
  workBranch?(work: WorkSession): Promise<WorkBranch | undefined>;
  /** The commands and tools a Task ran, oldest first. */
  taskActivity?(taskId: string): Promise<string[]>;
  /**
   * The Gateway and principal this connection acts as. What is cached under one scope is
   * never shown under another.
   */
  readonly scope: string;
  /**
   * What the app last cached for this connection's Gateway and principal under `key`:
   * `roster`, `outbox`, `drafts`, or `tag:` and a Tag ID.
   */
  readCache(key: CacheKey): Promise<unknown>;
  writeCache(key: CacheKey, value: unknown): Promise<void>;
}

export type CacheKey = "roster" | "outbox" | "drafts" | `tag:${string}`;

/** A decision about an uncertain Task Attempt: run its Task again, or record it as failed. */
export type AttemptDecisionName = "retry" | "failed";

/** Why a queued turn still waits for a Worker Host; an empty reason clears an earlier one. */
export interface TurnWait {
  taskId: string;
  reason: string;
}

/**
 * The text of the message a running turn's Tag is writing now, all of it so far; empty text
 * clears it. The message, once recorded, or the turn's result replaces it.
 */
export interface TurnText {
  taskId: string;
  text: string;
}

/**
 * What a conversation follow pushes: `ready` once its stream is open, `lost` when it dropped (it
 * reopens on its own), and `changed` with the messages that changed, why queued turns wait, and
 * the text running turns are writing.
 */
export type FollowUpdate =
  | { kind: "ready" | "lost" }
  | { kind: "changed"; messages?: MessagePage; waits?: TurnWait[]; texts?: TurnText[] };

export type WatchUpdate =
  | { kind: "ready" | "resync" | "lost" | "tag" }
  /** The caller's conversation with the Tag changed, or was marked read. */
  | { kind: "conversation"; tagId: string }
  /** One of the Tag's Schedules was created, changed, or fired. */
  | { kind: "schedule"; tagId: string }
  /** An Objective was created or changed: its status, limits, or spend. */
  | { kind: "objective"; objectiveId: string }
  /** A Team changed, or its Workstream has a new post. */
  | { kind: "team"; teamId: string }
  /** A Task outside a conversation changed: a Work Session's or an Objective's turn. */
  | { kind: "work"; tagId: string; sessionId: string };

/**
 * One memory a Tag's harness keeps itself, such as a Claude Code auto-memory file or a Codex
 * note, as a Worker Host on this machine reads it from the harness's files. It never passes
 * through the Control Plane, so only the machine whose Worker Host keeps it can show it.
 */
export interface HarnessMemory {
  /** `hmem_` and 24 hex digits. */
  memoryId: string;
  tagId: string;
  /** `claude-code` or `codex`. */
  harness: string;
  /** Private to one person's conversations; otherwise every conversation's turns see it. */
  private: boolean;
  /** `preference`, `feedback`, `fact`, `reference`, or `procedure`. */
  kind: string;
  title: string;
  hook?: string;
  /** Up to 2 KB of its text; `truncated` when its file holds more. */
  text: string;
  truncated: boolean;
  /**
   * `proposed-only` when the turn that last changed it, such as a Work Session's own turn, may
   * not write the Tag's memory; unknown when no recorded turn did.
   */
  trust?: "trusted" | "proposed-only";
  /**
   * `owned` for the Tag's own memory; `proposed` for a change a Work Session proposed, which
   * waits for the Tag's daily memory review to merge or drop it.
   */
  status: "owned" | "proposed";
  /** Its file in the harness's memory folder. */
  path: string;
  /** The Worker Host that keeps it. */
  hostId?: string;
  updatedAtMs: number;
}

/** A Tag's memory on this machine. */
export interface HarnessMemoryList {
  memories: HarnessMemory[];
  /** Why none can be read here, when none can. */
  unavailable?: string;
  /** Worker Hosts elsewhere that keep some of the Tag's memory. */
  keptOn: string[];
}

/** One request a Task Attempt's egress proxy allowed or refused. Never headers or bodies. */
export interface NetworkRequest {
  atMs: number;
  method: string;
  origin: string;
  /** The path without its query, with credentials redacted. */
  path: string;
  allowed: boolean;
  /** Why it was refused. */
  reason?: string;
  /** The origin's HTTP status, when the request reached it. */
  status?: number;
  /** The Worker Host credential the proxy added. */
  credential?: string;
}

/**
 * How a Tag's unprompted messages (Schedule fires, Objective notices) landed over the last
 * `windowDays`, and its start rate when it has one. `describe tag` shows the same.
 */
export interface TagActivity {
  windowDays: number;
  posted: number;
  /** Read in a person's conversation; surfaces have no read receipts. */
  read: number;
  /** Answered in the same Session within a day. */
  answered: number;
  /** Checks that found nothing and posted nothing. */
  quiet: number;
  startRate?: { starts: number; perMs: number; inWindow: number };
  /** Its working Objectives that sit idle: the owner's last turn left nothing running or asked. */
  idleObjectives?: { objectiveId: string; outcome: string; idleSinceMs: number }[];
}

/** Where a Task's files are: on this machine (listed and read here) or why they can't be read. */
export interface TaskFilesPlace {
  local: boolean;
  /** The Task is running, so its files can still change. */
  live: boolean;
  hostId?: string;
  reason?: string;
}

/** One entry of a Task's files: a directory, a file, or a link (listed, never followed). */
export interface TaskFileEntry {
  name: string;
  /** Relative to the Task's checkout, with `/` separators. */
  path: string;
  kind: "directory" | "file" | "link";
  size: number;
  modifiedMs: number;
  /** Opens in the viewer; binary files are listed only. */
  text: boolean;
}

/** A Task Attempt's network log: its first requests and how many it allowed and refused. */
export interface NetworkLog {
  taskId: string;
  attemptId: string;
  allowed: number;
  denied: number;
  /** Requests counted but not kept. */
  unrecorded: number;
  requests: NetworkRequest[];
}

/** A wake-up a Tag set for itself or an operator declared: once at a time, or on a recurrence. */
export interface Schedule {
  scheduleId: string;
  tagId: string;
  note: string;
  state: "active" | "paused" | "staged" | "done" | "cancelled";
  atMs?: number;
  /** A cron expression in an IANA time zone. */
  every?: { cron: string; timeZone: string };
  nextDueAtMs?: number;
  createdBy: string;
  fireCount: number;
  missedCount: number;
  lastFiredAtMs?: number;
}

export type ScheduleAction = "pause" | "resume" | "delete";

export interface GatewayProfile {
  name: string;
  origin: string;
}

/** What the app calls the local Gateway in place of a saved origin. */
export const LOCAL_GATEWAY = "local";

/**
 * The Gateway `supertag up` runs on this machine: its origin while it runs, otherwise why it
 * is unavailable. It connects with this machine's own credentials, which are never saved.
 */
export interface LocalGateway {
  origin?: string;
  problem?: string;
}

/** The local Gateway runs `running`, an older SuperTag release than this app's `version`. */
export interface LocalUpgrade {
  running: string;
  version: string;
}

/** What a restart of the local services is doing: `supertag down`, then `supertag up`. */
export type RestartStep = "stopping" | "starting";

export interface GatewayList {
  profiles: GatewayProfile[];
  active?: string | null;
  local?: LocalGateway;
}

/** The Gateway a connection reached: its SuperTag release and the protocol version agreed. */
export interface GatewayRelease {
  /** Such as `0.3.4`; `unknown` when the Gateway named none. */
  build: string;
  protocol: number;
}

export interface GatewayActivation {
  gateways: GatewayList;
  /** The saved origin connected to, or `local` for the local Gateway. */
  origin: string;
  connectionId: string;
  tags: Tag[];
  /** Whom the saved credential acts as, such as `operator:local` or `client:alice-laptop`. */
  principal: string;
  release: GatewayRelease;
}

/** The scope of a connection's cached conversations: its Control Plane and principal. */
export function cacheScope(origin: string, principal: string) {
  return JSON.stringify([origin, principal]);
}

/** How many of a Gateway's Worker Hosts are in each phase, by name: `ready`, `unreachable`… */
export type HostPhases = Record<string, number>;

/** The Worker Hosts as one status line: `2 ready, 1 unreachable`, or `no Worker Hosts`. */
export function hostLine(phases: HostPhases): string {
  const order = ["ready", "busy", "pending", "draining", "suppressed", "unreachable", "unknown"];
  const parts = Object.entries(phases)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([phase, count]) => `${count} ${phase}`);
  return parts.length ? parts.join(", ") : "no Worker Hosts";
}
