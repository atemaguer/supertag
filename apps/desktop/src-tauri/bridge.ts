/**
 * `window.supertag` for the Tauri shell, while it and the Electron shell coexist: the same API
 * the Electron preload exposes, over the Tauri commands, plugins and drag regions it replaces.
 * The renderer imports it only inside a Tauri window. It goes with `src-tauri/`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CHANNELS, type Channel as Name, type SupertagApi } from "../electron/channels";
import { alertId } from "../src/lib/notifications";

/** The Tauri command for a channel: `listGateways` is `list_gateways`. */
const command = (name: Name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The argument each streaming command takes its Tauri channel as. */
const STREAM_ARGUMENT: {
  [K in Name as (typeof CHANNELS)[K] extends "call" ? never : K]: string;
} = {
  startGatewayWatch: "onUpdate",
  startConversationFollow: "onUpdate",
  restartLocalServices: "onProgress",
};

let permission: Promise<boolean> | undefined;

const shell = {
  async notify({
    key,
    tagId,
    title,
    body,
  }: {
    key: string;
    tagId: string;
    title: string;
    body: string;
  }) {
    permission ??= isPermissionGranted()
      .then((granted) => granted || requestPermission().then((state) => state === "granted"))
      .catch(() => false);
    if (await permission) sendNotification({ id: alertId(key), title, body, extra: { tagId } });
  },
  async setBadge({ count }: { count: number }) {
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  },
  async openExternal({ url }: { url: string }) {
    await openUrl(url);
  },
  onNotificationClick(open: (tagId: string) => void) {
    let stopped = false;
    const listening = onAction((event) => {
      const tagId = event.notification?.extra?.tagId;
      if (event.actionId !== "tap" || typeof tagId !== "string") return;
      void getCurrentWindow()
        .setFocus()
        .catch(() => {});
      open(tagId);
    });
    listening.catch(() => {});
    return () => {
      if (stopped) return;
      stopped = true;
      void listening.then((listener) => listener.unregister()).catch(() => {});
    };
  },
};

/** Tauri's own drag regions follow an attribute; the renderer marks them with a class. */
function dragRegions() {
  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element)) return;
    if (!target.classList.contains("drag-region")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const window = getCurrentWindow();
    if (event.detail === 2)
      void invoke("plugin:window|internal_toggle_maximize", { label: window.label });
    else void window.startDragging();
  });
}

export function installTauriBridge() {
  const api: Record<string, unknown> = {};
  for (const name of Object.keys(CHANNELS) as Name[]) {
    const stream = (STREAM_ARGUMENT as Partial<Record<Name, string>>)[name];
    api[name] = stream
      ? (args: Record<string, unknown>, onUpdate: (update: unknown) => void) =>
          invoke(command(name), { ...args, [stream]: new Channel(onUpdate) })
      : (args: Record<string, unknown>) => invoke(command(name), args);
  }
  Object.assign(api, shell);
  Object.defineProperty(window, "supertag", { value: api as SupertagApi });
  dragRegions();
}
