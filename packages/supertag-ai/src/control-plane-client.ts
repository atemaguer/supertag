import { isIP } from "node:net";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  ArtifactCatalog,
  ArtifactPublications,
  ArtifactTransfers,
  ArtifactVolumes,
} from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/artifact_pb.js";
import { GithubPublications } from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/github_publications_pb.js";
import { GithubWorkspaces } from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/github_workspaces_pb.js";
import {
  ProtocolNegotiation,
  ServiceRole,
} from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/negotiation_pb.js";
import {
  PolicyCatalog,
  SurfacePolicyCatalog,
} from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/policy_pb.js";
import {
  Conversations,
  Inbox,
  LiveInputs,
  Mailbox,
  ManifestRelationships,
  Objectives,
  Operator,
  OperatorEvents,
  Teams,
  Transfers,
  WorkSessions,
} from "../../runtime/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb.js";

export { Code, ConnectError } from "@connectrpc/connect";

export interface ControlPlaneClientOptions {
  readonly url: string;
  readonly token: string;
  /** PEM certificate authority for a Control Plane with a private TLS certificate. */
  readonly ca?: string | Buffer;
  /** PEM client identity for a Control Plane that requires mutual TLS. */
  readonly identity?: { readonly cert: string | Buffer; readonly key: string | Buffer };
}

function controlPlaneOrigin(value: string): URL {
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/u.test(value) || /\s/u.test(value)) {
    throw new Error("Control Plane URL must be an HTTP or HTTPS origin");
  }
  const url = new URL(value);
  if (url.port === "0") throw new Error("Control Plane URL must use a valid port");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Cleartext Control Plane URL must use a loopback IP address");
  }
  return url;
}

/** Names, on every call, the protocol version this client negotiated with the Control Plane. */
const PROTOCOL_HEADER = "x-supertag-protocol";
/** The SuperTag protocol versions this client speaks. */
const PROTOCOL_VERSIONS = [2];

function refusedByControlPlane(error: unknown): ConnectError {
  const status = ConnectError.from(error);
  if (status.code === Code.Unimplemented) {
    return new ConnectError(
      "incompatible SuperTag protocol: the Control Plane does not offer SuperTag protocol negotiation",
      Code.FailedPrecondition,
    );
  }
  if (
    status.code === Code.FailedPrecondition ||
    status.code === Code.PermissionDenied ||
    status.code === Code.InvalidArgument
  ) {
    return new ConnectError(
      `the SuperTag Control Plane refused this operator client: ${status.rawMessage}`,
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

/**
 * Connect operator applications to the SuperTag Control Plane over gRPC. The first call negotiates the
 * SuperTag protocol version, which every call then names; the Control Plane refuses calls without it.
 */
export function createControlPlaneClient(options: ControlPlaneClientOptions) {
  const url = controlPlaneOrigin(options.url);
  if (
    options.token.length > 512 ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(options.token) ||
    /\s/u.test(options.token)
  ) {
    throw new Error("Invalid operator token");
  }
  if (url.protocol === "http:" && (options.ca !== undefined || options.identity !== undefined)) {
    throw new Error("Control Plane TLS options require HTTPS");
  }

  const session = new Http2SessionManager(
    url,
    { idleConnectionTimeoutMs: 1_000 },
    {
      ca: options.ca,
      cert: options.identity?.cert,
      key: options.identity?.key,
      rejectUnauthorized: true,
    },
  );
  const authorization = `Bearer ${options.token}`;
  let closed = false;
  // The exchange carries no credentials.
  const negotiation = createClient(
    ProtocolNegotiation,
    createGrpcTransport({
      baseUrl: url.origin,
      sessionManager: session,
      readMaxBytes: 4096,
      writeMaxBytes: 4096,
    }),
  );
  let negotiated: Promise<number> | undefined;
  const protocolVersion = () => {
    negotiated ??= (async () => {
      let answer: Awaited<ReturnType<typeof negotiation.negotiate>>;
      try {
        answer = await negotiation.negotiate(
          {
            role: ServiceRole.OPERATOR,
            protocolVersions: PROTOCOL_VERSIONS,
            buildVersion: "supertag-ai",
          },
          { timeoutMs: 5_000 },
        );
      } catch (error) {
        throw refusedByControlPlane(error);
      }
      if (answer.role !== ServiceRole.CONTROL_PLANE) {
        throw new ConnectError(
          "this operator client expected a SuperTag Control Plane but reached another service",
          Code.FailedPrecondition,
        );
      }
      if (
        !PROTOCOL_VERSIONS.includes(answer.protocolVersion) ||
        !answer.protocolVersions.includes(answer.protocolVersion)
      ) {
        throw new ConnectError(
          `incompatible SuperTag protocol: the Control Plane selected protocol ${answer.protocolVersion}; run the same SuperTag release on the Control Plane and this client`,
          Code.FailedPrecondition,
        );
      }
      return answer.protocolVersion;
    })().catch((error: unknown) => {
      negotiated = undefined;
      throw error;
    });
    return negotiated;
  };
  const transport = createGrpcTransport({
    baseUrl: url.origin,
    sessionManager: session,
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 1024 * 1024,
    interceptors: [
      (next) => async (request) => {
        if (closed) throw new Error("Control Plane client is closed");
        request.header.set("authorization", authorization);
        request.header.set(PROTOCOL_HEADER, String(await protocolVersion()));
        try {
          return await next(request);
        } catch (error) {
          // A Control Plane replaced by another release refuses the held version; negotiate again.
          if (protocolRefusal(error)) negotiated = undefined;
          throw error;
        }
      },
    ],
  });
  const artifacts = createClient(ArtifactTransfers, transport);
  const workspaces = createClient(Transfers, transport);
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
    githubWorkspaces: createClient(GithubWorkspaces, transport),
    githubPublications: createClient(GithubPublications, transport),
    artifacts: createClient(ArtifactCatalog, transport),
    artifactPublications: createClient(ArtifactPublications, transport),
    volumes: createClient(ArtifactVolumes, transport),
    downloadArtifactFile: artifacts.downloadFile,
    downloadWorkspaceArtifact: workspaces.downloadWorkspaceArtifact,
    downloadReviewArtifact: workspaces.downloadReviewArtifact,
    close() {
      closed = true;
      session.abort();
    },
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
