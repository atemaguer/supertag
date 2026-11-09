import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { parseCliConversationKey } from "@supertag/control-plane";
import {
  ArtifactCatalogError,
  type CapturedArtifact,
  type Session as SessionRecord,
  TagMessagingError,
  type Task as TaskRecord,
  taskDelivery,
} from "@supertag/core";
import {
  ArtifactDownloadSchema,
  ArtifactSchema,
  ErrorReason,
  SessionSchema,
  SessionStateSchema,
  TaskSchema,
  type WorkService,
} from "@supertag/operator-api";
import { artifactsWithLocations } from "./artifact-resources.js";
import { assertAccepting, callerPrincipal, pageSizeOf, requiredId } from "./inbox-rpc.js";
import { TASK_STATUS } from "./objective-protos.js";
import {
  conversationOperator,
  operatorAuditTarget,
  operatorError,
  operatorPeerAddress,
} from "./operator-rpc-context.js";
import type { OperatorControl, OperatorDataWrites, OperatorReadStore } from "./operator-seams.js";
import {
  artifactDownloadMessage,
  artifactMessage,
  inspectionMessage,
  sessionMessage,
  sessionStateMessage,
  taskEventMessage,
  taskMessage,
} from "./work-protos.js";
import {
  sessionResourcesFromStore,
  type TaskResource,
  taskResourceFromStore,
} from "./work-views.js";

/** Tasks one store read returns while `ListTasks` fills a page. */
const TASK_BATCH = 500;

/** Tasks one `ListTasks` call examines before it returns a shorter page with a token. */
const TASK_SCAN = 5_000;

/** Most recent Tasks of a Session `GetSession` checks for the one that delivered. */
const DELIVERY_SCAN = 20;

export interface WorkServiceDependencies {
  readonly store: OperatorReadStore;
  /** Records the Worker events an execution receipt names. */
  readonly writes: Pick<OperatorDataWrites, "inspectTaskExecution">;
  /** Cancels Tasks and issues artifact download grants. */
  readonly control: Pick<OperatorControl, "accepting" | "cancelTask" | "resolveArtifactDownload">;
}

/** `WorkService`: Sessions, Tasks and artifacts as an operator inspects them. */
export function workService(
  dependencies: WorkServiceDependencies,
): ServiceImpl<typeof WorkService> {
  const { store, writes, control } = dependencies;

  /** Whether the caller may see Sessions, by Session ID; one per call, never kept between calls. */
  const visibility = (context: HandlerContext) => {
    const operatorId = conversationOperator(context);
    const known = new Map<string, Promise<boolean>>();
    const ownerOf = async (session: SessionRecord): Promise<string | undefined> => {
      const own = parseCliConversationKey(session.sessionKey);
      if (own !== undefined) return own.operatorId;
      if (session.parentSessionId === undefined) return undefined;
      const parent = await store.findSessionById(session.parentSessionId);
      return parent === undefined
        ? undefined
        : parseCliConversationKey(parent.sessionKey)?.operatorId;
    };
    const visible = (session: SessionRecord) => {
      let answer = known.get(session.id);
      if (answer === undefined) {
        answer = ownerOf(session).then((owner) => owner === undefined || owner === operatorId);
        known.set(session.id, answer);
      }
      return answer;
    };
    const visibleId = async (sessionId: string) => {
      let answer = known.get(sessionId);
      if (answer === undefined) {
        const session = await store.findSessionById(sessionId);
        answer = session === undefined ? Promise.resolve(true) : visible(session);
        known.set(sessionId, answer);
      }
      return answer;
    };
    return { visible, visibleId };
  };

  const taskOrNotFound = async (
    context: HandlerContext,
    id: string,
    missing = "Task does not exist",
  ): Promise<TaskRecord> => {
    const task = id === "" ? undefined : await store.findTaskById(id);
    if (task === undefined || !(await visibility(context).visibleId(task.sessionId)))
      throw notFound(id, missing);
    return task;
  };

  const sessionOrNotFound = async (context: HandlerContext, id: string): Promise<SessionRecord> => {
    const session = id === "" ? undefined : await store.findSessionById(id);
    if (session === undefined || !(await visibility(context).visible(session)))
      throw notFound(id, "Session does not exist");
    return session;
  };

  const artifactOrNotFound = async (
    context: HandlerContext,
    id: string,
  ): Promise<CapturedArtifact> => {
    const artifact = id === "" ? undefined : await store.findCapturedArtifact(id);
    if (artifact === undefined || !(await visibility(context).visibleId(artifact.sessionId)))
      throw notFound(id, "Artifact does not exist");
    return artifact;
  };

  const tagIdOf = async (name: string, path: string): Promise<string | undefined> => {
    if (name === "") return undefined;
    const tag = await store.findTagByName(name);
    if (tag === undefined)
      throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Tag "${name}" does not exist`, [
        { path, description: "a Tag's name" },
      ]);
    return tag.id;
  };

  const tagNames = async (ids: readonly string[]) =>
    new Map(
      (await Promise.all([...new Set(ids)].map((id) => store.findTagById(id)))).flatMap((tag) =>
        tag === undefined ? [] : [[tag.id, tag.name] as const],
      ),
    );

  const taskMessages = async (resources: readonly TaskResource[]) => {
    const names = await tagNames(
      resources.flatMap((resource) => {
        const chosen = (resource.status.execution as { chosenByTagId?: unknown } | undefined)
          ?.chosenByTagId;
        return typeof chosen === "string" ? [resource.spec.tagId, chosen] : [resource.spec.tagId];
      }),
    );
    return resources.map((resource) => {
      const chosen = (resource.status.execution as { chosenByTagId?: unknown } | undefined)
        ?.chosenByTagId;
      return create(
        TaskSchema,
        taskMessage(
          resource,
          names.get(resource.spec.tagId),
          typeof chosen === "string" ? names.get(chosen) : undefined,
        ),
      );
    });
  };

  return {
    async listTasks(request, context) {
      const tagId = await tagIdOf(request.tag, "tag");
      const statuses = new Set(request.statuses.map((status) => TASK_STATUS.word(status)));
      const only = statuses.size === 1 ? [...statuses][0] : undefined;
      const size = pageSizeOf(request.pageSize, 100, 500);
      const { visibleId } = visibility(context);
      const page: TaskRecord[] = [];
      let resume = cursorOf(request.pageToken);
      let more = false;
      let scanned = 0;
      scan: while (true) {
        const batch = await store.listTasks({
          ...(tagId === undefined ? {} : { tagId }),
          ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
          ...(request.objectiveId === "" ? {} : { objectiveId: request.objectiveId }),
          ...(only === undefined ? {} : { status: only }),
          ...(resume === undefined ? {} : { before: { createdAt: resume[0], id: resume[1] } }),
          limit: TASK_BATCH,
        });
        for (const task of batch) {
          if (
            (statuses.size === 0 || statuses.has(task.status)) &&
            (await visibleId(task.sessionId))
          ) {
            if (page.length === size) {
              more = true;
              break scan;
            }
            page.push(task);
          }
          resume = [task.createdAt, task.id];
        }
        scanned += batch.length;
        if (batch.length < TASK_BATCH) break;
        if (scanned >= TASK_SCAN) {
          more = true;
          break;
        }
      }
      const resources = await Promise.all(page.map((task) => taskResourceFromStore(store, task)));
      return {
        tasks: await taskMessages(resources),
        nextPageToken: more && resume !== undefined ? tokenOf(resume) : "",
      };
    },

    async getTask(request, context) {
      const task = await taskOrNotFound(context, request.id);
      const [message] = await taskMessages([
        await taskResourceFromStore(store, task, { storage: true }),
      ]);
      return message ?? create(TaskSchema);
    },

    async listTaskEvents(request, context) {
      const task = await taskOrNotFound(
        context,
        request.taskId,
        `Task ${request.taskId} does not exist`,
      );
      const token = request.pageToken === "" ? undefined : sequenceOf(request.pageToken);
      const after = token ?? Number(request.afterSequence);
      const size = pageSizeOf(request.pageSize, 500, 1_000);
      const events = (await store.listTaskEvents(task.id))
        .filter((event) => event.sequence > after)
        .toSorted((left, right) => left.sequence - right.sequence);
      const page = events.slice(0, size);
      const last = page.at(-1);
      return {
        events: page.map(taskEventMessage),
        nextPageToken: events.length > size && last !== undefined ? `s${last.sequence}` : "",
      };
    },

    async inspectTaskExecution(request, context) {
      const id = requiredId(request.taskId, context, "Task");
      await taskOrNotFound(context, id, `Task ${id} does not exist`);
      return inspectionMessage(await writes.inspectTaskExecution(id));
    },

    async cancelTask(request, context) {
      const id = requiredId(request.id, context, "Task");
      await taskOrNotFound(context, id, `Task "${id}" does not exist`);
      await assertAccepting(control);
      const result = await control.cancelTask(id, callerPrincipal(context));
      return {
        taskId: result.task.id,
        accepted: result.accepted,
        status: TASK_STATUS.value(result.task.status),
      };
    },

    async listSessions(request, context) {
      const tagId = await tagIdOf(request.tag, "tag");
      const after = cursorOf(request.pageToken);
      const size = pageSizeOf(request.pageSize, 100, 500);
      const { visible } = visibility(context);
      const candidates = (await store.listSessions(tagId === undefined ? {} : { tagId })).filter(
        (session) =>
          (request.parentSessionId === "" || session.parentSessionId === request.parentSessionId) &&
          (request.objectiveId === "" || session.objectiveId === request.objectiveId) &&
          (after === undefined ||
            session.lastInteractionAt < after[0] ||
            (session.lastInteractionAt === after[0] && session.id > after[1])),
      );
      const page: SessionRecord[] = [];
      let more = false;
      for (const session of candidates) {
        if (!(await visible(session))) continue;
        if (page.length === size) {
          more = true;
          break;
        }
        page.push(session);
      }
      const resources = await sessionResourcesFromStore(store, page);
      const latest = await Promise.all(
        page.map(async (session) => (await store.listSessionTaskIds(session.id)).at(-1)),
      );
      const last = page.at(-1);
      return {
        sessions: page.map((session, index) =>
          create(
            SessionSchema,
            sessionMessage(
              session,
              resources[index] as NonNullable<(typeof resources)[number]>,
              latest[index],
            ),
          ),
        ),
        nextPageToken: more && last !== undefined ? tokenOf([last.lastInteractionAt, last.id]) : "",
      };
    },

    async getSession(request, context) {
      const session = await sessionOrNotFound(context, request.id);
      const [resource] = await sessionResourcesFromStore(store, [session]);
      const ids = await store.listSessionTaskIds(session.id);
      let delivered: Parameters<typeof sessionMessage>[3];
      for (const taskId of ids.slice(-DELIVERY_SCAN).toReversed()) {
        const task = await store.findTaskById(taskId);
        if (task === undefined) continue;
        const events = await store.listTaskEvents(task.id);
        if (
          taskDelivery({ workspacePlan: task.workspacePlan, result: task.result, events }) ===
          undefined
        )
          continue;
        const view = await taskResourceFromStore(store, task, { storage: true });
        if (view.status.delivery === undefined) continue;
        delivered = {
          taskId: task.id,
          delivery: view.status.delivery,
          checkout: view.status.storage?.taskFiles,
        };
        break;
      }
      return create(
        SessionSchema,
        sessionMessage(session, resource as NonNullable<typeof resource>, ids.at(-1), delivered),
      );
    },

    async listSessionStates(request, context) {
      const session = await sessionOrNotFound(context, request.sessionId);
      const after = cursorOf(request.pageToken);
      const size = pageSizeOf(request.pageSize, 100, 100);
      const states = await store.listSessionStates({
        sessionId: session.id,
        limit: size + 1,
        ...(request.nativeId === "" ? {} : { nativeId: request.nativeId }),
        ...(after === undefined ? {} : { before: { createdAt: after[0], id: after[1] } }),
      });
      const page = states.slice(0, size);
      const last = page.at(-1);
      return {
        states: page.map((state) => create(SessionStateSchema, sessionStateMessage(state))),
        nextPageToken:
          states.length > size && last !== undefined ? tokenOf([last.createdAt, last.id]) : "",
      };
    },

    async getSessionState(request, context) {
      const session = await sessionOrNotFound(context, request.sessionId);
      const state = request.id === "" ? undefined : await store.findSessionState(request.id);
      if (state === undefined || state.sessionId !== session.id)
        throw notFound(request.id, "Native archive does not exist");
      return create(SessionStateSchema, sessionStateMessage(state));
    },

    async listArtifacts(request, context) {
      const size = pageSizeOf(request.pageSize, 20, 100);
      let page: Awaited<ReturnType<OperatorReadStore["listCapturedArtifacts"]>>;
      try {
        page = await store.listCapturedArtifacts({
          limit: size,
          ...(request.taskId === "" ? {} : { taskId: request.taskId }),
          ...(request.pageToken === "" ? {} : { cursor: request.pageToken }),
        });
      } catch (error) {
        if (error instanceof ArtifactCatalogError || error instanceof TagMessagingError)
          throw invalidToken("Invalid artifact cursor");
        throw error;
      }
      const { visibleId } = visibility(context);
      const shown: CapturedArtifact[] = [];
      for (const artifact of page.artifacts)
        if (await visibleId(artifact.sessionId)) shown.push(artifact);
      return {
        artifacts: (await artifactsWithLocations(store, shown)).map(({ artifact, copies }) =>
          create(ArtifactSchema, artifactMessage(artifact, copies)),
        ),
        nextPageToken: page.nextCursor ?? "",
      };
    },

    async getArtifact(request, context) {
      const artifact = await artifactOrNotFound(context, request.id);
      const [placed] = await artifactsWithLocations(store, [artifact]);
      return create(
        ArtifactSchema,
        artifactMessage(artifact, placed?.copies ?? { locations: [], ephemeralOnly: false }),
      );
    },

    async resolveArtifactDownload(request, context) {
      const id = requiredId(request.artifactId, context, "Artifact");
      if (request.path === "" || request.path.length > 1_024)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "path must contain 1–1024 characters",
          [{ path: "path", description: "an exact ArtifactEntry.path" }],
        );
      const artifact = await artifactOrNotFound(context, id);
      const note = context.values.get(operatorAuditTarget);
      if (note !== undefined) note.target = `Artifact/${artifact.id}`;
      await assertAccepting(control);
      try {
        return create(
          ArtifactDownloadSchema,
          artifactDownloadMessage(
            await control.resolveArtifactDownload({
              artifactId: artifact.id,
              path: request.path,
              operatorId: callerPrincipal(context).operatorId,
              operatorAddress: context.values.get(operatorPeerAddress),
            }),
          ),
        );
      } catch (error) {
        if (error instanceof ArtifactCatalogError || error instanceof TagMessagingError)
          throw operatorError(
            error.statusCode === 404 ? Code.NotFound : Code.InvalidArgument,
            error.statusCode === 404 ? ErrorReason.NOT_FOUND : ErrorReason.INVALID_ARGUMENT,
            error.message,
          );
        throw error;
      }
    },
  };
}

function notFound(id: string, message: string) {
  if (id === "")
    return operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "id is required", [
      { path: "id", description: "the ID" },
    ]);
  return operatorError(Code.NotFound, ErrorReason.NOT_FOUND, message);
}

function invalidToken(message = "The page token is not valid") {
  return operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, message, [
    { path: "page_token", description: "a next_page_token from the previous page" },
  ]);
}

/** A page token naming the last item of a page by its sort time and ID. */
function tokenOf(position: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function cursorOf(token: string): readonly [string, string] | undefined {
  if (token === "") return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    )
      return [value[0], value[1]];
  } catch {}
  throw invalidToken();
}

function sequenceOf(token: string): number {
  const match = /^s(0|[1-9][0-9]{0,15})$/u.exec(token);
  if (match === null) throw invalidToken();
  return Number(match[1]);
}
