import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  createEgressRelayHost,
  EGRESS_RELAY_PROGRAM,
} from "./src/rust-workspace-provider/egress-relay.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Everything a socket has received so far, and a wait until it contains some text. */
function received(socket: Socket) {
  let text = "";
  let closed = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  socket.on("data", (chunk) => {
    text += chunk.toString();
    wake();
  });
  socket.on("close", () => {
    closed = true;
    wake();
  });
  return {
    async until(wanted: string): Promise<string> {
      while (!text.includes(wanted)) await new Promise<void>((resume) => waiters.push(resume));
      return text;
    },
    async closed(): Promise<void> {
      while (!closed) await new Promise<void>((resume) => waiters.push(resume));
    },
  };
}

/** The real relay program, on this machine's loopback, joined to a host that dials `proxy`. */
async function relay(proxyPort: number, limits: Parameters<typeof createEgressRelayHost>[2] = {}) {
  const child = spawn("python3", ["-I", "-S", "-c", EGRESS_RELAY_PROGRAM, "0"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  cleanups.push(() => child.kill("SIGKILL"));
  const host = createEgressRelayHost(
    {
      write: (line) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(line, (error) => (error ? reject(error) : resolve())),
        ),
    },
    { host: "127.0.0.1", port: proxyPort },
    limits,
  );
  child.stdout.setEncoding("utf8").on("data", (text: string) => host.receive(text));
  return { host, port: await host.started };
}

async function proxy(reply: string) {
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      seen.push(data.toString());
      socket.write(reply);
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => server.close());
  return { seen, port: (server.address() as { port: number }).port };
}

it("carries a Task client's connection to the egress proxy and back over the relay's stdio", async () => {
  const upstream = await proxy("HTTP/1.1 200 Connection established\r\n\r\n");
  const { port } = await relay(upstream.port);
  const client = connect(port, "127.0.0.1");
  const answer = received(client);
  client.write("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");
  expect(await answer.until("200")).toContain("200 Connection established");
  expect(upstream.seen).toEqual(["CONNECT pypi.org:443 HTTP/1.1\r\n\r\n"]);
  // Closing the client closes its proxy connection through the relay.
  client.destroy();
}, 30_000);

it("closes a client beyond the connection cap, and one idle past its limit", async () => {
  const upstream = await proxy("HTTP/1.1 200 Connection established\r\n\r\n");
  const { host, port } = await relay(upstream.port, { maxStreams: 1, idleMs: 500 });
  const first = connect(port, "127.0.0.1");
  const firstAnswer = received(first);
  first.write("CONNECT a.example:443 HTTP/1.1\r\n\r\n");
  await firstAnswer.until("200");
  const second = received(connect(port, "127.0.0.1"));
  await second.closed();
  expect(host.streams).toBe(1);
  // No bytes either way for longer than the idle limit: the relay connection closes.
  await firstAnswer.closed();
  expect(host.streams).toBe(0);
}, 30_000);

/** A peer whose writes complete only once released, as a sandbox that stopped reading. */
function stalledPeer() {
  const lines: string[] = [];
  const waiting: (() => void)[] = [];
  let flowing = false;
  let aborted = 0;
  return {
    lines,
    get aborted() {
      return aborted;
    },
    peer: {
      write(line: string) {
        lines.push(line);
        if (flowing) return Promise.resolve();
        return new Promise<void>((resolve) => waiting.push(resolve));
      },
      abort() {
        aborted += 1;
      },
    },
    release() {
      flowing = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/** An egress proxy that writes `bytes` to every connection as fast as it may. */
async function firehose(bytes: number) {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const chunk = Buffer.alloc(64 * 1024, 120);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!socket.write(chunk)) return void socket.once("drain", pump);
      }
      socket.end();
    };
    pump();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as { port: number }).port;
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

it("pauses the proxy while the sandbox stops reading, and holds no more than its marks", async () => {
  const port = await firehose(64 * 1024 * 1024);
  const sandbox = stalledPeer();
  const host = createEgressRelayHost(
    sandbox.peer,
    { host: "127.0.0.1", port },
    { window: 1 << 30, highWater: 512 * 1024, lowWater: 128 * 1024 },
  );
  host.receive("O 1\n");
  await settle(500);
  // The proxy pumps 64 MiB, but the helper holds about the high-water mark and one read.
  expect(host.queued).toBeGreaterThan(512 * 1024);
  expect(host.queued).toBeLessThan(512 * 1024 + 256 * 1024);
  expect(host.closed).toBe(false);
  const before = sandbox.lines.length;
  await settle(300);
  expect(sandbox.lines.length).toBe(before);
  // The sandbox reads again: the proxy resumes.
  sandbox.release();
  await settle(300);
  expect(sandbox.lines.length).toBeGreaterThan(before);
  host.close();
});

it("holds each connection to its credit window, so a stalled client stops only itself", async () => {
  const port = await firehose(8 * 1024 * 1024);
  const { host, port: relayPort } = await relay(port);
  const stalled = connect(relayPort, "127.0.0.1");
  stalled.pause();
  await settle(200);
  const reader = connect(relayPort, "127.0.0.1");
  let got = 0;
  reader.on("data", (chunk) => {
    got += chunk.length;
  });
  await once(reader, "close");
  // The reading client got all 8 MiB while the other read nothing and stays open.
  expect(got).toBe(8 * 1024 * 1024);
  expect(stalled.destroyed).toBe(false);
  // The stalled client's backlog is bounded by its window, here and in the relay.
  expect(host.queued).toBeLessThan(1024 * 1024);
  expect(host.streams).toBe(1);
  stalled.destroy();
});

it("closes a connection whose relay overruns its window toward the proxy", async () => {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.pause();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const sandbox = stalledPeer();
  sandbox.release();
  const host = createEgressRelayHost(
    sandbox.peer,
    { host: "127.0.0.1", port: (server.address() as { port: number }).port },
    { window: 64 * 1024 },
  );
  host.receive("O 1\n");
  await settle(200);
  // A relay that ignores its window: far more than twice it, with no credit returned.
  const chunk = Buffer.alloc(32 * 1024, 121).toString("base64");
  for (let index = 0; index < 64; index += 1) host.receive(`D 1 ${chunk}\n`);
  expect(host.streams).toBe(0);
  await settle(50);
  expect(sandbox.lines).toContain("C 1\n");
  expect(host.closed).toBe(false);
});

it("drops everything after its output overflows a line, and stops the relay", async () => {
  const port = await firehose(1024);
  const sandbox = stalledPeer();
  const host = createEgressRelayHost(sandbox.peer, { host: "127.0.0.1", port });
  host.receive("x".repeat(3 * 1024 * 1024));
  expect(host.closed).toBe(true);
  expect(sandbox.aborted).toBe(1);
  host.receive("\nO 1\n");
  await settle(100);
  expect(host.streams).toBe(0);
  expect(sandbox.lines).toEqual([]);
});

it("rate-limits opens, and drops them without a reply once backed up", async () => {
  const { port } = await proxy("");
  const sandbox = stalledPeer();
  sandbox.release();
  const host = createEgressRelayHost(
    sandbox.peer,
    { host: "127.0.0.1", port },
    { openBurst: 4, openRate: 0 },
  );
  for (let id = 1; id <= 10; id += 1) host.receive(`O ${id}\n`);
  expect(host.streams).toBe(4);
  await settle(50);
  expect(sandbox.lines.filter((line) => line.startsWith("C "))).toEqual([
    "C 5\n",
    "C 6\n",
    "C 7\n",
    "C 8\n",
    "C 9\n",
    "C 10\n",
  ]);
  host.close();

  const stalled = stalledPeer();
  const busy = createEgressRelayHost(
    stalled.peer,
    { host: "127.0.0.1", port: await firehose(16 * 1024 * 1024) },
    { window: 1 << 30, highWater: 256 * 1024, lowWater: 64 * 1024 },
  );
  busy.receive("O 1\n");
  await settle(400);
  const backlog = stalled.lines.length;
  for (let id = 2; id <= 50; id += 1) busy.receive(`O ${id}\n`);
  expect(busy.streams).toBe(1);
  expect(stalled.lines.length).toBe(backlog);
  busy.close();
});

it("closes the relay when the Attempt's egress proxy is gone", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, "close");
  const sandbox = stalledPeer();
  sandbox.release();
  const host = createEgressRelayHost(sandbox.peer, { host: "127.0.0.1", port });
  host.receive("O 1\n");
  await settle(300);
  expect(host.closed).toBe(true);
  expect(sandbox.aborted).toBe(1);
});

it("counts a closed client still finishing toward the cap, and destroys it on close", async () => {
  // A proxy that never reads, so a finished socket lingers with its last bytes.
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.pause();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const sandbox = stalledPeer();
  sandbox.release();
  const host = createEgressRelayHost(
    sandbox.peer,
    { host: "127.0.0.1", port: (server.address() as { port: number }).port },
    { maxStreams: 2 },
  );
  host.receive("O 1\nO 2\n");
  await settle(200);
  host.receive("C 1\n");
  expect(host.streams).toBe(1);
  // Stream 1 still finishes, so a third open is refused.
  host.receive("O 3\n");
  await settle(50);
  expect(host.streams).toBe(1);
  expect(sandbox.lines).toContain("C 3\n");
  host.close();
});
