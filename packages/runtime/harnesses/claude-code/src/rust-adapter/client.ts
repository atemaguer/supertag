import { fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdapterBootstrapSchema, Harness } from "./gen/supertag/runtime/v2/runtime_pb.js";

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
  const url = new URL(bootstrap.endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[\x21-\x7e]{16,1024}$/.test(bootstrap.token)
  )
    throw new Error("Invalid private Harness bootstrap");
  return bootstrap;
}

export function harnessClient(endpoint: string, token: string) {
  const client = createClient(
    Harness,
    createGrpcTransport({
      baseUrl: endpoint,
      readMaxBytes: 17 * 1024 * 1024,
      writeMaxBytes: 17 * 1024 * 1024,
      idleConnectionTimeoutMs: 100,
    }),
  );
  const options = () => ({ headers: { authorization: `Bearer ${token}` }, timeoutMs: 5000 });
  return { client, options };
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
