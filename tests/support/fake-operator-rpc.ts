import { vi } from "vitest";

/** One call an operator RPC fake received: `Service/Method` and its JSON request. */
export interface FakeRpcCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A refusal a fake answers with, as the Connect protocol sends it. */
export class FakeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Answers one RPC: unary RPCs return their response's proto JSON, and server streams return an
 * async iterable of messages, which stays open until it ends or the call is aborted.
 */
export type FakeRpcHandler = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => unknown | Promise<unknown> | AsyncIterable<unknown>;

/**
 * Replaces `fetch` with operator RPCs answered over the Connect protocol with JSON, keyed by
 * `Service/Method` such as `InboxService/ListInboxItems`. Every other request fails the test.
 */
export function fakeOperatorRpc(handlers: Readonly<Record<string, FakeRpcHandler>>) {
  const calls: FakeRpcCall[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace(/^\/supertag\.operator\.v1\./u, "");
    const handler = handlers[method];
    if (handler === undefined) throw new Error(`unexpected request ${url.pathname}`);
    const streaming = new Headers(init?.headers).get("content-type") === "application/connect+json";
    const bytes = await requestBytes(init?.body);
    const body = JSON.parse(
      new TextDecoder().decode(streaming ? bytes.slice(5) : bytes) || "{}",
    ) as Record<string, unknown>;
    calls.push({ method, body });
    const signal = init?.signal ?? new AbortController().signal;
    try {
      const result = await handler(body, signal);
      if (!streaming) return Response.json(result);
      return streamResponse(result as AsyncIterable<unknown>, signal);
    } catch (error) {
      if (!(error instanceof FakeRpcError)) throw error;
      if (streaming)
        return new Response(envelope(2, { error: { code: error.code, message: error.message } }), {
          headers: { "content-type": "application/connect+json" },
        });
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    }
  });
  return {
    calls,
    fetch,
    called: (method: string) => calls.filter((call) => call.method === method),
  };
}

async function requestBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function streamResponse(messages: AsyncIterable<unknown>, signal: AbortSignal): Response {
  const iterator = messages[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.close();
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(envelope(2, {}));
          controller.close();
        } else controller.enqueue(envelope(0, next.value));
      } catch (error) {
        const refusal =
          error instanceof FakeRpcError
            ? { code: error.code, message: error.message }
            : { code: "internal", message: String(error) };
        controller.enqueue(envelope(2, { error: refusal }));
        controller.close();
      }
    },
    cancel() {
      void iterator.return?.();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/connect+json" } });
}

/** One Connect stream frame: its flags, its length, then its JSON. */
function envelope(flags: number, value: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(5 + json.length);
  new DataView(frame.buffer).setUint8(0, flags);
  new DataView(frame.buffer).setUint32(1, json.length);
  frame.set(json, 5);
  return frame;
}

/** Resolves once `signal` aborts. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * A `Watch` stream: a heartbeat, then the change notice `change` each time `next` is called,
 * until the call is aborted.
 */
export function watchStream(
  change: Readonly<Record<string, unknown>> = { kind: "WATCH_KIND_INBOX_ITEM" },
) {
  const waiting: (() => void)[] = [];
  let position = 0;
  const handler: FakeRpcHandler = (_body, signal) =>
    (async function* () {
      yield { resumeToken: `v1.test.${position}`, heartbeat: {} };
      while (!signal.aborted) {
        await Promise.race([
          new Promise<void>((resolve) => waiting.push(resolve)),
          aborted(signal),
        ]);
        if (signal.aborted) return;
        position += 1;
        yield {
          resumeToken: `v1.test.${position}`,
          change: { id: `change-${position}`, reason: "changed", ...change },
        };
      }
    })();
  return {
    handler,
    /** Sends one change notice to every open stream. */
    next: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}
