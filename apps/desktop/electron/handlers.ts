/**
 * The main process's handler for every channel: the shell's own channels, the Gateway
 * connection (`gateway/`, on `supertag-ai`), and the local services and onboarding (`local/`,
 * on the app's CLI).
 */
import type { NotificationRequest } from "./channels";
import { gatewayHandlers } from "./gateway/handlers";
import type { GatewayState } from "./gateway/state";
import type { Handlers } from "./ipc";
import { type LocalDependencies, localHandlers } from "./local/handlers";
import { badgeCount, notificationRequest, webUrl } from "./shell";

export interface Shell {
  notify(request: NotificationRequest): void;
  setBadge(count: number): void;
  openExternal(url: string): Promise<void>;
  chooseFolder(): Promise<string | null>;
  /** Shows a file in Finder or the file manager. */
  reveal(path: string): void;
}

/** The Gateway connection the window's Gateway channels use, and where it caches. */
export interface GatewayBackend {
  state: GatewayState;
  cacheRoot: string;
}

export function handlers(
  shell: Shell,
  gateway: GatewayBackend,
  local: LocalDependencies,
): Handlers {
  return {
    ...gatewayHandlers(gateway.state, { reveal: shell.reveal }, gateway.cacheRoot),
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
