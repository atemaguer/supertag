/**
 * The main process's handler for every channel. The shell's own channels and the local services
 * and onboarding (`local/`) work here; the Gateway connection is still the Tauri app's Rust
 * backend and is ported onto `supertag-ai` next, so until then it refuses with one clear message.
 */
import type { Channel, NotificationRequest } from "./channels";
import type { Handlers } from "./ipc";
import { type LocalDependencies, localHandlers } from "./local/handlers";
import { badgeCount, notificationRequest, webUrl } from "./shell";

export interface Shell {
  notify(request: NotificationRequest): void;
  setBadge(count: number): void;
  openExternal(url: string): Promise<void>;
  chooseFolder(): Promise<string | null>;
}

/** What a channel that is not ported yet answers. */
export function notPorted(name: Channel): string {
  return `The Electron desktop app can't do this yet: ${name} is not yet ported.`;
}

export function handlers(shell: Shell, local: LocalDependencies): Handlers {
  const missing = (name: Channel) => async (): Promise<never> => {
    throw notPorted(name);
  };
  return {
    listGateways: missing("listGateways"),
    saveGateway: missing("saveGateway"),
    selectGateway: missing("selectGateway"),
    connectLocalGateway: missing("connectLocalGateway"),
    clearGateway: missing("clearGateway"),
    startGatewayWatch: missing("startGatewayWatch"),
    stopGatewayWatch: missing("stopGatewayWatch"),
    listConversations: missing("listConversations"),
    listMessages: missing("listMessages"),
    sendMessage: missing("sendMessage"),
    getMessage: missing("getMessage"),
    listTaskEvents: missing("listTaskEvents"),
    markConversationRead: missing("markConversationRead"),
    startConversationFollow: missing("startConversationFollow"),
    stopConversationFollow: missing("stopConversationFollow"),
    listTags: missing("listTags"),
    tagActivity: missing("tagActivity"),
    listTagOptions: missing("listTagOptions"),
    createTag: missing("createTag"),
    listNotes: missing("listNotes"),
    deleteNote: missing("deleteNote"),
    listNetworkLogs: missing("listNetworkLogs"),
    listSchedules: missing("listSchedules"),
    changeSchedule: missing("changeSchedule"),
    locateTaskFiles: missing("locateTaskFiles"),
    listTaskFiles: missing("listTaskFiles"),
    readTaskFile: missing("readTaskFile"),
    revealTaskFile: missing("revealTaskFile"),
    readCache: missing("readCache"),
    writeCache: missing("writeCache"),
    chooseProjectFolder: () => shell.chooseFolder(),
    ...localHandlers(local),
    async notify(args) {
      const request = notificationRequest(args);
      if (request) shell.notify(request);
    },
    async setBadge({ count }) {
      const checked = badgeCount(count);
      if (checked !== undefined) shell.setBadge(checked);
    },
    async openExternal({ url }) {
      const link = webUrl(url);
      if (!link) throw "Only web links open in the browser.";
      await shell.openExternal(link).catch(() => {
        throw "Could not open the link in your browser.";
      });
    },
  };
}
