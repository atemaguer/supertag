import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  type AuthKey as AuthKeyRecord,
  parseAuthKeyName,
  parseWorkerHostLabels,
  parseWorkerHostName,
  type WorkerHost as WorkerHostRecord,
} from "@supertag/core";
import {
  AuthKeySchema,
  ErrorReason,
  type HostService,
  WorkerHostCredentialSchema,
  WorkerHostSchema,
} from "@supertag/operator-api";
import {
  authKeyResource,
  workerHostResource,
  workerHostResourcesFromStore,
} from "./control-plane-resources.js";
import { authKeyMessage, workerHostMessage } from "./host-protos.js";
import { assertAccepting } from "./inbox-rpc.js";
import { pageOf } from "./operator-pages.js";
import {
  IDEMPOTENCY_KEY,
  noteAuditActor,
  noteAuditTarget,
  operatorError,
  operatorPrincipal,
  presentedAuthKey,
  requiredField,
} from "./operator-rpc-context.js";
import type { OperatorControl, OperatorQueries, OperatorReadStore } from "./operator-seams.js";

/** The most Tags an Auth Key binds. */
const MAX_AUTH_KEY_TAGS = 32;
/** The most labels an Auth Key grants. */
const MAX_AUTH_KEY_LABELS = 64;

export interface HostServiceDependencies {
  readonly store: Pick<
    OperatorReadStore,
    | "findAuthKeyByName"
    | "findTagByName"
    | "listAuthKeys"
    | "listRunningTaskAttempts"
    | "listTagWorkerHostBindings"
    | "listTags"
    | "listTaskAttempts"
    | "listTaskEvents"
    | "listTasks"
  >;
  /** Every Worker Host, the embedded Worklet's own host included. */
  readonly queries: Pick<OperatorQueries, "listWorkerHosts">;
  /**
   * Enrolls, joins, drains, binds and revokes Worker Hosts, and creates and revokes Auth Keys.
   */
  readonly control: Pick<
    OperatorControl,
    | "accepting"
    | "createAuthKey"
    | "enrollWorkerHost"
    | "joinWorkerHost"
    | "revokeAuthKey"
    | "revokeWorkerHostCredential"
    | "rotateWorkerHostCredential"
    | "setTagWorkerHost"
    | "setWorkerHostDraining"
  >;
}

/** `HostService`: the Worker Hosts of the Organization and the Auth Keys that join them. */
export function hostService(
  dependencies: HostServiceDependencies,
): ServiceImpl<typeof HostService> {
  const { store, queries, control } = dependencies;

  const hostMessages = async (hosts: readonly WorkerHostRecord[]) =>
    (await workerHostResourcesFromStore(store, hosts)).map((resource) =>
      create(WorkerHostSchema, workerHostMessage(resource)),
    );

  const tagNames = async () =>
    new Map((await store.listTags({ includeRetired: true })).map((tag) => [tag.id, tag.name]));

  const authKeyMessages = async (keys: readonly AuthKeyRecord[]) => {
    const names = await tagNames();
    return keys.map((key) => create(AuthKeySchema, authKeyMessage(authKeyResource(key, names))));
  };

  const findHost = async (id: string): Promise<WorkerHostRecord> => {
    const host = (await queries.listWorkerHosts()).find((candidate) => candidate.id === id);
    if (host === undefined) throw missingWorkerHost();
    return host;
  };

  const activeTag = async (name: string) => {
    const tagName = requiredField(name, "tag", "a Tag's name");
    const tag = await store.findTagByName(tagName);
    if (tag === undefined || tag.status !== "active")
      throw operatorError(
        Code.NotFound,
        ErrorReason.NOT_FOUND,
        `Tag ${JSON.stringify(tagName)} does not exist`,
        [{ path: "tag", description: "a Tag's name" }],
      );
    return tag;
  };

  const bind = async (
    request: { readonly tag: string; readonly workerHostId: string },
    context: HandlerContext,
    bound: boolean,
  ) => {
    noteAuditTarget(context, "Tag");
    const tag = await activeTag(request.tag);
    noteAuditTarget(context, `Tag/${tag.name}`);
    const workerHostId = requiredField(
      request.workerHostId,
      "worker_host_id",
      "a Worker Host's ID",
    );
    await assertAccepting(control);
    const { workerHostIds, changed } = await control.setTagWorkerHost({
      tagId: tag.id,
      workerHostId,
      bound,
    });
    return { tag: tag.name, tagId: tag.id, workerHosts: [...workerHostIds], changed };
  };

  const setDraining = async (
    request: { readonly id: string },
    context: HandlerContext,
    draining: boolean,
  ) => {
    noteAuditTarget(context, "WorkerHost");
    const id = workerHostId(request.id);
    assertOwnWorkerHost(context, id);
    noteAuditTarget(context, `WorkerHost/${id}`);
    await assertAccepting(control);
    const host = await control.setWorkerHostDraining({ id, draining });
    return create(WorkerHostSchema, workerHostMessage(workerHostResource(host)));
  };

  return {
    async listWorkerHosts(request) {
      // A removed ephemeral host stays readable by ID but leaves the list.
      const hosts = (await queries.listWorkerHosts()).filter(
        (host) => !(host.ephemeral && host.enrollmentStatus === "revoked"),
      );
      const { page, nextPageToken } = pageOf(hosts, request);
      return { workerHosts: await hostMessages(page), nextPageToken };
    },

    async getWorkerHost(request) {
      const host = await findHost(workerHostId(request.id));
      const [message] = await hostMessages([host]);
      if (message === undefined) throw missingWorkerHost();
      return message;
    },

    async enrollWorkerHost(request, context) {
      noteAuditTarget(context, "WorkerHost");
      const id = workerHostId(request.id);
      await assertAccepting(control);
      const issued = await control.enrollWorkerHost(id);
      noteAuditTarget(context, `WorkerHost/${issued.workerHost.id}`);
      return create(WorkerHostCredentialSchema, {
        workerHostId: issued.workerHost.id,
        issuedAt: timestampFromDate(new Date(issued.workerHost.updatedAt)),
        token: issued.token,
      });
    },

    async rotateWorkerHostCredential(request, context) {
      noteAuditTarget(context, "WorkerHost");
      const id = workerHostId(request.id);
      noteAuditTarget(context, `WorkerHost/${id}`);
      const expected = Number(request.expectedCredentialRevision);
      if (!Number.isSafeInteger(expected) || expected < 1)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "expected_credential_revision must be at least 1",
          [{ path: "expected_credential_revision", description: "the host's credential_revision" }],
        );
      await assertAccepting(control);
      const issued = await control.rotateWorkerHostCredential({
        id,
        expectedCredentialRevision: expected,
      });
      return create(WorkerHostCredentialSchema, {
        workerHostId: issued.workerHost.id,
        issuedAt: timestampFromDate(new Date(issued.workerHost.updatedAt)),
        token: issued.token,
      });
    },

    async revokeWorkerHostCredential(request, context) {
      noteAuditTarget(context, "WorkerHost");
      const id = workerHostId(request.id);
      const self = assertOwnWorkerHost(context, id);
      noteAuditTarget(context, `WorkerHost/${id}`);
      await assertAccepting(control);
      const revoked = await control.revokeWorkerHostCredential({
        id,
        reason: self ? "SelfRevoked" : "OperatorRevoked",
      });
      const [message] = await hostMessages([revoked]);
      if (message === undefined) throw missingWorkerHost();
      return message;
    },

    drainWorkerHost: (request, context) => setDraining(request, context, true),
    resumeWorkerHost: (request, context) => setDraining(request, context, false),
    async joinWorkerHost(request, context) {
      noteAuditTarget(context, "WorkerHost");
      const authKey = context.values.get(presentedAuthKey);
      if (authKey === undefined)
        throw operatorError(Code.Internal, ErrorReason.INTERNAL, "Control Plane internal error");
      const name = invalidAsArgument("name", () => parseWorkerHostName(request.name));
      if (request.idempotencyKey !== "" && !IDEMPOTENCY_KEY.test(request.idempotencyKey))
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "An idempotency key is 1 to 200 characters without whitespace or control characters",
          [{ path: "idempotency_key", description: "1 to 200 characters without whitespace" }],
        );
      await assertAccepting(control);
      const joined = await control.joinWorkerHost({
        authKey,
        name,
        idempotencyKey: request.idempotencyKey || randomUUID(),
      });
      noteAuditActor(context, `auth-key:${joined.authKey.name}`);
      noteAuditTarget(context, `WorkerHost/${joined.workerHost.id}`);
      const names = await tagNames();
      return {
        credential: create(WorkerHostCredentialSchema, {
          workerHostId: joined.workerHost.id,
          issuedAt: timestampFromDate(new Date(joined.workerHost.updatedAt)),
          token: joined.token,
        }),
        authKey: joined.authKey.name,
        tags: joined.authKey.tagIds.map((id) => names.get(id) ?? id),
        ephemeral: joined.workerHost.ephemeral,
      };
    },

    bindWorkerHost: (request, context) => bind(request, context, true),
    unbindWorkerHost: (request, context) => bind(request, context, false),

    async createAuthKey(request, context) {
      noteAuditTarget(context, "AuthKey");
      const name = invalidAsArgument("name", () => parseAuthKeyName(request.name));
      const tags = [...new Set(request.tags.map((tag) => tag.trim()).filter(Boolean))];
      if (tags.length === 0 || tags.length > MAX_AUTH_KEY_TAGS)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          `An Auth Key needs 1-${MAX_AUTH_KEY_TAGS} Tags`,
          [{ path: "tags", description: `1 to ${MAX_AUTH_KEY_TAGS} Tag names` }],
        );
      if (request.labels.length > MAX_AUTH_KEY_LABELS)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          `An Auth Key grants at most ${MAX_AUTH_KEY_LABELS} labels`,
          [{ path: "labels", description: `at most ${MAX_AUTH_KEY_LABELS} labels` }],
        );
      const labels = invalidAsArgument("labels", () =>
        parseWorkerHostLabels(request.labels, "labels"),
      );
      for (const tag of tags) {
        const found = await store.findTagByName(tag);
        if (found === undefined || found.status !== "active")
          throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Tag ${tag} does not exist`, [
            { path: "tags", description: "names of Tags that exist" },
          ]);
      }
      await assertAccepting(control);
      const issued = await control.createAuthKey({
        name,
        tags,
        labels,
        reusable: request.reusable,
        ephemeral: request.ephemeral,
      });
      noteAuditTarget(context, `AuthKey/${issued.authKey.name}`);
      const [authKey] = await authKeyMessages([issued.authKey]);
      return { ...(authKey === undefined ? {} : { authKey }), secret: issued.secret };
    },

    async listAuthKeys(request) {
      const { page, nextPageToken } = pageOf(await store.listAuthKeys(), request);
      return { authKeys: await authKeyMessages(page), nextPageToken };
    },

    async getAuthKey(request) {
      const name = requiredField(request.name, "name", "an Auth Key's name");
      const key = await store.findAuthKeyByName(name);
      if (key === undefined) throw missingAuthKey(name);
      const [message] = await authKeyMessages([key]);
      if (message === undefined) throw missingAuthKey(name);
      return message;
    },

    async revokeAuthKey(request, context) {
      noteAuditTarget(context, "AuthKey");
      const name = requiredField(request.name, "name", "an Auth Key's name");
      noteAuditTarget(context, `AuthKey/${name}`);
      await assertAccepting(control);
      const key = await control.revokeAuthKey(name);
      if (key === undefined) throw missingAuthKey(name);
      const [message] = await authKeyMessages([key]);
      if (message === undefined) throw missingAuthKey(name);
      return message;
    },
  };
}

/**
 * Refuses a Worker Host credential that names another host; true when the caller is the host
 * itself.
 */
function assertOwnWorkerHost(context: HandlerContext, id: string): boolean {
  const caller = context.values.get(operatorPrincipal);
  if (caller?.kind !== "worker-host") return false;
  if (caller.workerHostId !== id)
    throw operatorError(
      Code.PermissionDenied,
      ErrorReason.PERMISSION_DENIED,
      "A Worker Host credential acts only on its own Worker Host",
    );
  return true;
}

function workerHostId(id: string): string {
  return requiredField(id, "id", "a Worker Host's ID");
}

function missingWorkerHost() {
  return operatorError(Code.NotFound, ErrorReason.NOT_FOUND, "Worker Host does not exist", [
    { path: "id", description: "an enrolled Worker Host's ID" },
  ]);
}

function missingAuthKey(name: string) {
  return operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Auth Key ${name} does not exist`, [
    { path: "name", description: "an Auth Key's name" },
  ]);
}

/** A value the shared parsers refuse is the caller's `InvalidArgument`, naming the field. */
export function invalidAsArgument<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof Error)
      throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, error.message, [
        { path, description: error.message },
      ]);
    throw error;
  }
}
