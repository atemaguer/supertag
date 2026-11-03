import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ExecutionAuthorityService } from "./coordination-codec.js";

/** Rebinds only an existing signed durable Attempt; never exchanges Worker Host authority. */
export class GrpcExecutionAuthorityClient {
  readonly #client;
  constructor(options: { readonly baseUrl: string; readonly tlsCa?: string }) {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Execution authority requires HTTPS outside loopback and an origin URL");
    this.#client = createClient(
      ExecutionAuthorityService,
      createGrpcTransport({
        baseUrl: url.origin,
        readMaxBytes: 8192,
        writeMaxBytes: 8192,
        idleConnectionTimeoutMs: 1000,
        ...(options.tlsCa === undefined ? {} : { nodeOptions: { ca: options.tlsCa } }),
      }),
    );
  }
  async rebind(token: string, signal?: AbortSignal): Promise<string> {
    const result = await this.#client.rebind(
      {},
      {
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      },
    );
    if (!result.token.trim() || result.token.length > 4096)
      throw new Error("Execution authority returned an invalid credential");
    return result.token;
  }
}

/** Wait for a shared renewal without letting one request own or cancel that renewal. */
export async function waitForExecutionAuthorityRefresh<T>(
  refresh: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([refresh, cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
