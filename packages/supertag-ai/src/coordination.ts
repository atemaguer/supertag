/**
 * Experimental typed client for SuperTag's durable coordination control plane.
 * Domain rows remain Objective, Team, Workstream, Task, and Mailbox records;
 * views returned here are projections over those records.
 */

import type { CoordinationInboxPage, ReadCoordinationInboxInput } from "../../core/src/index.js";

export type {
  CoordinationInboxAction,
  CoordinationInboxApproval,
  CoordinationInboxEvidence,
  CoordinationInboxFilter,
  CoordinationInboxItem,
  CoordinationInboxKind,
  CoordinationInboxPage,
  CoordinationInboxQuestion,
  CoordinationInboxStatus,
  Objective,
  ReadCoordinationInboxInput,
  Team,
  WorkstreamPost,
} from "../../core/src/index.js";

export interface CoordinationClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Administrative client. Keep its bearer token outside Harness processes. */
export class CoordinationClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CoordinationClientOptions) {
    const token = options.token.trim();
    if (!token || token.length > 4096) throw new Error("Coordination token is required");
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
      throw new Error("Coordination base URL must use HTTP or HTTPS");
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  inbox(input: ReadCoordinationInboxInput = {}): Promise<CoordinationInboxPage> {
    const query = new URLSearchParams();
    for (const [name, value] of [
      ["objectiveId", input.objectiveId],
      ["kind", input.kind],
      ["status", input.status],
      ["nextActorId", input.nextActorId],
      ["asOf", input.asOf],
      ["cursor", input.cursor],
    ] as const) {
      if (value !== undefined) query.set(name, value);
    }
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request<CoordinationInboxPage>(`/api/v1/coordination/inbox${suffix}`);
  }

  async request<Result>(pathname: string, init: RequestInit = {}): Promise<Result> {
    if (!pathname.startsWith("/api/v1/coordination/"))
      throw new Error("Coordination requests must use the coordination API");
    const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        typeof (body as Record<string, unknown>)["message"] === "string"
          ? String((body as Record<string, unknown>)["message"])
          : `API Server returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as Result;
  }
}
