import { isIP } from "node:net";
import { createClient } from "@connectrpc/connect";
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

export interface GatewayClientOptions {
  readonly url: string;
  readonly token: string;
  /** PEM certificate authority for a Gateway with a private TLS certificate. */
  readonly ca?: string | Buffer;
  /** PEM client identity for a Gateway that requires mutual TLS. */
  readonly identity?: { readonly cert: string | Buffer; readonly key: string | Buffer };
}

function gatewayOrigin(value: string): URL {
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/u.test(value) || /\s/u.test(value)) {
    throw new Error("Gateway URL must be an HTTP or HTTPS origin");
  }
  const url = new URL(value);
  if (url.port === "0") throw new Error("Gateway URL must use a valid port");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Cleartext Gateway URL must use a loopback IP address");
  }
  return url;
}

/** Connect operator applications to the SuperTag Gateway over gRPC. */
export function createGatewayClient(options: GatewayClientOptions) {
  const url = gatewayOrigin(options.url);
  if (
    options.token.length > 512 ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(options.token) ||
    /\s/u.test(options.token)
  ) {
    throw new Error("Invalid Gateway operator token");
  }
  if (url.protocol === "http:" && (options.ca !== undefined || options.identity !== undefined)) {
    throw new Error("Gateway TLS options require HTTPS");
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
  const transport = createGrpcTransport({
    baseUrl: url.origin,
    sessionManager: session,
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 1024 * 1024,
    interceptors: [
      (next) => (request) => {
        if (closed) throw new Error("Gateway client is closed");
        request.header.set("authorization", authorization);
        return next(request);
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

export type GatewayClient = ReturnType<typeof createGatewayClient>;
