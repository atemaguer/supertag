import { fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { HarnessArtifacts } from "./gen/supertag/runtime/v2/artifact_pb.js";
import { HarnessEffects } from "./gen/supertag/runtime/v2/effects_pb.js";
import { HarnessMcp } from "./gen/supertag/runtime/v2/mcp_pb.js";
import {
  AdapterBootstrapSchema,
  Harness,
  HarnessMailbox,
  HarnessQuestions,
  HarnessWorkSessions,
  HarnessWorkspace,
  HarnessWorkstreams,
} from "./gen/supertag/runtime/v2/runtime_pb.js";

/** This is a Worker-owned, execution-scoped transport, never a public control-plane client. */
export async function readBootstrap(input: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    length += chunk.length;
    if (length > 4096) throw new Error("Harness bootstrap exceeds its limit");
    chunks.push(chunk);
  }
  const bootstrap = fromBinary(AdapterBootstrapSchema, Buffer.concat(chunks));
  validatedBootstrap(bootstrap.endpoint, bootstrap.token);
  return bootstrap;
}

function validatedBootstrap(endpoint: string, token: string) {
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/u.test(endpoint) || /\s/u.test(endpoint))
    throw new Error("Invalid private Harness bootstrap");
  const url = URL.parse(endpoint);
  if (!url || url.port === "0" || !/^[A-Za-z0-9._~-]{16,512}$/u.test(token) || /\s/u.test(token))
    throw new Error("Invalid private Harness bootstrap");
  return url;
}

/** Connect to the execution-scoped service on the supervising Worker Host. */
export function harnessClient(endpoint: string, token: string) {
  const url = validatedBootstrap(endpoint, token);
  const session = new Http2SessionManager(url, { idleConnectionTimeoutMs: 100 });
  const authorization = `Bearer ${token}`;
  let closed = false;
  const transport = createGrpcTransport({
    baseUrl: url.origin,
    sessionManager: session,
    readMaxBytes: 17 * 1024 * 1024,
    writeMaxBytes: 17 * 1024 * 1024,
    defaultTimeoutMs: 5_000,
    interceptors: [
      (next) => (request) => {
        if (closed) throw new Error("Harness client is closed");
        request.header.set("authorization", authorization);
        return next(request);
      },
    ],
  });
  const client = createClient(Harness, transport);
  const questions = createClient(HarnessQuestions, transport);
  const workstreams = createClient(HarnessWorkstreams, transport);
  const mailbox = createClient(HarnessMailbox, transport);
  const workSessions = createClient(HarnessWorkSessions, transport);
  const workspace = createClient(HarnessWorkspace, transport);
  const artifacts = createClient(HarnessArtifacts, transport);
  const mcp = createClient(HarnessMcp, transport);
  // Worker-managed effect receipts: begin before an external write, then complete or fail it.
  const effects = createClient(HarnessEffects, transport);
  const options = () => ({ timeoutMs: 5000 });
  return {
    client,
    options,
    questions,
    workstreams,
    mailbox,
    workSessions,
    workspace,
    artifacts,
    mcp,
    effects,
    close() {
      closed = true;
      session.abort();
    },
  };
}

/** Retry the identical receipt only; callers allocate a sequence before entering this function. */
export async function receipt<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const code = ConnectError.from(error).code;
      if (attempt >= 2 || ![Code.Unavailable, Code.DeadlineExceeded].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
