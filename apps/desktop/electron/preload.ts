/**
 * The window's only bridge to the main process: `window.supertag`, one method per channel of the
 * table. It exposes no `ipcRenderer` and no Node globals. A streaming call registers its callback
 * under a fresh key before it asks, so no update is missed; main ends the stream by key.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  CHANNELS,
  type Channel,
  invokeChannel,
  NOTIFICATION_CLICK,
  type Reply,
  STREAM_END,
  STREAM_UPDATE,
  type SupertagApi,
} from "./channels";

const streams = new Map<string, (update: unknown) => void>();
let nextStream = 0;
const clicks = new Set<(tagId: string) => void>();

ipcRenderer.on(STREAM_UPDATE, (_event, key: unknown, update: unknown) => {
  if (typeof key === "string") streams.get(key)?.(update);
});
ipcRenderer.on(STREAM_END, (_event, key: unknown) => {
  if (typeof key === "string") streams.delete(key);
});
ipcRenderer.on(NOTIFICATION_CLICK, (_event, tagId: unknown) => {
  if (typeof tagId !== "string") return;
  for (const open of clicks) open(tagId);
});

async function call(name: Channel, args: unknown, key?: string): Promise<unknown> {
  const reply = (await ipcRenderer.invoke(invokeChannel(name), args ?? {}, key)) as Reply<unknown>;
  if (reply.ok) return reply.value;
  // The window sees one user-facing string.
  throw reply.error;
}

const api: Record<string, unknown> = {};
for (const name of Object.keys(CHANNELS) as Channel[]) {
  api[name] =
    CHANNELS[name] === "call"
      ? (args: unknown) => call(name, args)
      : async (args: unknown, onUpdate: (update: unknown) => void) => {
          nextStream += 1;
          const key = `s${nextStream}`;
          streams.set(key, onUpdate);
          try {
            return await call(name, args, key);
          } catch (error) {
            streams.delete(key);
            throw error;
          }
        };
}
api["onNotificationClick"] = (open: (tagId: string) => void) => {
  clicks.add(open);
  return () => {
    clicks.delete(open);
  };
};

contextBridge.exposeInMainWorld("supertag", api as SupertagApi);
