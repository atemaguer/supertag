import type { ClientHttp2Stream, ClientSessionOptions, Http2Session } from "node:http2";
import { isIP, type Socket, connect as tcpConnect } from "node:net";
import * as tls from "node:tls";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  ArtifactCatalog,
  ArtifactPublications,
  ArtifactVolumes,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/artifact_pb.js";
import { Memories } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/memories_pb.js";
import {
  ProtocolNegotiation,
  ServiceRole,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/negotiation_pb.js";
import { Enrollments } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/placement_pb.js";
import {
  PolicyCatalog,
  SurfacePolicyCatalog,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/policy_pb.js";
import {
  Conversations,
  Inbox,
  LiveInputs,
  Mailbox,
  ManifestRelationships,
  NetworkLogs,
  Objectives,
  Operator,
  OperatorEvents,
  TaskFiles,
  Teams,
  WorkSessions,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb.js";
import { Schedules } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/schedules_pb.js";
import { WorkspaceLandings } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/workspace_landings_pb.js";
import {
  WorkspaceCredentials,
  Workspaces,
} from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/workspaces_pb.js";
import { TUNNEL_FAILURE, TunnelSocket, tunnelOrigin } from "./tunnel.js";

export { Code, ConnectError } from "@connectrpc/connect";
export { PrincipalRole } from "../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb.js";

export interface GatewayClientOptions {
  /**
   * An `https://` origin, a loopback `http://` origin, or a `wss://` or loopback `ws://` tunnel
   * URL, which may have a path. A tunnel carries the same gRPC connection inside a WebSocket,
   * with the Gateway's own TLS running end to end inside a `wss://` tunnel.
   */
  readonly url: string;
  /** An operator token, Operator Token, enrolled credential, or Auth Key: ASCII, no spaces. */
  readonly token: string;
  /**
   * PEM certificate authority for a Gateway with a private TLS certificate. It replaces the
   * trusted roots for the Gateway's own TLS; a `wss://` tunnel's outer TLS trusts it beside them.
   */
  readonly ca?: string | Buffer;
  /** PEM client identity for a Gateway that requires mutual TLS. */
  readonly identity?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** The release this client names while negotiating, up to 64 ASCII characters. */
  readonly buildVersion?: string;
  /**
   * How long opening a connection may take: TCP, TLS and, for a tunnel, the WebSocket upgrade.
   * Defaults to 5 seconds, or 30 for a tunnel, whose platform proxy may hold the upgrade while
   * it starts a Gateway that scaled to zero.
   */
  readonly connectTimeoutMs?: number;
}

/** Names, on every call, the protocol version this client negotiated with the Gateway. */
const PROTOCOL_HEADER = "x-supertag-protocol";
/** The SuperTag protocol versions this client speaks. */
const PROTOCOL_VERSIONS = [6];
const protocolVersions: readonly number[] = Object.freeze(PROTOCOL_VERSIONS);

export { protocolVersions as PROTOCOL_VERSIONS };

/** HTTP/2 keepalive, as the Rust transport's KEEPALIVE_INTERVAL and KEEPALIVE_TIMEOUT. */
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_BUILD_VERSION = 64;
const MAX_OFFERED_VERSIONS = 32;

interface Endpoint {
  /** The URL as given, without a trailing slash: it names the Gateway in errors. */
  readonly name: string;
  /** The native gRPC origin calls go to. */
  readonly origin: URL;
  /** The tunnel URL, when connections go through a WebSocket. */
  readonly tunnel: URL | undefined;
  readonly tls: boolean;
}

function loopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
}

function gatewayEndpoint(value: string): Endpoint {
  if (/[\s\\#?]/u.test(value)) throw new Error(invalidUrl);
  const tunnel = /^wss?:\/\//u.test(value);
  if (
    tunnel ? !/^wss?:\/\/[^/@]+(?:\/.*)?$/u.test(value) : !/^https?:\/\/[^/@]+\/?$/u.test(value)
  ) {
    throw new Error(invalidUrl);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(invalidUrl);
  }
  if (url.hostname === "" || url.port === "0") throw new Error("Gateway URL must use a valid port");
  const cleartext = url.protocol === "http:" || url.protocol === "ws:";
  if (cleartext && !loopback(url)) {
    throw new Error("Cleartext Gateway URL must use a loopback IP address");
  }
  return {
    name: value.replace(/\/+$/u, ""),
    origin: tunnel ? new URL(tunnelOrigin(url)) : url,
    tunnel: tunnel ? url : undefined,
    tls: !cleartext,
  };
}

const invalidUrl =
  "Gateway URL must be an HTTP or HTTPS origin, or a WS or WSS tunnel URL, without credentials, query, or fragment";

/**
 * The roots the OS trusts beside Node's bundled ones, read once per process: reading them can
 * block for a while (the macOS keychain). Node releases without `tls.getCACertificates` keep
 * their bundled roots.
 */
let roots: readonly string[] | undefined;
function trustedRoots(): readonly string[] {
  if (roots === undefined) {
    const read = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
    roots =
      typeof read === "function"
        ? [...new Set([...read("default"), ...read("system")])]
        : tls.rootCertificates;
  }
  return roots;
}

/** Opens each HTTP/2 connection within the connect timeout, natively or through a tunnel. */
function connector(
  endpoint: Endpoint,
  options: GatewayClientOptions,
  timeoutMs: number,
): NonNullable<ClientSessionOptions["createConnection"]> {
  const host = endpoint.origin.hostname.replace(/^\[|\]$/gu, "");
  const inner: tls.ConnectionOptions = {
    host,
    servername: isIP(host) === 0 ? host : undefined,
    ALPNProtocols: ["h2"],
    ca: options.ca ?? [...trustedRoots()],
    cert: options.identity?.cert,
    key: options.identity?.key,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  };
  return () => {
    let socket: Socket | TunnelSocket;
    let ready: string;
    if (endpoint.tunnel !== undefined) {
      const outer =
        endpoint.tunnel.protocol === "wss:"
          ? { ca: [...trustedRoots(), ...(options.ca === undefined ? [] : [options.ca])] }
          : undefined;
      const tunnel = new TunnelSocket(endpoint.tunnel, outer);
      if (endpoint.tls) {
        socket = tls.connect({ ...inner, socket: tunnel });
        ready = "secureConnect";
      } else {
        socket = tunnel;
        ready = "tunnel";
      }
    } else if (endpoint.tls) {
      socket = tls.connect({ ...inner, port: Number(endpoint.origin.port || 443) });
      ready = "secureConnect";
    } else {
      socket = tcpConnect({ host, port: Number(endpoint.origin.port || 80) });
      ready = "connect";
    }
    const timer = setTimeout(() => {
      socket.destroy(
        Object.assign(new Error(`Could not connect to the Gateway within ${timeoutMs} ms`), {
          code: "ETIMEDOUT",
        }),
      );
    }, timeoutMs);
    timer.unref();
    socket.once(ready, () => clearTimeout(timer));
    socket.once("close", () => clearTimeout(timer));
    return socket;
  };
}

/**
 * Starts reading a response stream as soon as it exists. Node.js 24 fails an async iterator
 * created on an HTTP/2 stream that has already closed with ERR_STREAM_PREMATURE_CLOSE, even when
 * the stream ended cleanly, and connect-node creates its iterator only once a promise for the
 * response headers settles. Over a native socket Node runs microtasks between the HTTP/2 frames
 * of one read, so the iterator exists before the trailers close the stream. A tunnel's bytes reach
 * HTTP/2 from JavaScript instead (Node's JSStreamSocket), which handles every frame of a WebSocket
 * message before any microtask runs, so a small reply closes its stream first. The iterator made
 * here holds at most the one message it has read until connect-node asks for it.
 */
function readFromTheStart(stream: ClientHttp2Stream) {
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  // The caller sees a failure when it reads; an unread one must not be unhandled.
  first.catch(() => {});
  stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<unknown, undefined> {
    try {
      for (let read = await first; !read.done; read = await iterator.next()) yield read.value;
      return undefined;
    } finally {
      await iterator.return?.();
    }
  };
}

/**
 * The session manager every call goes through. Besides reading each response from the start, it
 * keeps an error listener on every session that carried a call: connect-node stops listening for
 * a session's errors once it leaves the session, as `close()` after a failed call does, and Node
 * emits a failed session's error as it closes, after the calls on it already reported it.
 */
class SessionManager extends Http2SessionManager {
  readonly #watched = new WeakSet<Http2Session>();

  override async request(...args: Parameters<Http2SessionManager["request"]>) {
    const stream = await super.request(...args);
    readFromTheStart(stream);
    const session = stream.session;
    if (session !== undefined && !this.#watched.has(session)) {
      this.#watched.add(session);
      session.on("error", () => {});
    }
    return stream;
  }
}

/** Whether `error` or any error it was caused by is a tunnel failure. */
function tunnelFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 8; depth++) {
    if ((cause as { code?: unknown }).code === TUNNEL_FAILURE) return true;
    cause = cause.cause;
  }
  return false;
}

/** A call that failed because its tunnel failed is Unavailable, as over a broken connection. */
function unavailable(error: unknown): unknown {
  if (!tunnelFailure(error)) return error;
  const status = ConnectError.from(error);
  return new ConnectError(status.rawMessage, Code.Unavailable, status.metadata, undefined, error);
}

const tunnelFailures: Interceptor = (next) => async (request) => {
  let response: Awaited<ReturnType<typeof next>>;
  try {
    response = await next(request);
  } catch (error) {
    throw unavailable(error);
  }
  if (!response.stream) return response;
  const messages = response.message;
  return {
    ...response,
    message: (async function* () {
      try {
        yield* messages;
      } catch (error) {
        throw unavailable(error);
      }
    })(),
  };
};

/** Up to 64 visible ASCII characters of a peer's release, as the Rust client keeps them. */
function printable(build: string): string {
  const kept = [...build].filter((c) => c > " " && c < "\x7f").slice(0, MAX_BUILD_VERSION);
  return kept.length === 0 ? "unknown" : kept.join("");
}

/** "protocol 3", or "protocols 2, 3". */
function spoken(versions: readonly number[]): string {
  return versions.length === 1 ? `protocol ${versions[0]}` : `protocols ${versions.join(", ")}`;
}

/** The release and versions in a negotiation refusal, if it names them. */
function parseRefusal(message: string): { build: string; versions: number[] } | undefined {
  const match = /\(SuperTag ([^)]*)\) speaks protocol versions \[([^\]]*)\]/u.exec(message);
  if (!match) return undefined;
  const versions = (match[2] as string).split(",").map((item) => item.trim());
  if (versions.length === 0 || versions.length > MAX_OFFERED_VERSIONS) return undefined;
  if (!versions.every((item) => /^[0-9]{1,10}$/u.test(item))) return undefined;
  return { build: printable(match[1] as string), versions: versions.map(Number) };
}

/**
 * The Gateway is a SuperTag release that speaks none of this client's protocol versions.
 * Retrying cannot help: one side must be upgraded. The message names both releases, where the
 * Gateway runs, and which side to upgrade.
 */
export class ProtocolMismatchError extends ConnectError {
  /** The protocol versions this client speaks. */
  readonly ourVersions: readonly number[];
  /** The protocol versions the Gateway speaks, when it named them. */
  readonly peerVersions: readonly number[] | undefined;
  /** The Gateway's release, when it named it. */
  readonly peerBuild: string | undefined;
  /** The Gateway URL this client was configured with. */
  readonly endpoint: string;

  /** ConnectError's own check accepts any ConnectError; this one follows the prototype chain. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(ProtocolMismatchError, value);
  }

  constructor(
    endpoint: string,
    peer: { build: string; versions: readonly number[] } | undefined,
    refusal?: string,
  ) {
    let message = `This client speaks SuperTag ${spoken(PROTOCOL_VERSIONS)}, but the Gateway at ${endpoint} `;
    if (peer === undefined) {
      const reason = (refusal ?? "")
        .replace(/\p{Cc}/gu, "")
        .slice(0, 512)
        .replace(/[. ]+$/u, "");
      message += `refused it: ${reason || "no reason given"}. Run the same SuperTag release on both.`;
    } else {
      message += `runs SuperTag ${peer.build} (${spoken(peer.versions)}). `;
      const peerMax = Math.max(...peer.versions);
      const ourMax = Math.max(...PROTOCOL_VERSIONS);
      if (peerMax < Math.min(...PROTOCOL_VERSIONS)) message += "Upgrade the Gateway.";
      else if (ourMax < Math.min(...peer.versions)) message += "Upgrade this client.";
      else message += "Run the same SuperTag release on both.";
    }
    super(message, Code.FailedPrecondition);
    // The name stays "ConnectError": connect recognizes its errors by name, and would otherwise
    // wrap this one in a plain ConnectError on its way to the caller.
    this.ourVersions = protocolVersions;
    this.peerVersions = peer === undefined ? undefined : Object.freeze([...peer.versions]);
    this.peerBuild = peer?.build;
    this.endpoint = endpoint;
  }
}

function refusedByGateway(error: unknown, endpoint: string): ConnectError {
  const status = ConnectError.from(error);
  if (status.code === Code.Unimplemented) {
    return new ConnectError(
      "incompatible SuperTag protocol: the Gateway does not offer SuperTag protocol negotiation",
      Code.FailedPrecondition,
    );
  }
  if (
    status.code === Code.FailedPrecondition &&
    status.rawMessage.startsWith("incompatible SuperTag protocol")
  ) {
    const peer = parseRefusal(status.rawMessage);
    return new ProtocolMismatchError(endpoint, peer, peer ? undefined : status.rawMessage);
  }
  if (
    status.code === Code.FailedPrecondition ||
    status.code === Code.PermissionDenied ||
    status.code === Code.InvalidArgument
  ) {
    return new ConnectError(
      `the SuperTag Gateway refused this operator client: ${status.rawMessage}`,
      Code.FailedPrecondition,
    );
  }
  return status;
}

function protocolRefusal(error: unknown): boolean {
  const status = ConnectError.from(error);
  return (
    status.code === Code.FailedPrecondition &&
    (status.rawMessage.startsWith("incompatible SuperTag protocol") ||
      status.rawMessage.includes("did not negotiate a protocol version"))
  );
}

/** 1 to `limit` ASCII graphic characters: the Rust bearer rule's alphabet. */
function graphic(value: string, limit: number): boolean {
  return value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Connect operator applications to the SuperTag Gateway over gRPC. The first call negotiates the
 * SuperTag protocol version, which every call then names; the Gateway refuses calls without it.
 */
export function createGatewayClient(options: GatewayClientOptions) {
  const endpoint = gatewayEndpoint(options.url);
  // As the Rust clients' bearer rule: 1 to 8192 ASCII graphic characters.
  if (!graphic(options.token, 8192)) throw new Error("Invalid operator token");
  const buildVersion = options.buildVersion ?? "supertag-ai";
  if (!graphic(buildVersion, MAX_BUILD_VERSION)) {
    throw new Error("Build version must be 1 to 64 ASCII characters without spaces");
  }
  if (!endpoint.tls && (options.ca !== undefined || options.identity !== undefined)) {
    throw new Error("Gateway TLS options require HTTPS or WSS");
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? (endpoint.tunnel ? 30_000 : 5_000);
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("Connect timeout must be a positive whole number of milliseconds");
  }

  const session = new SessionManager(
    endpoint.origin,
    {
      idleConnectionTimeoutMs: 1_000,
      pingIntervalMs: KEEPALIVE_INTERVAL_MS,
      pingTimeoutMs: KEEPALIVE_TIMEOUT_MS,
    },
    { createConnection: connector(endpoint, options, connectTimeoutMs) },
  );
  const authorization = `Bearer ${options.token}`;
  let closed = false;
  // The exchange carries no credentials.
  const negotiation = createClient(
    ProtocolNegotiation,
    createGrpcTransport({
      baseUrl: endpoint.origin.origin,
      sessionManager: session,
      readMaxBytes: 4096,
      writeMaxBytes: 4096,
      interceptors: [tunnelFailures],
    }),
  );
  let negotiated: Promise<number> | undefined;
  const protocolVersion = () => {
    if (closed) return Promise.reject(new Error("Gateway client is closed"));
    negotiated ??= (async () => {
      let answer: Awaited<ReturnType<typeof negotiation.negotiate>>;
      try {
        answer = await negotiation.negotiate(
          {
            role: ServiceRole.CLIENT,
            protocolVersions: [...PROTOCOL_VERSIONS],
            buildVersion,
          },
          { timeoutMs: 5_000 + connectTimeoutMs },
        );
      } catch (error) {
        throw refusedByGateway(error, endpoint.name);
      }
      if (answer.role !== ServiceRole.GATEWAY) {
        throw new ConnectError(
          "this operator client expected a SuperTag Gateway but reached another service",
          Code.FailedPrecondition,
        );
      }
      if (
        !PROTOCOL_VERSIONS.includes(answer.protocolVersion) ||
        !answer.protocolVersions.includes(answer.protocolVersion)
      ) {
        const versions = answer.protocolVersions.slice(0, MAX_OFFERED_VERSIONS);
        throw new ProtocolMismatchError(endpoint.name, {
          build: printable(answer.buildVersion),
          versions: versions.length > 0 ? versions : [answer.protocolVersion],
        });
      }
      return answer.protocolVersion;
    })().catch((error: unknown) => {
      negotiated = undefined;
      throw error;
    });
    return negotiated;
  };
  const transport = createGrpcTransport({
    baseUrl: endpoint.origin.origin,
    sessionManager: session,
    readMaxBytes: MAX_MESSAGE_BYTES,
    writeMaxBytes: MAX_MESSAGE_BYTES,
    interceptors: [
      (next) => async (request) => {
        if (closed) throw new Error("Gateway client is closed");
        request.header.set("authorization", authorization);
        request.header.set(PROTOCOL_HEADER, String(await protocolVersion()));
        try {
          return await next(request);
        } catch (error) {
          // A Gateway replaced by another release refuses the held version; negotiate again.
          if (protocolRefusal(error)) negotiated = undefined;
          throw error;
        }
      },
      tunnelFailures,
    ],
  });
  return {
    operator: createClient(Operator, transport),
    conversations: createClient(Conversations, transport),
    events: createClient(OperatorEvents, transport),
    objectives: createClient(Objectives, transport),
    inbox: createClient(Inbox, transport),
    workSessions: createClient(WorkSessions, transport),
    teams: createClient(Teams, transport),
    mailbox: createClient(Mailbox, transport),
    liveInputs: createClient(LiveInputs, transport),
    policy: createClient(PolicyCatalog, transport),
    manifestRelationships: createClient(ManifestRelationships, transport),
    surfaces: createClient(SurfacePolicyCatalog, transport),
    workspaces: createClient(Workspaces, transport),
    workspaceCredentials: createClient(WorkspaceCredentials, transport),
    workspaceLandings: createClient(WorkspaceLandings, transport),
    artifacts: createClient(ArtifactCatalog, transport),
    artifactPublications: createClient(ArtifactPublications, transport),
    volumes: createClient(ArtifactVolumes, transport),
    enrollments: createClient(Enrollments, transport),
    memories: createClient(Memories, transport),
    networkLogs: createClient(NetworkLogs, transport),
    schedules: createClient(Schedules, transport),
    taskFiles: createClient(TaskFiles, transport),
    /**
     * Negotiates the protocol version now, without credentials, and returns it. Calls negotiate
     * on their own; this tells whether the Gateway is reachable and compatible before any is
     * made. A Gateway from another release rejects it with {@link ProtocolMismatchError}.
     */
    negotiate(): Promise<number> {
      return protocolVersion();
    },
    close() {
      closed = true;
      session.abort();
    },
  };
}

export type GatewayClient = ReturnType<typeof createGatewayClient>;
