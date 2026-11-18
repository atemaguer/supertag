/**
 * The egress relay over the provider's exec stream (design: contributing/
 * local-vm-environment-design.md, step 1d).
 *
 * A cloud sandbox keeps the provider's no-network policy, DNS included. The provider starts the
 * relay program in it as one long-lived exec process; the program accepts the Task's clients on
 * a loopback port and carries each connection as lines on its standard output and input. The
 * provider helper, on the Worker Host, connects each one to the Attempt's egress proxy, which
 * applies the scope, logs, and swaps credential placeholders. The relay never sees a secret, and
 * nothing but the provider's own exec channel leaves the sandbox.
 *
 * Lines, both ways, base64 for bytes so every provider's text stream carries them:
 * - `O <id>`: the relay accepted client `id` (relay to helper).
 * - `D <id> <base64>`: bytes for `id`.
 * - `A <id> <n>`: the receiver delivered `n` more of `id`'s bytes, so the sender may send them
 *   again. Each direction of each connection has a credit window of `WINDOW` bytes: a stalled
 *   client or proxy stops only its own connection, and neither side buffers without bound.
 * - `C <id>`: `id` is closed.
 */
import { connect, type Socket } from "node:net";

export const EGRESS_RELAY_PROGRAM = String.raw`import asyncio, base64, sys
port = int(sys.argv[1])
WINDOW = 256 * 1024
MAX_CLIENTS = 64
clients = {}
counter = 0
out = sys.stdout

def send(line):
    out.write(line + "\n")
    out.flush()

class Client:
    def __init__(self, writer):
        self.writer = writer
        self.queue = asyncio.Queue()
        self.queued = 0
        self.unacked = 0
        self.credit = asyncio.Event()
        self.credit.set()

def drop(ident, notify):
    state = clients.pop(ident, None)
    if state is None:
        return
    state.credit.set()
    state.queue.put_nowait(None)
    state.writer.close()
    if notify:
        send("C %d" % ident)

async def deliver(ident, state):
    # Writes the helper's bytes to the client, then returns their credit; it never holds stdin.
    # The helper's close waits behind the bytes it sent before it.
    while (data := await state.queue.get()) is not None:
        state.queued -= len(data)
        try:
            state.writer.write(data)
            await state.writer.drain()
        except ConnectionError:
            drop(ident, True)
            return
        if ident in clients:
            send("A %d %d" % (ident, len(data)))
    if clients.get(ident) is state:
        drop(ident, False)

async def client(reader, writer):
    global counter
    if len(clients) >= MAX_CLIENTS:
        writer.close()
        return
    counter += 1
    ident = counter
    state = Client(writer)
    clients[ident] = state
    send("O %d" % ident)
    delivering = asyncio.create_task(deliver(ident, state))
    try:
        while ident in clients:
            await state.credit.wait()
            if ident not in clients:
                break
            data = await reader.read(48 * 1024)
            if not data:
                break
            state.unacked += len(data)
            if state.unacked >= WINDOW:
                state.credit.clear()
            send("D %d %s" % (ident, base64.b64encode(data).decode()))
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        drop(ident, True)
        await delivering

async def host():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while line := await reader.readline():
        parts = line.decode().split()
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        ident = int(parts[1])
        state = clients.get(ident)
        if state is None:
            continue
        if parts[0] == "D" and len(parts) == 3:
            data = base64.b64decode(parts[2])
            state.queued += len(data)
            # The helper keeps to its window; past twice that, the connection is broken.
            if state.queued > 2 * WINDOW:
                drop(ident, True)
            else:
                state.queue.put_nowait(data)
        elif parts[0] == "A" and len(parts) == 3 and parts[2].isdigit():
            state.unacked = max(0, state.unacked - int(parts[2]))
            if state.unacked < WINDOW:
                state.credit.set()
        elif parts[0] == "C":
            state.queue.put_nowait(None)
    # The helper went away: no client may outlive the relay's only way out.
    for ident in list(clients):
        drop(ident, False)

async def main():
    server = await asyncio.start_server(client, "127.0.0.1", port)
    send("relay ready %d" % server.sockets[0].getsockname()[1])
    async with server:
        await host()

asyncio.run(main())`;

/** Connections the relay may carry at once; a client beyond them is closed. */
const MAX_STREAMS = 64;
/** A connection with no bytes either way for this long is closed. */
const IDLE_MS = 300_000;
const MAX_LINE = 1 << 20;
/** How long a closed client's last bytes may take to reach the proxy. */
const FINISH_MS = 5_000;
/** Bytes either side may send on one connection before the other returns credit. */
export const EGRESS_RELAY_WINDOW = 256 * 1024;
/** Over this many bytes waiting for the sandbox's standard input, every proxy socket pauses. */
const HIGH_WATER = 4 * 1024 * 1024;
/** They resume under this many. */
const LOW_WATER = 1024 * 1024;
/** Past this many waiting bytes the sandbox has stopped reading, and the relay is closed. */
const HARD_LIMIT = 16 * 1024 * 1024;
/** New connections the relay may open: a burst of this many, refilled at `OPEN_RATE` a second. */
const OPEN_BURST = 64;
const OPEN_RATE = 16;
/**
 * Opens past the rate or the connection cap wait their turn, up to this many; one beyond is
 * refused. A package manager opens dozens at once and retries a refused one only after a long
 * backoff, so waiting serves it far better than refusing.
 */
const MAX_WAITING_OPENS = 256;

export interface EgressRelayPeer {
  /** Writes one line, newline included, to the relay's standard input. */
  write(line: string): Promise<void>;
  /** Stops the relay process and its output stream, after the host closed. */
  abort?(): void;
}

export interface EgressRelayLimits {
  readonly maxStreams?: number;
  readonly idleMs?: number;
  readonly window?: number;
  readonly highWater?: number;
  readonly lowWater?: number;
  readonly hardLimit?: number;
  readonly openBurst?: number;
  readonly openRate?: number;
  readonly maxWaitingOpens?: number;
}

interface Stream {
  readonly socket: Socket;
  idle: ReturnType<typeof setTimeout>;
  /** Bytes sent to the sandbox that it has not returned credit for. */
  unacked: number;
  /** Bytes the sandbox sent toward the proxy that this host has not yet returned credit for. */
  inflight: number;
}

/**
 * The helper's half: feed it the relay's standard output with `receive`, and it connects each
 * client to the egress proxy at `proxy` and writes the proxy's bytes back through `peer`. The
 * relay runs in the sandbox, so nothing it sends is trusted: a connection that overruns its
 * window is closed, opens are rate-limited, and the whole relay closes when its output overflows,
 * the sandbox stops reading, or the egress proxy is gone.
 */
export function createEgressRelayHost(
  peer: EgressRelayPeer,
  proxy: { readonly host: string; readonly port: number },
  limits: EgressRelayLimits = {},
) {
  const maxStreams = limits.maxStreams ?? MAX_STREAMS;
  const idleMs = limits.idleMs ?? IDLE_MS;
  const window = limits.window ?? EGRESS_RELAY_WINDOW;
  const highWater = limits.highWater ?? HIGH_WATER;
  const lowWater = limits.lowWater ?? LOW_WATER;
  const hardLimit = limits.hardLimit ?? HARD_LIMIT;
  const openBurst = limits.openBurst ?? OPEN_BURST;
  const openRate = limits.openRate ?? OPEN_RATE;
  const maxWaitingOpens = limits.maxWaitingOpens ?? MAX_WAITING_OPENS;
  /** Opens waiting for a token or a free connection, with the bytes their clients sent. */
  const waiting = new Map<number, { chunks: Buffer[]; bytes: number }>();
  let pumping: ReturnType<typeof setTimeout> | undefined;
  const streams = new Map<number, Stream>();
  /** Sockets whose client closed, still sending the proxy their last bytes. */
  const finishing = new Set<Socket>();
  let pending = "";
  let closed = false;
  /** Bytes of lines waiting for, or being written to, the relay's standard input. */
  let queued = 0;
  let backedUp = false;
  let tokens = openBurst;
  let refilled = Date.now();
  let ready: ((port: number) => void) | undefined;
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  // Lines go out one at a time, in order.
  let tail = Promise.resolve();
  function flowing(stream: Stream): boolean {
    return !backedUp && stream.unacked < window;
  }
  function settle() {
    if (!backedUp && queued > highWater) {
      backedUp = true;
      for (const stream of streams.values()) stream.socket.pause();
    } else if (backedUp && queued < lowWater) {
      backedUp = false;
      for (const stream of streams.values()) if (flowing(stream)) stream.socket.resume();
    }
  }
  const send = (line: string) => {
    if (closed) return;
    const bytes = line.length + 1;
    queued += bytes;
    if (queued > hardLimit) {
      close();
      return;
    }
    settle();
    tail = tail
      .then(() => peer.write(`${line}\n`))
      .then(
        () => {
          queued -= bytes;
          settle();
        },
        () => close(),
      );
  };
  function end(id: number, notify: boolean) {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    clearTimeout(stream.idle);
    stream.socket.destroy();
    if (notify) send(`C ${id}`);
    queueMicrotask(pump);
  }
  /**
   * The client closed: the proxy still gets the bytes it sent before, then the end, for at most
   * `FINISH_MS`. Until then the socket still counts toward the connection cap.
   */
  function finish(id: number) {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    clearTimeout(stream.idle);
    const { socket } = stream;
    finishing.add(socket);
    socket.once("close", () => {
      finishing.delete(socket);
      pump();
    });
    socket.end();
    setTimeout(() => {
      finishing.delete(socket);
      socket.destroy();
    }, FINISH_MS).unref();
  }

  function touch(id: number) {
    const stream = streams.get(id);
    if (!stream) return;
    clearTimeout(stream.idle);
    stream.idle = setTimeout(() => end(id, true), idleMs);
  }
  function admit(): boolean {
    const now = Date.now();
    tokens = Math.min(openBurst, tokens + ((now - refilled) / 1000) * openRate);
    refilled = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }
  function open(id: number) {
    if (streams.has(id) || waiting.has(id)) return;
    // Backed up, an open is dropped without a reply: replying would only add to the backlog.
    if (backedUp) return;
    if (waiting.size >= maxWaitingOpens) {
      send(`C ${id}`);
      return;
    }
    waiting.set(id, { chunks: [], bytes: 0 });
    pump();
  }
  /** Connects waiting opens, in order, while tokens and connections allow; then waits again. */
  function pump() {
    if (closed) return;
    while (waiting.size > 0 && streams.size + finishing.size < maxStreams && admit()) {
      const [id, early] = waiting.entries().next().value as [
        number,
        { chunks: Buffer[]; bytes: number },
      ];
      waiting.delete(id);
      connectStream(id);
      for (const chunk of early.chunks) write(id, chunk);
    }
    if (waiting.size > 0 && pumping === undefined && streams.size + finishing.size < maxStreams)
      pumping = setTimeout(
        () => {
          pumping = undefined;
          pump();
        },
        Math.max(10, Math.ceil(1000 / Math.max(openRate, 0.001))),
      );
  }
  function connectStream(id: number) {
    const socket = connect(proxy.port, proxy.host);
    socket.setNoDelay(true);
    const stream: Stream = {
      socket,
      idle: setTimeout(() => end(id, true), idleMs),
      unacked: 0,
      inflight: 0,
    };
    streams.set(id, stream);
    socket.on("data", (data: Buffer) => {
      touch(id);
      stream.unacked += data.length;
      send(`D ${id} ${data.toString("base64")}`);
      if (!flowing(stream)) socket.pause();
    });
    socket.on("close", () => end(id, true));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // The Attempt's egress proxy is gone: nothing the relay carries can reach it any more.
      if (error.code === "ECONNREFUSED") close();
      else end(id, true);
    });
  }
  function credit(id: number, bytes: number) {
    const stream = streams.get(id);
    if (!stream) return;
    stream.unacked = Math.max(0, stream.unacked - bytes);
    if (flowing(stream)) stream.socket.resume();
  }
  function deliver(id: number, data: string) {
    const bytes = Buffer.from(data, "base64");
    // A waiting open keeps what its client sent, within its window, until it connects.
    const early = waiting.get(id);
    if (early) {
      if (early.bytes + bytes.length > 2 * window) {
        waiting.delete(id);
        send(`C ${id}`);
        return;
      }
      early.chunks.push(bytes);
      early.bytes += bytes.length;
      return;
    }
    write(id, bytes);
  }
  function write(id: number, bytes: Buffer) {
    const stream = streams.get(id);
    if (!stream) return;
    touch(id);
    // The relay keeps to its window, overshooting by at most one read; past twice the window,
    // the connection is broken. The count is the relay's bytes this host has not yet credited,
    // not the socket's buffer, which a large kernel buffer (as on Linux loopback) keeps empty.
    if (stream.inflight + bytes.length > 2 * window) {
      end(id, true);
      return;
    }
    stream.inflight += bytes.length;
    stream.socket.write(bytes, (error) => {
      stream.inflight -= bytes.length;
      if (!error && streams.get(id) === stream) send(`A ${id} ${bytes.length}`);
    });
  }
  function line(text: string) {
    const announced = /^relay ready ([0-9]+)$/u.exec(text);
    if (announced) {
      ready?.(Number(announced[1]));
      return;
    }
    const [kind, raw, data] = text.split(" ");
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) return;
    if (kind === "O") open(id);
    else if (kind === "C") {
      if (!waiting.delete(id)) finish(id);
    } else if (kind === "D" && data !== undefined) deliver(id, data);
    else if (kind === "A" && data !== undefined && /^[0-9]{1,9}$/u.test(data))
      credit(id, Number(data));
  }
  function close() {
    if (closed) return;
    closed = true;
    pending = "";
    for (const id of [...streams.keys()]) end(id, false);
    for (const socket of finishing) socket.destroy();
    finishing.clear();
    waiting.clear();
    clearTimeout(pumping);
    peer.abort?.();
  }
  return {
    /** Resolves with the relay's client port once it is listening. */
    started,
    /** One chunk of the relay's standard output; ignored once the relay closed. */
    receive(chunk: string) {
      if (closed) return;
      pending += chunk;
      if (pending.length > MAX_LINE * 2) {
        close();
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !closed) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    close,
    /** Whether the relay closed. */
    get closed() {
      return closed;
    },
    /** Open connections, for tests. */
    get streams() {
      return streams.size;
    },
    /** Bytes waiting for the sandbox's standard input, for tests. */
    get queued() {
      return queued;
    },
  };
}

export type EgressRelayHost = ReturnType<typeof createEgressRelayHost>;
