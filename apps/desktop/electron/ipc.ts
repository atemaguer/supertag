/**
 * The main process's side of the channel table: the sender guard, one handler per channel, and
 * the streams handlers push to. It imports no Electron runtime, so tests drive it with fake
 * events.
 */
import type { IpcMainInvokeEvent, WebContents } from "electron";
import {
  type Call,
  CHANNELS,
  type Channel,
  type Commands,
  invokeChannel,
  type Reply,
  STREAM_END,
  STREAM_UPDATE,
  type Stream,
} from "./channels";

/** Where the window's own pages come from: `app://supertag/`, and in development the Vite URL. */
export interface TrustedOrigins {
  /** Origins such as `app://supertag` and `http://127.0.0.1:1420`, without a trailing slash. */
  readonly origins: readonly string[];
}

/** `scheme://host[:port]` of a URL; unlike `URL.origin`, defined for the custom `app:` scheme. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.host) return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether an IPC call comes from the app's own page in the main window: the main window's
 * webContents, its top frame, at an app origin. Anything else is refused before a handler runs,
 * as Tauri refused commands from another window or a remote URL.
 */
export function trustedSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  main: WebContents | undefined,
  trusted: TrustedOrigins,
): boolean {
  if (!main || main.isDestroyed() || event.sender !== main) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== main.mainFrame) return false;
  const origin = originOf(frame.url);
  return origin !== undefined && trusted.origins.includes(origin);
}

/** A stream a handler pushes updates to, until it ends. */
export interface StreamSink<U> {
  send(update: U): void;
  /** Ends the stream; the preload drops its callback. Idempotent. */
  end(): void;
  readonly ended: boolean;
  /** Runs once the stream ends, by `end` or the window resetting. */
  onEnd(stop: () => void): void;
}

type Handler<C> =
  C extends Stream<infer A, infer R, infer U>
    ? (args: A, stream: StreamSink<U>) => Promise<R>
    : C extends Call<infer A, infer R>
      ? (args: A) => Promise<R>
      : never;

/** One handler per channel; a missing or extra one is a type error. */
export type Handlers = { [K in Channel]: Handler<Commands[K]> };

/** The streams open in the window, ended together when it reloads, crashes or closes. */
export class Streams {
  private readonly open = new Set<StreamSink<unknown>>();

  create<U>(target: Pick<WebContents, "send" | "isDestroyed">, key: string): StreamSink<U> {
    const stops: (() => void)[] = [];
    let ended = false;
    const sink: StreamSink<U> = {
      send(update) {
        if (!ended && !target.isDestroyed()) target.send(STREAM_UPDATE, key, update);
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.open.delete(sink as StreamSink<unknown>);
        if (!target.isDestroyed()) target.send(STREAM_END, key);
        for (const stop of stops.splice(0)) {
          try {
            stop();
          } catch {
            // A stream's own cleanup failing must not keep the others open.
          }
        }
      },
      get ended() {
        return ended;
      },
      onEnd(stop) {
        if (ended) stop();
        else stops.push(stop);
      },
    };
    this.open.add(sink as StreamSink<unknown>);
    return sink;
  }

  /** Ends every open stream: the window reloaded, crashed or closed. */
  endAll() {
    for (const sink of [...this.open]) sink.end();
  }

  get size() {
    return this.open.size;
  }
}

/** The one refusal a window outside the guard sees, as Tauri's "not allowed". */
export const REFUSED = "This window is not allowed to call SuperTag.";
const FAILED = "Something went wrong in the SuperTag app.";
const STREAM_KEY = /^s[0-9]{1,15}$/;

/**
 * A handler's failure as the one string the window shows. A thrown string is the handler's own
 * user-facing message (the Tauri commands' `Err(String)`); anything else is logged and hidden.
 */
export function replyError(error: unknown, log: (error: unknown) => void = console.error): string {
  if (typeof error === "string") return error;
  log(error);
  return FAILED;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
  ): void;
}

/**
 * Registers exactly the table's channels. Each call is guarded first, its argument must be one
 * plain object, and a stream call must carry the preload's key for it.
 */
export function registerChannels(
  ipc: IpcRegistrar,
  handlers: Handlers,
  options: {
    mainWindow(): WebContents | undefined;
    trusted: TrustedOrigins;
    streams: Streams;
  },
) {
  for (const name of Object.keys(CHANNELS) as Channel[]) {
    ipc.handle(invokeChannel(name), (event, args, key) =>
      dispatch(name, handlers, options, event, args, key),
    );
  }
}

/** One guarded call; exported for tests. */
export async function dispatch(
  name: Channel,
  handlers: Handlers,
  options: {
    mainWindow(): WebContents | undefined;
    trusted: TrustedOrigins;
    streams: Streams;
  },
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  args: unknown,
  key: unknown,
): Promise<Reply<unknown>> {
  if (!trustedSender(event, options.mainWindow(), options.trusted)) {
    return { ok: false, error: REFUSED };
  }
  if (!plainObject(args)) return { ok: false, error: REFUSED };
  try {
    const kind: string = CHANNELS[name];
    if (kind !== "call") {
      if (typeof key !== "string" || !STREAM_KEY.test(key)) return { ok: false, error: REFUSED };
      const stream = options.streams.create(event.sender, key);
      const handler = handlers[name] as (args: unknown, stream: StreamSink<unknown>) => unknown;
      try {
        const value = await handler(args, stream);
        if (kind === "progress") stream.end();
        return { ok: true, value };
      } catch (error) {
        stream.end();
        throw error;
      }
    }
    const handler = handlers[name] as (args: unknown) => unknown;
    return { ok: true, value: await handler(args) };
  } catch (error) {
    return { ok: false, error: replyError(error) };
  }
}
