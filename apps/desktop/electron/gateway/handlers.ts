/**
 * The Gateway channels of the table, on the main process's {@link GatewayState}. Each checks
 * its arguments' types before anything runs.
 */
import type { NewTag, ReadMessages, ScheduleAction, TagAppearance } from "@supertag/client/model";
import type { GatewayState } from "@supertag/client/node";
import { forget, taskFiles } from "@supertag/client/node";
import type { Handlers } from "../ipc";

export const INVALID_REQUEST = "The app sent an invalid request.";

function text(value: unknown): string {
  if (typeof value !== "string") throw INVALID_REQUEST;
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : text(value);
}

/** A u64 the window sends as a number. */
function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw INVALID_REQUEST;
  }
  return value;
}

function optionalWhole(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : whole(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw INVALID_REQUEST;
  return value as Record<string, unknown>;
}

function readMessages(value: unknown): ReadMessages {
  const read = record(value);
  const refresh = read["refreshTaskIds"] ?? [];
  if (!Array.isArray(refresh)) throw INVALID_REQUEST;
  const checked: ReadMessages = { tagId: text(read["tagId"]), refreshTaskIds: refresh.map(text) };
  const cursor = optionalText(read["cursor"]);
  const after = optionalWhole(read["after"]);
  const conversationId = optionalText(read["conversationId"]);
  if (cursor !== undefined) checked.cursor = cursor;
  if (after !== undefined) checked.after = after;
  if (conversationId !== undefined) checked.conversationId = conversationId;
  return checked;
}

function newTag(value: unknown): NewTag {
  const tag = record(value);
  const checked: NewTag = { tagId: text(tag["tagId"]), harness: text(tag["harness"]) };
  for (const key of ["name", "workspaceId", "workspaceRef", "workspaceCommit"] as const) {
    const found = optionalText(tag[key]);
    if (found !== undefined) checked[key] = found;
  }
  const sessions = optionalWhole(tag["maxWorkSessions"]);
  if (sessions !== undefined) {
    if (sessions > 0xffff_ffff) throw INVALID_REQUEST;
    checked.maxWorkSessions = sessions;
  }
  const web = tag["webAccess"];
  if (web !== undefined && typeof web !== "boolean") throw INVALID_REQUEST;
  if (web !== undefined) checked.webAccess = web;
  return checked;
}

/** A portrait recipe: its IDs are checked by the Control Plane; here only their types. */
function appearance(value: unknown): TagAppearance | null {
  if (value === null) return null;
  const recipe = record(value);
  const version = whole(recipe["version"]);
  if (version > 0xffff_ffff) throw INVALID_REQUEST;
  const accessory = (key: string) => optionalText(recipe[key]) ?? null;
  return {
    version,
    catalog: text(recipe["catalog"]),
    head: text(recipe["head"]),
    color: text(recipe["color"]),
    expression: text(recipe["expression"]),
    hat: accessory("hat"),
    glasses: accessory("glasses"),
    headphones: accessory("headphones"),
  };
}

export interface GatewayShell {
  /** Shows a file in Finder or the file manager. */
  reveal(path: string): void;
}

type GatewayChannels =
  | "listGateways"
  | "saveGateway"
  | "selectGateway"
  | "connectLocalGateway"
  | "clearGateway"
  | "startGatewayWatch"
  | "stopGatewayWatch"
  | "listConversations"
  | "listMessages"
  | "sendMessage"
  | "getMessage"
  | "listTaskEvents"
  | "markConversationRead"
  | "startConversationFollow"
  | "stopConversationFollow"
  | "listTags"
  | "tagActivity"
  | "listTagOptions"
  | "createTag"
  | "getTag"
  | "setTagAppearance"
  | "listNetworkLogs"
  | "listSchedules"
  | "changeSchedule"
  | "resolveAttempt"
  | "locateTaskFiles"
  | "listTaskFiles"
  | "readTaskFile"
  | "revealTaskFile"
  | "readCache"
  | "writeCache";

export function gatewayHandlers(
  state: GatewayState,
  shell: GatewayShell,
  cacheRoot: string,
): Pick<Handlers, GatewayChannels> {
  return {
    listGateways: () => state.savedGateways(),
    saveGateway: (args) => state.saveGateway(text(args.gateway), text(args.name), text(args.token)),
    selectGateway: (args) => state.selectGateway(text(args.origin)),
    connectLocalGateway: () => state.connectLocalGateway(),
    async clearGateway(args) {
      const origin = optionalText(args.forget);
      const listed = await state.clearGateway(origin);
      if (origin !== undefined) await forget(cacheRoot, origin);
      return listed;
    },
    async startGatewayWatch(args, stream) {
      return state.startWatch(text(args.connectionId), whole(args.watchEpoch), {
        send: (update) => {
          if (stream.ended) return false;
          stream.send(update);
          return true;
        },
        onEnd: (stop) => stream.onEnd(stop),
        end: () => stream.end(),
      });
    },
    async stopGatewayWatch(args) {
      state.stopWatch(text(args.watchId));
    },
    listConversations: (args) => state.conversations(text(args.connectionId)),
    listMessages: (args) => state.messages(text(args.connectionId), readMessages(args.read)),
    sendMessage: (args) =>
      state.send(
        text(args.connectionId),
        text(args.tagId),
        text(args.text),
        text(args.operationId),
      ),
    getMessage: (args) =>
      state.message(text(args.connectionId), text(args.tagId), text(args.taskId)),
    listTaskEvents: (args) =>
      state.events(text(args.connectionId), text(args.taskId), whole(args.afterSequence)),
    markConversationRead: (args) =>
      state.markRead(text(args.connectionId), text(args.tagId), whole(args.order)),
    async startConversationFollow(args, stream) {
      return state.startFollow(text(args.connectionId), readMessages(args.read), {
        send: (update) => {
          if (stream.ended) return false;
          stream.send(update);
          return true;
        },
        onEnd: (stop) => stream.onEnd(stop),
        end: () => stream.end(),
      });
    },
    async stopConversationFollow(args) {
      state.stopFollow(text(args.followId));
    },
    listTags: (args) => state.tags(text(args.connectionId)),
    tagActivity: (args) => state.tagActivity(text(args.connectionId), text(args.tagId)),
    listTagOptions: (args) => state.tagOptions(text(args.connectionId)),
    createTag: (args) => state.createTag(text(args.connectionId), newTag(args.tag)),
    getTag: (args) => state.tag(text(args.connectionId), text(args.tagId)),
    setTagAppearance: (args) =>
      state.setTagAppearance(
        text(args.connectionId),
        text(args.tagId),
        appearance(args.appearance),
        whole(args.expectedRevision),
      ),
    listNetworkLogs: (args) => state.networkLogs(text(args.connectionId), text(args.tagId)),
    listSchedules: (args) => state.schedules(text(args.connectionId), text(args.tagId)),
    changeSchedule: (args) =>
      state.changeSchedule(
        text(args.connectionId),
        text(args.scheduleId),
        text(args.action) as ScheduleAction,
      ),
    resolveAttempt(args) {
      const decision = text(args.decision);
      if (decision !== "retry" && decision !== "failed") throw "Choose retry or failed.";
      return state.resolveAttempt(
        text(args.connectionId),
        text(args.taskId),
        text(args.attemptId),
        decision,
        "desktop app",
      );
    },
    locateTaskFiles: (args) => state.locateTaskFiles(text(args.connectionId), text(args.taskId)),
    listTaskFiles: (args) =>
      taskFiles.list(text(args.connectionId), text(args.taskId), text(args.path)),
    readTaskFile: (args) =>
      taskFiles.read(text(args.connectionId), text(args.taskId), text(args.path)),
    async revealTaskFile(args) {
      const file = await taskFiles.absolute(
        text(args.connectionId),
        text(args.taskId),
        text(args.path),
      );
      try {
        shell.reveal(file);
      } catch {
        throw "Could not show the file in Finder.";
      }
    },
    readCache: (args) => state.cached(text(args.connectionId), text(args.key)),
    writeCache: (args) => state.cache(text(args.connectionId), text(args.key), args.value),
  };
}
