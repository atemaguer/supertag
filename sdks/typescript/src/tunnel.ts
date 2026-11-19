import { createHash, randomBytes } from "node:crypto";
import { isIP, type Socket, connect as tcpConnect } from "node:net";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

// A `wss://` or `ws://` Gateway URL carries the same gRPC connection inside a WebSocket, for
// platforms whose proxy forwards only HTTP/1.1. The tunnel is a byte pipe: SuperTag's own TLS,
// with any client certificate, runs end to end inside it, so a proxy that terminates the outer
// `wss://` TLS sees only ciphertext. This matches the Rust transport (core/crates/transport) and
// the terminal UI's tunnel (apps/tui/client/tunnel.go).

/** The largest WebSocket message either side sends or accepts. */
export const TUNNEL_MAX_MESSAGE = 256 * 1024;
/** How often the client pings the Gateway; a peer silent for three intervals is gone. */
export const TUNNEL_PING_MS = 20_000;
/** The largest upgrade response head read before the tunnel is refused. */
const MAX_RESPONSE_HEAD = 16 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** The native gRPC origin a tunnel URL carries, without the WebSocket path. */
export function tunnelOrigin(url: URL): string {
  const scheme = url.protocol === "wss:" ? "https" : "http";
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  return `${scheme}://${url.hostname}:${port}`;
}

function failure(message: string, code = "ECONNRESET"): Error {
  return Object.assign(new Error(message), { code });
}

function headerHasToken(value: string | undefined, token: string): boolean {
  return (value ?? "").split(",").some((part) => part.trim().toLowerCase() === token);
}

/** Outer TLS for a `wss://` tunnel: the platform's edge certificate. */
export interface OuterTls {
  readonly ca: ReadonlyArray<string | Buffer> | undefined;
}

/**
 * One WebSocket tunnel as a byte stream: binary messages in both directions, masked frames out,
 * at most {@link TUNNEL_MAX_MESSAGE} bytes each. It pings on an interval, which keeps proxies from
 * closing an idle tunnel, and fails when the peer has sent nothing, not even a pong, for three
 * intervals. Writes made before the upgrade completes wait for it.
 */
export class TunnelSocket extends Duplex {
  readonly #url: URL;
  readonly #ping: number;
  #socket: Socket | undefined;
  #ready: Promise<void>;
  #open = false;
  #pending: Buffer = Buffer.alloc(0);
  #fragmented = false;
  #message = 0;
  #last = Date.now();
  #timer: NodeJS.Timeout | undefined;
  #closing = false;

  constructor(url: URL, outer: OuterTls | undefined, ping = TUNNEL_PING_MS) {
    super({ allowHalfOpen: false });
    this.#url = url;
    this.#ping = ping;
    this.#ready = this.#dial(outer).catch((error: unknown) => {
      // A tunnel that never opened is unreachable, as a refused TCP connection is: connect-node
      // reads the code (along the cause chain, so none is attached) and reports Unavailable.
      const cause = error instanceof Error ? error : failure(String(error));
      const code = (cause as { code?: unknown }).code;
      if (["ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(String(code))) {
        throw cause;
      }
      throw failure(
        cause.message.startsWith("the WebSocket tunnel")
          ? cause.message
          : `the WebSocket tunnel could not open: ${cause.message}`,
        "ECONNREFUSED",
      );
    });
    this.#ready.then(
      () => this.emit("tunnel"),
      (error: Error) => this.destroy(error),
    );
  }

  async #dial(outer: OuterTls | undefined): Promise<void> {
    const url = this.#url;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
    const socket =
      outer === undefined
        ? tcpConnect({ host, port })
        : tlsConnect({
            host,
            port,
            servername: isIP(host) === 0 ? host : undefined,
            ALPNProtocols: ["http/1.1"],
            ca: outer.ca as (string | Buffer)[] | undefined,
            minVersion: "TLSv1.2",
            rejectUnauthorized: true,
          });
    this.#socket = socket;
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        socket.off("error", reject);
        socket.off("close", closed);
        resolve();
      };
      const closed = () => reject(failure("the WebSocket tunnel connection closed"));
      socket.once(outer === undefined ? "connect" : "secureConnect", ready);
      socket.once("error", reject);
      socket.once("close", closed);
    });
    const key = randomBytes(16).toString("base64");
    // No Origin header: SuperTag listeners refuse upgrades that carry one, so a web page cannot
    // open a tunnel.
    socket.write(
      `GET ${url.pathname || "/"} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const { head, rest } = await new Promise<{ head: string; rest: Buffer }>((resolve, reject) => {
      let read = Buffer.alloc(0);
      const done = (error?: Error) => {
        socket.off("data", data);
        socket.off("error", done);
        socket.off("close", closed);
        if (error) reject(error);
      };
      const closed = () =>
        done(failure("the WebSocket tunnel upgrade failed: the connection closed"));
      const data = (chunk: Buffer) => {
        read = Buffer.concat([read, chunk]);
        const end = read.indexOf("\r\n\r\n");
        if (end >= 0) {
          done();
          resolve({ head: read.subarray(0, end).toString("latin1"), rest: read.subarray(end + 4) });
        } else if (read.length > MAX_RESPONSE_HEAD) {
          done(failure("the WebSocket tunnel upgrade failed: the response head is too large"));
        }
      };
      socket.on("data", data);
      socket.once("error", done);
      socket.once("close", closed);
    });
    const [status = "", ...lines] = head.split("\r\n");
    const headers = new Map<string, string>();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    if (
      !/^HTTP\/1\.1 101(?: |$)/u.test(status) ||
      headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !headerHasToken(headers.get("connection"), "upgrade") ||
      headers.get("sec-websocket-accept") !== accept
    ) {
      throw failure(
        `the WebSocket tunnel upgrade was refused: ${status.replace(/^HTTP\/1\.1 /u, "").replace(/[^\x20-\x7e]/gu, "")}`,
      );
    }
    this.#open = true;
    this.#last = Date.now();
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.destroy(error));
    socket.on("close", () => {
      if (!this.destroyed) this.destroy(failure("the WebSocket tunnel connection closed"));
    });
    this.#timer = setInterval(() => this.#keepalive(), this.#ping);
    this.#timer.unref();
    if (rest.length > 0) this.#receive(rest);
  }

  #keepalive() {
    const socket = this.#socket;
    if (socket === undefined || this.destroyed) return;
    // A paused read side is this end's backpressure, not the peer's silence.
    if (!socket.isPaused() && Date.now() - this.#last >= 3 * this.#ping) {
      this.destroy(failure("the WebSocket tunnel peer stopped answering", "ETIMEDOUT"));
      return;
    }
    this.#send(OP_PING, Buffer.alloc(0));
  }

  /** Reads every complete frame in the received bytes. */
  #receive(chunk: Buffer) {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    try {
      while (!this.destroyed) {
        const frame = this.#frame();
        if (frame === undefined) return;
        this.#handle(frame.fin, frame.opcode, frame.payload);
      }
    } catch (error) {
      this.destroy(error as Error);
    }
  }

  #frame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const buffer = this.#pending;
    if (buffer.length < 2) return undefined;
    const first = buffer[0] as number;
    const second = buffer[1] as number;
    if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
      throw failure("the WebSocket tunnel peer sent an invalid frame");
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return undefined;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return undefined;
      const extended = buffer.readBigUInt64BE(2);
      if (extended > BigInt(TUNNEL_MAX_MESSAGE)) {
        throw failure("the WebSocket tunnel message is too large");
      }
      length = Number(extended);
      offset = 10;
    }
    if (length > TUNNEL_MAX_MESSAGE) throw failure("the WebSocket tunnel message is too large");
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if (opcode >= OP_CLOSE && (!fin || length > 125)) {
      throw failure("the WebSocket tunnel peer sent an invalid control frame");
    }
    if (buffer.length < offset + length) return undefined;
    const payload = buffer.subarray(offset, offset + length);
    this.#pending = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handle(fin: boolean, opcode: number, payload: Buffer) {
    this.#last = Date.now();
    switch (opcode) {
      case OP_BINARY:
      case OP_CONTINUATION: {
        if ((opcode === OP_BINARY) === this.#fragmented) {
          throw failure("the WebSocket tunnel peer sent an invalid fragment");
        }
        if (opcode === OP_BINARY) this.#message = 0;
        this.#message += payload.length;
        if (this.#message > TUNNEL_MAX_MESSAGE) {
          throw failure("the WebSocket tunnel message is too large");
        }
        this.#fragmented = !fin;
        // Copy: the payload is a view of the receive buffer, which later chunks replace.
        if (payload.length > 0 && !this.push(Buffer.from(payload))) this.#socket?.pause();
        return;
      }
      case OP_PING:
        this.#send(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.#closing = true;
        this.#send(OP_CLOSE, payload.subarray(0, Math.min(payload.length, 2)));
        this.push(null);
        this.#socket?.end();
        return;
      case OP_TEXT:
        throw failure("the WebSocket tunnel carries only binary messages");
      default:
        throw failure("the WebSocket tunnel peer sent an unknown frame");
    }
  }

  /** Writes one final, masked frame. */
  #send(opcode: number, payload: Buffer, callback?: (error?: Error | null) => void) {
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed || !socket.writable) {
      callback?.(failure("the WebSocket tunnel is closed"));
      return;
    }
    const length = payload.length;
    const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
    const frame = Buffer.allocUnsafe(2 + extended + 4 + length);
    frame[0] = 0x80 | opcode;
    if (extended === 0) frame[1] = 0x80 | length;
    else if (extended === 2) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }
    const start = 2 + extended + 4;
    const mask = randomBytes(4);
    mask.copy(frame, 2 + extended);
    for (let i = 0; i < length; i++) {
      frame[start + i] = (payload[i] as number) ^ (mask[i & 3] as number);
    }
    socket.write(frame, callback);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const write = () => {
      for (let offset = 0; offset < chunk.length; offset += TUNNEL_MAX_MESSAGE) {
        const end = Math.min(chunk.length, offset + TUNNEL_MAX_MESSAGE);
        this.#send(
          OP_BINARY,
          chunk.subarray(offset, end),
          end === chunk.length ? callback : undefined,
        );
      }
      if (chunk.length === 0) callback();
    };
    if (this.#open) write();
    else this.#ready.then(write, (error: unknown) => callback(error as Error));
  }

  override _read() {
    this.#socket?.resume();
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.#open && !this.#closing) {
      this.#closing = true;
      this.#send(OP_CLOSE, Buffer.from([0x03, 0xe8]));
    }
    this.#socket?.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearInterval(this.#timer);
    const socket = this.#socket;
    if (socket !== undefined && !socket.destroyed) {
      if (this.#open && !this.#closing) {
        this.#closing = true;
        this.#send(OP_CLOSE, Buffer.from([0x03, 0xe8]));
      }
      socket.destroy();
    }
    callback(error);
  }

  /** Lets the process exit while only this tunnel is open, as a TCP socket would. */
  unref(): this {
    this.#socket?.unref();
    return this;
  }

  ref(): this {
    this.#socket?.ref();
    return this;
  }
}
