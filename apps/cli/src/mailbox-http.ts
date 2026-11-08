import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveOwnerObjectiveRuntimeActions } from "@supertag/control-plane";
import {
  generateObjectiveId,
  mailboxObject,
  mailboxText,
  type Objective,
  objectiveClosed,
  parseCreateObjective,
  parseCreateTeam,
  parseObjectiveStatus,
  parseUpdateTeam,
  type Store,
  TagMessagingError,
  type Team,
} from "@supertag/core";

/** What the operator routes need from a running Control Plane; omitted where none runs. */
export interface MailboxAdminControlPlane {
  /** Admission checks for creation warnings. */
  readonly runnable: (objective: Objective) => Promise<{ readonly reasons: readonly string[] }>;
  /** Admits the first turn of a new Objective's conversation. */
  readonly start: (objective: Objective) => Promise<{ readonly taskId: string }>;
}

/** Called only after administrative authentication for /api/v1/tag-messaging routes. */
export async function handleMailboxAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: Store,
  controlPlane?: MailboxAdminControlPlane,
): Promise<void> {
  await guarded(response, async () => {
    const route = url.pathname.slice("/api/v1/tag-messaging".length);
    if (route === "/objectives" || route.startsWith("/objectives/"))
      await objectives(request, response, url, route, store, controlPlane);
    else if (route === "/teams" || route.startsWith("/teams/"))
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

async function objectives(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  route: string,
  store: Store,
  controlPlane: MailboxAdminControlPlane | undefined,
): Promise<void> {
  if (route === "/objectives" && request.method === "POST") {
    const record = mailboxObject(await readBody(request), [
      "id",
      "outcome",
      "deadline",
      "budgetLimitMinor",
      "budgetCurrency",
      "runtimeActions",
      "ownerTagId",
      "teamId",
      "ongoing",
      "workspaces",
    ]);
    const { ownerTagId, ...definition } = record;
    // Like Kubernetes generateName: an omitted ID comes from the outcome's first words.
    if (definition["id"] === undefined && typeof definition["outcome"] === "string")
      definition["id"] = generateObjectiveId(definition["outcome"]);
    const dryRun = url.searchParams.get("dryRun") === "true";
    const parsed = parseCreateObjective(definition);
    const owner = mailboxText(ownerTagId, "ownerTagId");
    // Runtime actions resolve once against the owner's Permission Sets and are frozen into the
    // record. A retry without them returns the existing Objective, even if grants changed since.
    const requested =
      definition["runtimeActions"] === undefined ? undefined : parsed.runtimeActions;
    const prior =
      requested === undefined
        ? await store.getObjective(parsed.id).catch(() => undefined)
        : undefined;
    const runtime = await resolveOwnerObjectiveRuntimeActions(store, {
      objectiveId: parsed.id,
      ownerTagId: owner,
      ...(requested === undefined ? {} : { requested }),
    });
    const objective = await store.createObjective(
      {
        ...parsed,
        runtimeActions:
          prior?.ownerTagId === owner ? (prior.runtimeActions ?? []) : runtime.runtimeActions,
        ownerTagId: owner,
      },
      { dryRun },
    );
    // Warnings name conditions that would hold the Objective's Tasks or limit what they may do;
    // creation still succeeds.
    const warnings =
      objective.status === "completed"
        ? []
        : [
            ...(prior ? [] : runtime.warnings),
            ...(controlPlane ? (await controlPlane.runnable(objective)).reasons : []),
          ];
    // Creating starts the Objective's conversation. Starting is idempotent, so a retried create
    // returns the same first Task. A condition that prevents starting leaves the Objective created.
    let started: { readonly taskId: string } | undefined;
    let notStarted: string | undefined;
    if (!dryRun && controlPlane && !objectiveClosed(objective.status)) {
      try {
        started = { taskId: (await controlPlane.start(objective)).taskId };
      } catch (error) {
        if (!(error instanceof TagMessagingError)) throw error;
        notStarted = error.message;
      }
    }
    respond(response, 200, {
      ...objective,
      warnings,
      ...(started === undefined ? {} : { started }),
      ...(notStarted === undefined ? {} : { notStarted }),
      ...(dryRun ? { dryRun: true } : {}),
    });
    return;
  }
  if (route === "/objectives" && request.method === "GET") {
    respond(response, 200, {
      items: await store.listObjectives(
        url.searchParams.has("tagId")
          ? mailboxText(url.searchParams.get("tagId"), "tagId")
          : undefined,
        url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
        url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
      ),
    });
    return;
  }
  const match = /^\/objectives\/([^/]+)$/u.exec(route);
  if (!match) {
    respond(response, 404, { error: "not_found" });
    return;
  }
  const id = decodeURIComponent(match[1] ?? "");
  if (request.method === "GET") respond(response, 200, await store.getObjective(id));
  else if (request.method === "PATCH") {
    const update = parseObjectiveStatus(await readBody(request));
    if (update.runtimeActions === undefined)
      respond(response, 200, await store.updateObjectiveStatus(id, update));
    else {
      // A new list is bounded by the owner's Permission Sets as they are now.
      const current = await store.getObjective(id);
      const runtime = await resolveOwnerObjectiveRuntimeActions(store, {
        objectiveId: id,
        ownerTagId: current.ownerTagId,
        requested: update.runtimeActions,
      });
      const updated = await store.updateObjectiveStatus(id, {
        ...update,
        runtimeActions: runtime.runtimeActions,
      });
      respond(response, 200, { ...updated, warnings: runtime.warnings });
    }
  } else respond(response, 404, { error: "not_found" });
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
