import type { IncomingMessage, ServerResponse } from "node:http";
import {
  resolveOwnerObjectiveRuntimeActions,
  TagMailboxService,
  type TeamLiveDeliveryStarter,
} from "@supertag/control-plane";
import {
  generateObjectiveId,
  mailboxObject,
  mailboxText,
  type Objective,
  objectiveClosed,
  parseCreateObjective,
  parseObjectiveStatus,
  type Store,
  TagMessagingError,
  type TaskAssignment,
} from "@supertag/core";

/** Called only after administrative authentication for /api/v1/tag-messaging routes. */
export async function handleMailboxAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: Store,
  /** Admission checks for creation warnings; omitted where no Control Plane is running. */
  runnable?: (objective: Objective) => Promise<{ readonly reasons: readonly string[] }>,
  /** Starts the owner, as start_objective does; omitted where no Control Plane is running. */
  start?: (objective: Objective) => Promise<TaskAssignment>,
): Promise<void> {
  await guarded(response, async () => {
    const service = new TagMailboxService(store);
    const route = url.pathname.slice("/api/v1/tag-messaging".length);
    if (route === "/objectives" || route.startsWith("/objectives/")) {
      if (route === "/objectives" && request.method === "POST") {
        const record = mailboxObject(await readBody(request), [
          "id",
          "outcome",
          "deadline",
          "budgetLimitMinor",
          "budgetCurrency",
          "runtimeActions",
          "ownerTagId",
          "observations",
          "ongoing",
          "workspaces",
          "start",
        ]);
        const { ownerTagId, start: startRequested, ...definition } = record;
        if (startRequested !== undefined && typeof startRequested !== "boolean")
          throw new TagMessagingError(400, "start must be boolean");
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
                ...(runnable ? (await runnable(objective)).reasons : []),
              ];
        // `start: true` also starts the owner. Starting is idempotent, so a retried create returns
        // the existing start Task. A condition that prevents starting leaves the Objective created.
        let started: { readonly taskId: string; readonly teamId: string } | undefined;
        let notStarted: string | undefined;
        if (startRequested === true && !dryRun && start && !objectiveClosed(objective.status)) {
          try {
            const task = await start(objective);
            started = { taskId: task.taskId, teamId: task.teamId };
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
      } else if (route === "/objectives" && request.method === "GET") {
        respond(response, 200, {
          items: await store.listObjectives(
            url.searchParams.has("tagId")
              ? mailboxText(url.searchParams.get("tagId"), "tagId")
              : undefined,
            url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
            url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
          ),
        });
      } else {
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
    } else if (route === "/workstreams" || route.startsWith("/workstreams/")) {
      const match = /^\/workstreams\/([^/]+)(\/posts)?$/u.exec(route);
      if (route === "/workstreams" && request.method === "GET") {
        respond(response, 200, {
          items: await store.listWorkstreams(
            url.searchParams.has("tagId")
              ? mailboxText(url.searchParams.get("tagId"), "tagId")
              : undefined,
            url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
          ),
        });
      } else if (!match || request.method !== "GET") {
        respond(response, 404, { error: "not_found" });
      } else if (match[2] === "/posts") {
        const id = decodeURIComponent(match[1] ?? "");
        respond(response, 200, {
          items: await store.listWorkstreamPosts(id, undefined, {
            ...(url.searchParams.has("afterSequence")
              ? { afterSequence: Number(url.searchParams.get("afterSequence")) }
              : {}),
            ...(url.searchParams.has("limit")
              ? { limit: Number(url.searchParams.get("limit")) }
              : {}),
          }),
        });
      } else {
        respond(response, 200, await store.getWorkstream(decodeURIComponent(match[1] ?? "")));
      }
    } else if (request.method === "GET" && route === "/history") {
      for (const key of url.searchParams.keys())
        if (!["tagId", "beforeCreatedAt", "beforeId", "limit"].includes(key))
          throw new TagMessagingError(400, "Unknown history query field");
      if (url.searchParams.has("beforeCreatedAt") !== url.searchParams.has("beforeId"))
        throw new TagMessagingError(400, "History cursor requires beforeCreatedAt and beforeId");
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
          ...(url.searchParams.has("limit")
            ? { limit: Number(url.searchParams.get("limit")) }
            : {}),
        }),
      );
    } else if (request.method === "POST" && route === "/retention") {
      const input = mailboxObject(await readBody(request), ["before", "limit"]);
      respond(
        response,
        200,
        await store.pruneTagMessageBodies({
          before: mailboxText(input["before"], "before"),
          ...(input["limit"] === undefined ? {} : { limit: input["limit"] as number }),
        }),
      );
    } else if (request.method === "POST" && route === "/credentials") {
      const body = mailboxObject(await readBody(request), ["tagId"]);
      respond(response, 201, await service.issueCredential(mailboxText(body["tagId"], "tagId")));
    } else if (request.method === "DELETE" && /^\/credentials\/[^/]+$/u.test(route)) {
      const removed = await store.revokeTagMailboxCredential(
        decodeURIComponent(route.slice("/credentials/".length)),
      );
      respond(response, removed ? 200 : 404, { revoked: removed });
    } else if (request.method === "PUT" && route === "/grants") {
      await service.setGrant(await readBody(request));
      respond(response, 200, { ok: true });
    } else if (request.method === "GET" && (route === "/messages" || route === "/grants")) {
      const tagId = mailboxText(url.searchParams.get("tagId"), "tagId");
      respond(response, 200, {
        items:
          route === "/messages"
            ? await store.listTagMessages(
                tagId,
                url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100,
              )
            : await store.listTagMessagingGrants(tagId),
      });
    } else {
      respond(response, 404, { error: "not_found" });
    }
  });
}

export async function handleMailboxRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: Store,
  /** The Control Plane's live delivery of posts and messages to running teammates. */
  live?: TeamLiveDeliveryStarter,
): Promise<void> {
  await guarded(response, async () => {
    const service = new TagMailboxService(store, live);
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    // Authenticate before reading a body or disclosing endpoint details.
    await service.authenticate(token);
    if (request.method !== "POST") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    const route = url.pathname.slice("/internal/v1/mailbox".length);
    const body = await readBody(request);
    if (route === "/objectives/create") {
      respond(response, 200, await service.createObjective(token, body));
    } else if (route === "/objectives/list") {
      respond(response, 200, { items: await service.listObjectives(token, body) });
    } else if (route.startsWith("/objectives/")) {
      const match = /^\/objectives\/([^/]+)\/(get|status)$/u.exec(route);
      if (!match) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      const id = decodeURIComponent(match[1] ?? "");
      if (match[2] === "get") {
        mailboxObject(body, []);
        respond(response, 200, await service.getObjective(token, id));
      } else respond(response, 200, await service.updateObjectiveStatus(token, id, body));
    } else if (route === "/workstreams/list") {
      respond(response, 200, { items: await service.listWorkstreams(token, body) });
    } else if (route.startsWith("/workstreams/")) {
      const match = /^\/workstreams\/([^/]+)\/(get|posts\/create|posts\/list)$/u.exec(route);
      if (!match) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      const id = decodeURIComponent(match[1] ?? "");
      if (match[2] === "get") {
        mailboxObject(body, []);
        respond(response, 200, await service.getWorkstream(token, id));
      } else if (match[2] === "posts/create") {
        respond(response, 200, await service.postWorkstream(token, id, body));
      } else {
        respond(response, 200, { items: await service.listWorkstreamPosts(token, id, body) });
      }
    } else if (route === "/history") {
      respond(response, 200, await service.history(token, body));
    } else if (route === "/send") {
      const result = await service.send(token, body);
      respond(response, result.duplicate ? 200 : 201, result);
    } else if (route === "/receive") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once("close", abort);
      try {
        const delivery = await service.receive(token, body, controller.signal);
        respond(response, 200, { delivery: delivery ?? null });
      } finally {
        response.off("close", abort);
      }
    } else {
      const match = /^\/messages\/([^/]+)\/(ack|release|renew)$/u.exec(route);
      if (!match) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      await service.settle(
        token,
        decodeURIComponent(match[1] ?? ""),
        match[2] as "ack" | "release" | "renew",
        body,
      );
      respond(response, 200, { ok: true });
    }
  });
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
