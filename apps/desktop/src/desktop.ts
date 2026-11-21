import { CHANNELS, type SupertagApi } from "../electron/channels";

declare global {
  interface Window {
    /** The desktop app's bridge to its main process; absent in a browser, as in `?preview`. */
    readonly supertag?: SupertagApi;
  }
}

const ABSENT = "Open this in the SuperTag desktop app.";

/** Outside the desktop app every call rejects, as a command the window may not call. */
const absent = {
  ...Object.fromEntries(Object.keys(CHANNELS).map((name) => [name, () => Promise.reject(ABSENT)])),
  onNotificationClick: () => () => {},
  onUpdateStatus: () => () => {},
} as unknown as SupertagApi;

/** The desktop app's bridge to its main process. */
export function desktop(): SupertagApi {
  return window.supertag ?? absent;
}

/** Whether this window runs in the desktop app, rather than a browser. */
export function inDesktopApp(): boolean {
  return window.supertag !== undefined;
}
