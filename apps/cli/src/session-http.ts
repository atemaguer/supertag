import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionPersistence } from "@supertag/control-plane";
import { TagMessagingError } from "@supertag/core";

export async function handleSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: SessionPersistence,
): Promise<void> {
  try {
    const operation = /^\/internal\/v1\/sessions\/(save|load)$/u.exec(url.pathname)?.[1];
    if (!operation) throw new TagMessagingError(404, "Session operation not found");
    if (request.method !== "POST") throw new TagMessagingError(405, "Method not allowed");
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : undefined;
    await sessions.execution(token);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new TagMessagingError(413, "Session state exceeds 16 MiB");
      chunks.push(bytes);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new TagMessagingError(400, "Invalid Session JSON");
    }
    const result = await sessions.command(operation, value, token);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof TagMessagingError ? error.statusCode : 500;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        error: status === 500 ? "Session persistence unavailable" : (error as Error).message,
      }),
    );
  }
}
