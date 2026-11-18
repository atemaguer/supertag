import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, localRelays } from "./rust-fixture.ts";
import {
  batchedWriter,
  type RelayCommandHandle,
  type RelayRunOptions,
  releasableOutput,
  startE2BRelayCommand,
} from "./src/rust-provider/relay-carrier.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const owner = {
  hostId: "host",
  hostGeneration: 5n,
  taskId: "task",
  attemptId: "attempt",
  allocationId: "allocation",
};

it("relies only on what the pinned E2B SDK does with a command's output", () => {
  // The carrier empties the handle's private `_stdout` and `_stderr`, so a version bump that
  // renames them, or stops calling the callbacks with the handle as `this`, must fail here.
  const require = createRequire(import.meta.url);
  const installed = require("e2b/package.json") as { version: string };
  const pinned = (
    JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies["e2b"];
  expect(pinned).toBe(installed.version);
  const source = readFileSync(require.resolve("e2b"), "utf8");
  const handle = source.slice(source.indexOf("var CommandHandle = class"));
  expect(handle).toMatch(/_defineProperty\(this, "_stdout", ""\)/u);
  expect(handle).toMatch(/_defineProperty\(this, "_stderr", ""\)/u);
  expect(handle).toMatch(/_this\d*\._stdout \+= out;/u);
  expect(handle).toMatch(/_this\d*\._stderr \+= out;/u);
  expect(handle).toMatch(/_this\$onStdout\.call\(_this\d*, stdout\)/u);
  expect(handle).toMatch(/_this\$onStderr\.call\(_this\d*, stderr\)/u);
});

it("sends relay input in order, batching what queues behind a request, within its bound", async () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const writer = batchedWriter(async (text) => {
    sent.push(text);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, 10);
  await writer("a\n");
  // Behind the request in flight, writes batch up to the bound, then wait for room.
  await writer("bb\n");
  await writer("ccc\n");
  let fourth = false;
  const waiting = writer("dddd\n").then(() => {
    fourth = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fourth).toBe(false);
  expect(sent).toEqual(["a\n"]);
  release?.();
  await waiting;
  expect(sent).toEqual(["a\n", "bb\nccc\n"]);
  release?.();
  await vi.waitFor(() => expect(sent).toEqual(["a\n", "bb\nccc\n", "dddd\n"]));
  release?.();
  // A failed request fails every later write.
  const failing = batchedWriter(async () => {
    throw new Error("sandbox gone");
  });
  await failing("x\n");
  await vi.waitFor(() => expect(failing("y\n")).rejects.toThrow(/sandbox gone/u));
});

/** A handle as the SDK makes it, whose output the test delivers. */
function handleOf(fields: Record<string, unknown> = { _stdout: "", _stderr: "" }) {
  let finish: (() => void) | undefined;
  const handle = {
    ...fields,
    sendStdin: vi.fn(async (_text: string) => {}),
    kill: vi.fn(async () => {
      finish?.();
      return true;
    }),
    wait: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  let options: RelayRunOptions | undefined;
  const run = vi.fn(async (_command: string, given: RelayRunOptions) => {
    options = given;
    return handle as RelayCommandHandle;
  });
  const emit = (text: string) => {
    const retained = handle as unknown as { _stdout: string };
    retained._stdout += text;
    options?.onStdout.call(handle, text);
  };
  return { handle, run, emit };
}

it("refuses an SDK handle whose output it cannot release, and releases it otherwise", async () => {
  const changed = handleOf({ output: "" });
  await expect(startE2BRelayCommand(changed.run, ["relay"], () => {})).rejects.toThrow(
    /no longer releases its output/u,
  );
  expect(changed.handle.kill).toHaveBeenCalled();
  const seen: string[] = [];
  const { handle, run, emit } = handleOf();
  await startE2BRelayCommand(run, ["relay"], (text) => seen.push(text));
  expect(run.mock.calls[0]?.[1]).toMatchObject({
    user: "root",
    background: true,
    stdin: true,
    timeoutMs: 0,
  });
  emit("O 1\n");
  emit("D 1 aGVsbG8=\n");
  expect(seen).toEqual(["O 1\n", "D 1 aGVsbG8=\n"]);
  expect(releasableOutput(handle)).toBe(true);
  expect((handle as unknown as { _stdout: string })._stdout).toBe("");
});

it("ends the relay once its output passes the byte budget", async () => {
  const seen: string[] = [];
  const { handle, run, emit } = handleOf();
  const relay = await startE2BRelayCommand(run, ["relay"], (text) => seen.push(text), {
    outputBudget: 16,
  });
  emit("D 1 aGVsbG8=\n");
  emit("D 1 aGVsbG8=\n");
  emit("D 1 aGVsbG8=\n");
  await relay.ended;
  expect(seen).toEqual(["D 1 aGVsbG8=\n"]);
  expect(handle.kill).toHaveBeenCalled();
});

it("carries a Task's connection through the real relay to the egress proxy, a megabyte each way", async () => {
  // The Attempt's egress proxy on this host's loopback: it answers CONNECT, then echoes.
  const requests: string[] = [];
  const proxy = createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(data.toString());
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.pipe(socket);
    });
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanups.push(async () => {
    proxy.close();
  });
  const relays = localRelays();
  const { session, factory } = await fixture(cleanups, undefined, undefined, relays);
  await session.allocate({
    owner,
    timeoutMs: 60_000,
    allowedActions: ["files:read", "files:write", "commands:execute"],
    egress: {
      proxy: `127.0.0.1:${(proxy.address() as { port: number }).port}`,
      variables: { HTTPS_PROXY: "http://attempt:secret@127.0.0.1:3128" },
      caPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    },
  });
  expect(factory.create.mock.calls[0]?.[0].allowInternetAccess).toBe(false);
  const port = relays.ports[0];
  if (port === undefined) throw new Error("The relay announced no port");
  const client: Socket = connect(port, "127.0.0.1");
  await once(client, "connect");
  const received: Buffer[] = [];
  client.on("data", (data: Buffer) => received.push(data));
  client.write("CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r\n");
  const established = "HTTP/1.1 200 Connection established\r\n\r\n";
  await vi.waitFor(() => expect(Buffer.concat(received).toString()).toBe(established));
  const payload = Buffer.alloc(1 << 20);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 31) % 251;
  client.write(payload);
  await vi.waitFor(
    () => expect(Buffer.concat(received).length).toBe(established.length + payload.length),
    { timeout: 30_000 },
  );
  expect(Buffer.concat(received).subarray(established.length).equals(payload)).toBe(true);
  expect(requests[0]).toMatch(/^CONNECT pypi\.org:443 HTTP\/1\.1\r\n/u);
  // The handle never held more than a chunk of the relay's output.
  expect(Math.max(...relays.retained.map((entry) => entry.stdout))).toBeLessThan(1024);
  client.destroy();
  // Stop ends the relay command, and its clients with it.
  await session.stop({ owner });
  await vi.waitFor(() =>
    expect(relays.children[0]?.exitCode ?? relays.children[0]?.signalCode).toBeTruthy(),
  );
}, 60_000);
