import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  CreateObjectiveInput,
  ListWorkstreamPostsOptions,
  Objective,
  PostWorkstreamInput,
  SendTagMessageInput,
  TagMessage,
  TagMessageDelivery,
  TagMessageHistoryOptions,
  TagMessageHistoryPage,
  UpdateObjectiveStatusInput,
  Workstream,
  WorkstreamPost,
} from "@supertag/core";
import { GrpcMailboxTransport } from "./mailbox-grpc-client.js";

export interface TagMailboxClientOptions {
  readonly controlPlaneUrl: string;
  /** Host-side credential. Keep it outside agent prompts, tools, and artifacts. */
  readonly token: string;
  readonly transport?: "http" | "grpc";
  readonly tlsCa?: string;
}
export class TagMailboxClientError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TagMailboxClientError";
  }
}
export interface TagMessageHandlerContext {
  readonly signal: AbortSignal;
  readonly mailbox: TagMailboxClient;
}

/** Durable, surface-independent messaging for a trusted custom Worker application. */
export class TagMailboxClient {
  readonly #url: string;
  readonly #token: string;
  readonly #grpc: GrpcMailboxTransport | undefined;
  constructor(options: TagMailboxClientOptions) {
    if (
      options.transport !== undefined &&
      options.transport !== "http" &&
      options.transport !== "grpc"
    )
      throw new Error("Unsupported mailbox transport");
    const url = new URL(options.controlPlaneUrl);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
      throw new Error(
        "Expected a Control Plane origin URL without credentials, path, query, or fragment",
      );
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      throw new Error("Mailbox credentials require HTTPS except on loopback");
    }
    if (!options.token) throw new Error("A Tag mailbox credential is required");
    this.#url = url.origin;
    this.#token = options.token;
    this.#grpc =
      options.transport === "grpc"
        ? new GrpcMailboxTransport(url.origin, options.token, options.tlsCa)
        : undefined;
  }

  static async fromCredentialFile(path: string): Promise<TagMailboxClient> {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof value["controlPlaneUrl"] !== "string" || typeof value["token"] !== "string")
      throw new Error("Invalid mailbox credential file");
    if (
      value["transport"] !== undefined &&
      value["transport"] !== "http" &&
      value["transport"] !== "grpc"
    )
      throw new Error("Invalid mailbox credential transport");
    return new TagMailboxClient({
      controlPlaneUrl: value["controlPlaneUrl"],
      token: value["token"],
      ...(value["transport"] === "grpc" || value["transport"] === "http"
        ? { transport: value["transport"] }
        : {}),
      ...(typeof value["tlsCa"] === "string" ? { tlsCa: value["tlsCa"] } : {}),
    });
  }

  createObjective(input: CreateObjectiveInput, signal?: AbortSignal): Promise<Objective> {
    return this.#request("/objectives/create", input, signal);
  }
  getObjective(id: string, signal?: AbortSignal): Promise<Objective> {
    return this.#request(`/objectives/${encodeURIComponent(id)}/get`, {}, signal);
  }
  async listObjectives(limit = 100, signal?: AbortSignal): Promise<readonly Objective[]> {
    const result = await this.#request<{ items: Objective[] }>(
      "/objectives/list",
      { limit },
      signal,
    );
    return result.items;
  }
  updateObjectiveStatus(
    id: string,
    input: UpdateObjectiveStatusInput,
    signal?: AbortSignal,
  ): Promise<Objective> {
    return this.#request(`/objectives/${encodeURIComponent(id)}/status`, input, signal);
  }

  getWorkstream(id: string, signal?: AbortSignal): Promise<Workstream> {
    return this.#request(`/workstreams/${encodeURIComponent(id)}/get`, {}, signal);
  }
  async listWorkstreams(limit = 100, signal?: AbortSignal): Promise<readonly Workstream[]> {
    const result = await this.#request<{ items: Workstream[] }>(
      "/workstreams/list",
      { limit },
      signal,
    );
    return result.items;
  }
  /**
   * Post to a Team channel; its ID is the Team ID. `type` defaults to `note` and `to` names Tags
   * in the Team. A post carries no authority and creates no mailbox delivery or Task.
   */
  postWorkstream(
    id: string,
    input: Omit<PostWorkstreamInput, "workstreamId" | "authorTagId">,
    signal?: AbortSignal,
  ): Promise<WorkstreamPost> {
    return this.#request(`/workstreams/${encodeURIComponent(id)}/posts/create`, input, signal);
  }
  /** Read posts after a cursor; retain the last returned sequence for the next read. */
  async workstreamPosts(
    id: string,
    options: ListWorkstreamPostsOptions = {},
    signal?: AbortSignal,
  ): Promise<readonly WorkstreamPost[]> {
    const result = await this.#request<{ items: WorkstreamPost[] }>(
      `/workstreams/${encodeURIComponent(id)}/posts/list`,
      options,
      signal,
    );
    return result.items;
  }

  send(
    input: SendTagMessageInput,
    signal?: AbortSignal,
  ): Promise<{ readonly message: TagMessage; readonly duplicate: boolean }> {
    return this.#request("/send", input, signal);
  }
  /** Page through this Tag's inbound and outbound history, newest first. */
  history(
    options: TagMessageHistoryOptions = {},
    signal?: AbortSignal,
  ): Promise<TagMessageHistoryPage> {
    return this.#request("/history", options, signal);
  }
  async receive(
    options: { readonly waitMs?: number; readonly leaseMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<TagMessageDelivery | undefined> {
    const result = await this.#request<{ delivery: TagMessageDelivery | null }>(
      "/receive",
      options,
      signal,
    );
    return result.delivery ?? undefined;
  }
  async acknowledge(delivery: TagMessageDelivery, signal?: AbortSignal): Promise<void> {
    await this.#request(
      `/messages/${encodeURIComponent(delivery.message.id)}/ack`,
      { leaseToken: delivery.leaseToken },
      signal,
    );
  }
  /** Explicit retry only when the handler knows repeating its effects is safe. */
  async release(delivery: TagMessageDelivery, retry = false, signal?: AbortSignal): Promise<void> {
    await this.#request(
      `/messages/${encodeURIComponent(delivery.message.id)}/release`,
      { leaseToken: delivery.leaseToken, retry },
      signal,
    );
  }
  async renew(delivery: TagMessageDelivery, leaseMs = 60_000, signal?: AbortSignal): Promise<void> {
    await this.#request(
      `/messages/${encodeURIComponent(delivery.message.id)}/renew`,
      { leaseToken: delivery.leaseToken, leaseMs },
      signal,
    );
  }

  /** Long-poll, invoke the handler, and acknowledge only after successful processing.
   * Delivery is at least once; use the message ID to deduplicate external effects.
   * A handler failure marks the message failed and rejects this consumer loop.
   */
  async consume(
    handler: (message: TagMessage, context: TagMessageHandlerContext) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let delivery: TagMessageDelivery | undefined;
      try {
        delivery = await this.receive({ waitMs: 20_000, leaseMs: 60_000 }, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (!retryable(error)) throw error;
        await delay(1_000, undefined, { signal }).catch(() => undefined);
        continue;
      }
      if (!delivery) continue;
      try {
        await this.#process(delivery, handler, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }

  async #process(
    delivery: TagMessageDelivery,
    handler: (message: TagMessage, context: TagMessageHandlerContext) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const lostLease = new AbortController();
    const heartbeatStop = new AbortController();
    const handlerSignal = AbortSignal.any([signal, lostLease.signal]);
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted) {
        try {
          await delay(15_000, undefined, { signal: heartbeatStop.signal });
          if (!heartbeatStop.signal.aborted) await this.renew(delivery, 60_000, handlerSignal);
        } catch (error) {
          if (!heartbeatStop.signal.aborted) lostLease.abort(error);
          return;
        }
      }
    })();
    try {
      try {
        await handler(delivery.message, { signal: handlerSignal, mailbox: this });
        handlerSignal.throwIfAborted();
      } catch (error) {
        // Do not make a possibly side-effecting failure automatically retryable.
        await this.release(delivery, false).catch(() => undefined);
        throw error;
      }
      // If acknowledgement is ambiguous, retry the receipt, never the handler.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.acknowledge(delivery, handlerSignal);
          break;
        } catch (error) {
          if (attempt >= 2 || !retryable(error) || handlerSignal.aborted) throw error;
          await delay(250, undefined, { signal: handlerSignal });
        }
      }
    } finally {
      heartbeatStop.abort();
      await heartbeat;
    }
  }

  async #request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#grpc) {
      try {
        return (await this.#grpc.request(path, body, signal)) as T;
      } catch (error) {
        if (!(error instanceof ConnectError)) throw error;
        const statuses: Partial<Record<Code, number>> = {
          [Code.InvalidArgument]: 400,
          [Code.Unauthenticated]: 401,
          [Code.PermissionDenied]: 403,
          [Code.NotFound]: 404,
          [Code.Aborted]: 409,
          [Code.AlreadyExists]: 409,
          [Code.FailedPrecondition]: 409,
          [Code.ResourceExhausted]: 429,
          [Code.Canceled]: 499,
          [Code.DeadlineExceeded]: 504,
          [Code.Unavailable]: 503,
        };
        throw new TagMailboxClientError(statuses[error.code] ?? 500, error.rawMessage);
      }
    }
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(`${this.#url}/internal/v1/mailbox${path}`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const data = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!response.ok)
      throw new TagMailboxClientError(
        response.status,
        typeof data?.["message"] === "string" ? data["message"] : "Mailbox request failed",
      );
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new TagMailboxClientError(502, "Invalid Control Plane mailbox response");
    }
    return data as T;
  }
}
function retryable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError") ||
    (error instanceof TagMailboxClientError && error.statusCode >= 500)
  );
}
