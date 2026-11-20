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
import { HarnessSchedules } from "./gen/supertag/runtime/v2/schedules_pb.js";
import { HarnessTagSessions } from "./gen/supertag/runtime/v2/tag_sessions_pb.js";

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
  // The Tag's other Sessions and its Objectives, for a root turn.
  const tagSessions = createClient(HarnessTagSessions, transport);
  // A root turn's follow-ups: later turns of its Tag in its Session.
  const schedules = createClient(HarnessSchedules, transport);
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
    tagSessions,
    schedules,
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

/**
 * Retry the identical receipt only; callers allocate a sequence before entering this function.
 *
 * Each try keeps its own deadline, so a lost connection is retried promptly, but the receipt
 * itself is retried for as long as the Worker Host stays unavailable or slow. The Worker Host
 * holds a call while it rides out a slow or restarting Control Plane, within the Attempt's
 * execution authority, and stops this adapter when that authority ends; a dead Worker Host
 * closes the adapter's guardian pipe. Giving up sooner would fail an Attempt that its Worker
 * Host could still complete.
 */
export async function receipt<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!retryable(ConnectError.from(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50 * (attempt + 1), 1_000)));
    }
  }
}

/**
 * A try that ran out of time or reached no Worker Host. Each try's `timeoutMs` travels as the
 * `grpc-timeout` header, and the Worker Host's gRPC server (tonic) ends a call that outlives it
 * with `Canceled` and the message "Timeout expired", usually just before this client's own timer
 * reports `DeadlineExceeded`. Any other `Canceled`, such as this adapter aborting its session, is
 * final.
 */
function retryable(error: ConnectError): boolean {
  return (
    error.code === Code.Unavailable ||
    error.code === Code.DeadlineExceeded ||
    (error.code === Code.Canceled && error.rawMessage === "Timeout expired")
  );
}

/**
 * The reason a call to the supervising Worker Host failed, such as `[deadline_exceeded] the
 * operation timed out`, or undefined for an error that did not come from that call. The text
 * is the Worker Host's own status or the transport's; redact it with the Attempt's credentials
 * before it leaves the adapter.
 */
export function workerHostFailure(error: unknown): string | undefined {
  return error instanceof ConnectError
    ? `Worker Host call failed: ${error.message.replace(/\p{Cc}/gu, " ")}`
    : undefined;
}
