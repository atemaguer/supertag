import { pageOffset, pageToken } from "./conversation-messages.js";
import { pageSizeOf } from "./inbox-rpc.js";

/**
 * One page of a list the RPC reads whole, from a request's `page_size` and `page_token`: 0 means
 * `fallback`, and more than `max` means `max`. The token is an offset, so any API Server process
 * continues it.
 */
export function pageOf<T>(
  items: readonly T[],
  request: { readonly pageSize: number; readonly pageToken: string },
  fallback = 100,
  max = 500,
): { readonly page: readonly T[]; readonly nextPageToken: string } {
  const offset = pageOffset(request.pageToken);
  const size = pageSizeOf(request.pageSize, fallback, max);
  return {
    page: items.slice(offset, offset + size),
    nextPageToken: offset + size < items.length ? pageToken(offset + size) : "",
  };
}
