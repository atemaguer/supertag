/**
 * Experimental typed client for SuperTag's operator inbox, served as the
 * `supertag.operator.v1.InboxService` RPCs over the Connect protocol.
 */

import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  InboxService,
  type ListInboxItemsRequestSchema,
  type ListInboxItemsResponse,
} from "../../operator-api/src/index.js";

export type {
  InboxItem,
  ListInboxItemsRequest,
  ListInboxItemsResponse,
} from "../../operator-api/src/index.js";
export { InboxItemKind, InboxService } from "../../operator-api/src/index.js";

export interface CoordinationClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Administrative client. Keep its bearer token outside Harness processes. */
export class CoordinationClient {
  readonly #client;

  constructor(options: CoordinationClientOptions) {
    const token = options.token.trim();
    if (!token || token.length > 4096) throw new Error("Coordination token is required");
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
      throw new Error("Coordination base URL must use HTTP or HTTPS");
    this.#client = createClient(
      InboxService,
      createConnectTransport({
        baseUrl: baseUrl.origin,
        fetch: options.fetch ?? globalThis.fetch,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${token}`);
            return next(request);
          },
        ],
      }),
    );
  }

  /** One page of the inbox, as `InboxService.ListInboxItems` returns it. */
  inbox(
    request: MessageInitShape<typeof ListInboxItemsRequestSchema> = {},
  ): Promise<ListInboxItemsResponse> {
    return this.#client.listInboxItems(request);
  }
}
