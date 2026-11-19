/**
 * The one table of what the window may ask the main process: the Tauri app's commands, one for
 * one and camel-cased, plus the shell's own notification, badge and link channels. The preload
 * generates `window.supertag` from it, the main process registers exactly one guarded handler per
 * entry, and the renderer's type of `window.supertag` derives from it, so a missing or extra
 * handler is a type error.
 *
 * Every call keeps the Tauri contract: it resolves with the result, or rejects with one
 * user-facing string, never an upstream message.
 */
import type {
  Conversation,
  FollowUpdate,
  GatewayActivation,
  GatewayList,
  LocalUpgrade,
  Message,
  MessagePage,
  NetworkLog,
  Note,
  ReadMessages,
  RestartStep,
  Schedule,
  ScheduleAction,
  SetupCheck,
  Tag,
  TagActivity,
  TaskEvent,
  TaskFileEntry,
  TaskFilesPlace,
  WatchUpdate,
} from "../src/gateway";
import type { AddedWorkspace, NewTag, TagOptions } from "../src/tag-admin";

/** A call that takes no arguments; the window passes `{}`. */
export type NoArgs = Record<string, never>;

/** A call: its argument object and what it resolves with. */
export interface Call<A, R> {
  args: A;
  result: R;
}

/** A call that also pushes updates to a callback until its stop call, or the window resets. */
export interface Stream<A, R, U> extends Call<A, R> {
  update: U;
}

/** A stream that is only its call's progress: it ends when the call does. */
export interface Progress<A, R, U> extends Stream<A, R, U> {
  progress: true;
}

/** One native notification. A newer one with the same key replaces the earlier. */
export interface NotificationRequest {
  key: string;
  tagId: string;
  title: string;
  body: string;
}

interface Connected {
  connectionId: string;
}

export interface Commands {
  // Connection
  listGateways: Call<NoArgs, GatewayList>;
  saveGateway: Call<{ gateway: string; name: string; token: string }, GatewayActivation>;
  selectGateway: Call<{ origin: string }, GatewayActivation>;
  connectLocalGateway: Call<NoArgs, GatewayActivation>;
  clearGateway: Call<{ forget?: string }, GatewayList>;
  // Watch
  startGatewayWatch: Stream<Connected & { watchEpoch: number }, string, WatchUpdate>;
  stopGatewayWatch: Call<{ watchId: string }, void>;
  // Conversations
  listConversations: Call<Connected, Conversation[]>;
  listMessages: Call<Connected & { read: ReadMessages }, MessagePage>;
  sendMessage: Call<Connected & { tagId: string; text: string; operationId: string }, Message>;
  getMessage: Call<Connected & { tagId: string; taskId: string }, Message>;
  listTaskEvents: Call<Connected & { taskId: string; afterSequence: number }, TaskEvent[]>;
  markConversationRead: Call<Connected & { tagId: string; order: number }, Conversation>;
  // Follow
  startConversationFollow: Stream<Connected & { read: ReadMessages }, string, FollowUpdate>;
  stopConversationFollow: Call<{ followId: string }, void>;
  // Tags
  listTags: Call<Connected, Tag[]>;
  tagActivity: Call<Connected & { tagId: string }, TagActivity>;
  listTagOptions: Call<Connected, TagOptions>;
  createTag: Call<Connected & { tag: NewTag }, Tag>;
  /** Local Gateway only: picks a folder and adds its repository as a Workspace. */
  addLocalWorkspace: Call<Connected, AddedWorkspace | null>;
  // Notes
  listNotes: Call<Connected & { tagId: string }, Note[]>;
  deleteNote: Call<Connected & { memoryId: string }, Note>;
  // Network log
  listNetworkLogs: Call<Connected & { tagId: string }, NetworkLog[]>;
  // Schedules
  listSchedules: Call<Connected & { tagId: string }, Schedule[]>;
  changeSchedule: Call<Connected & { scheduleId: string; action: ScheduleAction }, Schedule>;
  // Task files
  locateTaskFiles: Call<Connected & { taskId: string }, TaskFilesPlace>;
  listTaskFiles: Call<Connected & { taskId: string; path: string }, TaskFileEntry[]>;
  readTaskFile: Call<
    Connected & { taskId: string; path: string },
    { path: string; text: string; size: number }
  >;
  revealTaskFile: Call<Connected & { taskId: string; path: string }, void>;
  // Cache
  readCache: Call<Connected & { key: string }, unknown>;
  writeCache: Call<Connected & { key: string; value: unknown }, void>;
  // Local services
  localStartNeeded: Call<NoArgs, boolean>;
  startLocalServices: Call<NoArgs, boolean>;
  localCliProblem: Call<NoArgs, string | null>;
  localGatewayUpgrade: Call<NoArgs, LocalUpgrade | null>;
  restartLocalServices: Progress<NoArgs, void, RestartStep>;
  // Onboarding
  checkSetup: Call<{ directory?: string; harness?: string }, SetupCheck>;
  chooseProjectFolder: Call<NoArgs, string | null>;
  setUpSupertag: Call<{ directory: string; harness: string }, unknown>;
  // The shell: notifications, the Dock badge, web links
  notify: Call<NotificationRequest, void>;
  setBadge: Call<{ count: number }, void>;
  openExternal: Call<{ url: string }, void>;
}

export type Channel = keyof Commands;

type Kind<C> =
  C extends Progress<unknown, unknown, unknown>
    ? "progress"
    : C extends Stream<unknown, unknown, unknown>
      ? "stream"
      : "call";

/**
 * Each channel and whether it streams: `stream` until its stop call, `progress` until the call
 * returns. The runtime half of `Commands`.
 */
export const CHANNELS = {
  listGateways: "call",
  saveGateway: "call",
  selectGateway: "call",
  connectLocalGateway: "call",
  clearGateway: "call",
  startGatewayWatch: "stream",
  stopGatewayWatch: "call",
  listConversations: "call",
  listMessages: "call",
  sendMessage: "call",
  getMessage: "call",
  listTaskEvents: "call",
  markConversationRead: "call",
  startConversationFollow: "stream",
  stopConversationFollow: "call",
  listTags: "call",
  tagActivity: "call",
  listTagOptions: "call",
  createTag: "call",
  addLocalWorkspace: "call",
  listNotes: "call",
  deleteNote: "call",
  listNetworkLogs: "call",
  listSchedules: "call",
  changeSchedule: "call",
  locateTaskFiles: "call",
  listTaskFiles: "call",
  readTaskFile: "call",
  revealTaskFile: "call",
  readCache: "call",
  writeCache: "call",
  localStartNeeded: "call",
  startLocalServices: "call",
  localCliProblem: "call",
  localGatewayUpgrade: "call",
  restartLocalServices: "progress",
  checkSetup: "call",
  chooseProjectFolder: "call",
  setUpSupertag: "call",
  notify: "call",
  setBadge: "call",
  openExternal: "call",
} as const satisfies { [K in Channel]: Kind<Commands[K]> };

/** The IPC channel a table entry is invoked on. */
export const invokeChannel = (name: Channel) => `supertag:${name}`;
/** Main pushes `(key, update)` here for a stream the preload opened under `key`. */
export const STREAM_UPDATE = "supertag:stream";
/** Main says a stream ended: its stop call, or the window reset. */
export const STREAM_END = "supertag:stream-end";
/** Main says a notification was clicked, with its Tag ID. */
export const NOTIFICATION_CLICK = "supertag:notification-click";

/** What a handler sends back over IPC; the preload turns an error into a rejected string. */
export type Reply<R> = { ok: true; value: R } | { ok: false; error: string };

type Method<C> =
  C extends Stream<infer A, infer R, infer U>
    ? (args: A, onUpdate: (update: U) => void) => Promise<R>
    : C extends Call<infer A, infer R>
      ? (args: A) => Promise<R>
      : never;

/** `window.supertag`: one method per channel, and notification clicks. */
export type SupertagApi = { readonly [K in Channel]: Method<Commands[K]> } & {
  /** Calls `open` with the Tag of each clicked notification, until the returned stop. */
  readonly onNotificationClick: (open: (tagId: string) => void) => () => void;
};
