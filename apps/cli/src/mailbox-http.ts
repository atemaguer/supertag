import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mailboxObject,
  mailboxText,
  parseCreateTeam,
  parseUpdateTeam,
  type Store,
  TagMessagingError,
  type Team,
} from "@supertag/core";

/** Called only after administrative authentication for /api/v1/tag-messaging routes. */
export async function handleMailboxAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: Store,
): Promise<void> {
  await guarded(response, async () => {
    const route = url.pathname.slice("/api/v1/tag-messaging".length);
    if (route === "/teams" || route.startsWith("/teams/"))
      await teams(request, response, url, route, store);
    else if (route.startsWith("/workstreams/")) {
      const match = /^\/workstreams\/([^/]+)\/posts$/u.exec(route);
      if (!match || request.method !== "GET") {
        respond(response, 404, { error: "not_found" });
        return;
      }
      const team = await findTeam(store, decodeURIComponent(match[1] ?? ""));
      respond(response, 200, {
        items: await store.listTeamPosts(team.id, {
          ...integerQuery(url, "afterSequence"),
          ...integerQuery(url, "limit"),
        }),
      });
    } else if (route === "/grants") {
      if (request.method === "GET") {
        respond(response, 200, {
          items: await store.listTagMessagingGrants(
            mailboxText(url.searchParams.get("tagId"), "tagId"),
          ),
        });
        return;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        respond(response, 404, { error: "not_found" });
        return;
      }
      const grant = mailboxObject(await readBody(request), ["senderTagId", "recipientTagId"]);
      const senderTagId = mailboxText(grant["senderTagId"], "senderTagId");
      const recipientTagId = mailboxText(grant["recipientTagId"], "recipientTagId");
      const senders = new Set(
        (await store.listTagMessagingGrants(recipientTagId))
          .filter((existing) => existing.recipientTagId === recipientTagId)
          .map((existing) => existing.senderTagId),
      );
      const changed =
        request.method === "PUT" ? !senders.has(senderTagId) : senders.has(senderTagId);
      if (request.method === "PUT") senders.add(senderTagId);
      else senders.delete(senderTagId);
      if (changed) await store.setTagMessagingGrants(recipientTagId, [...senders].toSorted());
      respond(response, 200, { senderTagId, recipientTagId, changed });
    } else if (request.method === "GET" && route === "/messages") {
      for (const key of url.searchParams.keys())
        if (!["tagId", "beforeCreatedAt", "beforeId", "limit"].includes(key))
          throw new TagMessagingError(400, "Unknown message query field");
      if (url.searchParams.has("beforeCreatedAt") !== url.searchParams.has("beforeId"))
        throw new TagMessagingError(400, "A message cursor requires beforeCreatedAt and beforeId");
      respond(
        response,
        200,
        await store.listTagMessageHistory(mailboxText(url.searchParams.get("tagId"), "tagId"), {
          ...(url.searchParams.has("beforeId")
            ? {
                before: {
                  createdAt: mailboxText(
                    url.searchParams.get("beforeCreatedAt"),
                    "beforeCreatedAt",
                  ),
                  id: mailboxText(url.searchParams.get("beforeId"), "beforeId"),
                },
              }
            : {}),
          ...integerQuery(url, "limit"),
        }),
      );
    } else {
      respond(response, 404, { error: "not_found" });
    }
  });
}

async function teams(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  route: string,
  store: Store,
): Promise<void> {
  if (route === "/teams") {
    if (request.method === "GET") {
      for (const key of url.searchParams.keys())
        if (key !== "tagId") throw new TagMessagingError(400, "Unknown Team query field");
      respond(response, 200, {
        items: url.searchParams.has("tagId")
          ? await store.listTeamsOfTag(mailboxText(url.searchParams.get("tagId"), "tagId"))
          : await store.listTeams(),
      });
    } else if (request.method === "POST")
      respond(response, 201, await store.createTeam(parseCreateTeam(await readBody(request))));
    else respond(response, 404, { error: "not_found" });
    return;
  }
  const match = /^\/teams\/([^/]+)$/u.exec(route);
  if (!match) {
    respond(response, 404, { error: "not_found" });
    return;
  }
  const team = await findTeam(store, decodeURIComponent(match[1] ?? ""));
  if (request.method === "GET") respond(response, 200, team);
  else if (request.method === "PATCH")
    respond(
      response,
      200,
      await store.updateTeam(team.id, parseUpdateTeam(await readBody(request))),
    );
  else if (request.method === "DELETE")
    respond(response, 200, { deleted: await store.deleteTeam(team.id) });
  else respond(response, 404, { error: "not_found" });
}

/** A Team by ID, or else by name. */
async function findTeam(store: Store, idOrName: string): Promise<Team> {
  const team =
    (await store.getTeam(idOrName)) ??
    (await store.listTeams()).find((candidate) => candidate.name === idOrName);
  if (team === undefined) throw new TagMessagingError(404, `Team ${idOrName} does not exist`);
  return team;
}

function integerQuery(url: URL, name: string): Record<string, number> {
  const value = url.searchParams.get(name);
  if (value === null) return {};
  if (!/^\d+$/u.test(value)) throw new TagMessagingError(400, `${name} must be an integer`);
  return { [name]: Number(value) };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 70_000) throw new TagMessagingError(413, "Message request exceeds 70,000 bytes");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TagMessagingError(400, "Invalid JSON body");
  }
}
async function guarded(response: ServerResponse, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (response.destroyed) return;
    respond(response, error instanceof TagMessagingError ? error.statusCode : 500, {
      error: "tag_messaging_error",
      message: error instanceof TagMessagingError ? error.message : "Tag messaging request failed",
    });
  }
}
function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
