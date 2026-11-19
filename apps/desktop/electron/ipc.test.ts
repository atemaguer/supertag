import type { IpcMainInvokeEvent, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { CHANNELS, type Channel, STREAM_END, STREAM_UPDATE } from "./channels";
import { GatewayState } from "./gateway/state";
import { handlers } from "./handlers";
import {
  dispatch,
  type Handlers,
  originOf,
  REFUSED,
  registerChannels,
  Streams,
  trustedSender,
} from "./ipc";
import type { LocalDependencies } from "./local/handlers";

type Event = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

function contents(url: string) {
  const sent: unknown[][] = [];
  const mainFrame = { url };
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    send: (...args: unknown[]) => sent.push(args),
  } as unknown as WebContents;
  return { webContents, mainFrame, sent };
}

const trusted = { origins: ["app://supertag"] };
const eventFrom = (sender: WebContents, frame: unknown): Event =>
  ({ sender, senderFrame: frame }) as Event;

it("lets only the main window's top frame at the app's origin call the main process", () => {
  const main = contents("app://supertag/index.html");
  const other = contents("app://supertag/index.html");
  const remote = contents("https://untrusted.example/");
  const right = eventFrom(main.webContents, main.mainFrame);
  expect(trustedSender(right, main.webContents, trusted)).toBe(true);
  // Another window, even at the app's origin.
  expect(
    trustedSender(eventFrom(other.webContents, other.mainFrame), main.webContents, trusted),
  ).toBe(false);
  // The main window navigated somewhere else.
  expect(
    trustedSender(eventFrom(remote.webContents, remote.mainFrame), remote.webContents, trusted),
  ).toBe(false);
  // A subframe of the main window, or a frame already gone.
  const child = { url: "app://supertag/index.html" };
  expect(trustedSender(eventFrom(main.webContents, child), main.webContents, trusted)).toBe(false);
  expect(trustedSender(eventFrom(main.webContents, null), main.webContents, trusted)).toBe(false);
  // No main window at all.
  expect(trustedSender(right, undefined, trusted)).toBe(false);
  // A look-alike host or scheme.
  for (const url of [
    "app://supertag.example/index.html",
    "app://evil/index.html",
    "http://supertag/index.html",
    "file:///index.html",
  ]) {
    const page = contents(url);
    expect(
      trustedSender(eventFrom(page.webContents, page.mainFrame), page.webContents, trusted),
    ).toBe(false);
  }
  // The development server, only when it is trusted.
  const dev = contents("http://127.0.0.1:1420/?preview");
  const devEvent = eventFrom(dev.webContents, dev.mainFrame);
  expect(trustedSender(devEvent, dev.webContents, trusted)).toBe(false);
  expect(
    trustedSender(devEvent, dev.webContents, {
      origins: ["app://supertag", "http://127.0.0.1:1420"],
    }),
  ).toBe(true);
});

it("defines an origin for the custom app scheme", () => {
  expect(originOf("app://supertag/index.html")).toBe("app://supertag");
  expect(originOf("http://127.0.0.1:1420/?preview")).toBe("http://127.0.0.1:1420");
  expect(originOf("not a url")).toBeUndefined();
  expect(originOf("file:///etc/hosts")).toBeUndefined();
});

it("registers exactly the table's channels", () => {
  const registered: string[] = [];
  registerChannels(
    { handle: (channel) => registered.push(channel) },
    handlers(shell(), backend(), local()),
    {
      mainWindow: () => undefined,
      trusted,
      streams: new Streams(),
    },
  );
  expect(registered.sort()).toEqual(
    Object.keys(CHANNELS)
      .map((name) => `supertag:${name}`)
      .sort(),
  );
  // The Tauri app's 39 commands, and the shell's notification, badge and link channels.
  expect(registered).toHaveLength(42);
});

function shell() {
  return {
    notify: vi.fn(),
    setBadge: vi.fn(),
    openExternal: vi.fn(async () => {}),
    chooseFolder: vi.fn(async () => "/tmp/project"),
    reveal: vi.fn(),
  };
}

/** The local services' dependencies, finding no CLI. */
function local(): LocalDependencies {
  return {
    app: { version: "0.0.0", execPath: process.execPath, env: { PATH: "" } },
    protocolVersions: [6],
    probe: async () => undefined,
    chooseWorkspaceFolder: async () => null,
    localStateOf: async () => {
      throw "not the local Gateway";
    },
  };
}

/** A Gateway connection that never connects: nothing here reaches a Gateway or the disk. */
function backend() {
  const state = new GatewayState({
    store: "/nonexistent/gateways.json",
    cache: "/nonexistent/cache",
    buildVersion: "test",
    discoverLocal: async () => {
      throw "No local Gateway in this test.";
    },
  });
  return { state, cacheRoot: "/nonexistent/cache" };
}

function setup(table: Handlers) {
  const main = contents("app://supertag/index.html");
  const streams = new Streams();
  const options = { mainWindow: () => main.webContents, trusted, streams };
  const call = (name: Channel, args: unknown, key?: unknown, from = main) =>
    dispatch(name, table, options, eventFrom(from.webContents, from.mainFrame), args, key);
  return { main, streams, call };
}

it("refuses an untrusted caller before any handler runs, and malformed arguments", async () => {
  const fake = shell();
  const { call } = setup(handlers(fake, backend(), local()));
  const remote = contents("https://untrusted.example/");
  expect(await call("openExternal", { url: "https://example.com" }, undefined, remote)).toEqual({
    ok: false,
    error: REFUSED,
  });
  expect(fake.openExternal).not.toHaveBeenCalled();
  for (const args of [null, "x", [1], new Date()]) {
    expect(await call("listGateways", args)).toEqual({ ok: false, error: REFUSED });
  }
});

it("answers with the handler's value, or its own message, never an internal error", async () => {
  const fake = shell();
  const { call } = setup(handlers(fake, backend(), local()));
  expect(await call("chooseProjectFolder", {})).toEqual({ ok: true, value: "/tmp/project" });
  // With no CLI, nothing local needs starting.
  expect(await call("localStartNeeded", {})).toEqual({ ok: true, value: false });
  // The Gateway channels answer as the Tauri commands did before a connection.
  const send = { connectionId: "1", tagId: "engineer", text: "hello", operationId: "ipc-test" };
  expect(await call("sendMessage", send)).toEqual({
    ok: false,
    error: "Connect to a Gateway first.",
  });
  expect(await call("startGatewayWatch", { connectionId: "1", watchEpoch: 1 }, "s9")).toEqual({
    ok: false,
    error: "The connection changed. Refresh this view.",
  });
  expect(await call("sendMessage", { ...send, tagId: 7 })).toEqual({
    ok: false,
    error: "The app sent an invalid request.",
  });
  expect(await call("openExternal", { url: "javascript:alert(1)" })).toEqual({
    ok: false,
    error: "Only web links open in the browser.",
  });
  expect(await call("openExternal", { url: "https://ci.example.com/runs/7" })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(fake.openExternal).toHaveBeenCalledWith("https://ci.example.com/runs/7");

  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = {
    ...handlers(fake, backend(), local()),
    listTags: async () => {
      throw new Error("upstream detail: token abc");
    },
  };
  const reply = await setup(broken).call("listTags", { connectionId: "1" });
  expect(reply.ok).toBe(false);
  expect(JSON.stringify(reply)).not.toContain("token abc");
  log.mockRestore();
});

it("pushes stream updates under the preload's key until the stream ends", async () => {
  let pushed: ((update: unknown) => void) | undefined;
  const stopped = vi.fn();
  const table: Handlers = {
    ...handlers(shell(), backend(), local()),
    async startGatewayWatch(_args, stream) {
      pushed = (update) => stream.send(update as never);
      stream.onEnd(stopped);
      return "watch-1";
    },
    async restartLocalServices(_args, stream) {
      stream.send("stopping");
      stream.send("starting");
    },
  };
  const { main, streams, call } = setup(table);
  // A stream call needs the preload's key.
  expect(await call("startGatewayWatch", { connectionId: "1", watchEpoch: 1 })).toEqual({
    ok: false,
    error: REFUSED,
  });
  expect(await call("startGatewayWatch", { connectionId: "1", watchEpoch: 1 }, "s1")).toEqual({
    ok: true,
    value: "watch-1",
  });
  pushed?.({ kind: "ready" });
  expect(main.sent).toEqual([[STREAM_UPDATE, "s1", { kind: "ready" }]]);
  expect(streams.size).toBe(1);

  // A progress stream ends with its call.
  await call("restartLocalServices", {}, "s2");
  expect(main.sent.slice(1)).toEqual([
    [STREAM_UPDATE, "s2", "stopping"],
    [STREAM_UPDATE, "s2", "starting"],
    [STREAM_END, "s2"],
  ]);

  // A reload ends every open stream, and nothing more is pushed.
  streams.endAll();
  expect(stopped).toHaveBeenCalledOnce();
  expect(main.sent.at(-1)).toEqual([STREAM_END, "s1"]);
  pushed?.({ kind: "lost" });
  expect(main.sent.at(-1)).toEqual([STREAM_END, "s1"]);
  expect(streams.size).toBe(0);
});

it("mirrors the Tauri commands one for one, which the Tauri bridge calls by snake-cased name", async () => {
  const { readFile } = await import("node:fs/promises");
  const permission = await readFile(
    new URL("../src-tauri/permissions/gateway.toml", import.meta.url),
    "utf8",
  );
  const allowed = [...(permission.split("commands.allow = [")[1] ?? "").matchAll(/"([a-z_]+)"/g)]
    .map((match) => match[1])
    .sort();
  const shellChannels = ["notify", "setBadge", "openExternal"];
  const commands = Object.keys(CHANNELS)
    .filter((name) => !shellChannels.includes(name))
    .map((name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))
    .sort();
  expect(commands).toEqual(allowed);
});
