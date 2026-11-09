import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import {
  generateObjectiveId,
  type Objective as ObjectiveRecord,
  objectiveClosed,
  parseCancelObjective,
  parseCreateObjective,
  parseObjectiveStatus,
  TagMessagingError,
} from "@supertag/core";
import {
  ErrorReason,
  ObjectiveSchema,
  type ObjectiveService,
  ObjectiveStatus,
} from "@supertag/operator-api";
import { pageOffset, pageToken } from "./conversation-messages.js";
import {
  assertAccepting,
  assertObjectiveScope,
  callerPrincipal,
  messageResponse,
  objectiveOrNotFound,
  pageSizeOf,
  requiredId,
} from "./inbox-rpc.js";
import { OBJECTIVE_STATUS, objectiveMessage, overviewMessage } from "./objective-protos.js";
import { noteAuditPreview, operatorAuditTarget, operatorError } from "./operator-rpc-context.js";
import type { OperatorControl, OperatorQueries, OperatorReadStore } from "./operator-seams.js";

/** A key is 1 to 200 characters without whitespace or control characters. */
const IDEMPOTENCY_KEY = /^[^\s\p{Cc}]{1,200}$/u;

export interface ObjectiveServiceDependencies {
  readonly store: OperatorReadStore;
  readonly queries: Pick<OperatorQueries, "objectiveRunnable" | "readObjectiveOverview">;
  readonly control: OperatorControl;
}

/** `ObjectiveService`: an operator's Objectives. */
export function objectiveService(
  dependencies: ObjectiveServiceDependencies,
): ServiceImpl<typeof ObjectiveService> {
  const { store, queries, control } = dependencies;
  const ownerName = async (objective: ObjectiveRecord) =>
    (await store.findTagById(objective.ownerTagId))?.name;
  const message = async (objective: ObjectiveRecord) =>
    create(ObjectiveSchema, objectiveMessage(objective, await ownerName(objective)));

  return {
    async createObjective(request, context) {
      const owner = request.owner === "" ? undefined : await store.findTagByName(request.owner);
      if (owner === undefined || owner.status !== "active")
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `Tag ${request.owner} does not exist`,
          [{ path: "owner", description: "the owner Tag's name" }],
        );
      const team = request.team === "" ? undefined : await findTeam(store, request.team);
      // Like Kubernetes generateName: an omitted ID comes from the outcome's first words.
      const id =
        request.id === "" && request.outcome.trim()
          ? generateObjectiveId(request.outcome)
          : request.id;
      const note = context.values.get(operatorAuditTarget);
      if (note !== undefined && id !== "") note.target = `Objective/${id}`;
      if (request.dryRun) noteAuditPreview(context);
      const parsed = parseCreateObjective({
        id,
        outcome: request.outcome,
        ongoing: request.ongoing,
        ...(request.deadline === undefined
          ? {}
          : { deadline: timestampDate(request.deadline).toISOString() }),
        ...(request.budget === undefined
          ? {}
          : {
              budgetLimitMinor: safeNumber(request.budget.limitMinor, "budget.limit_minor"),
              ...(request.budget.currency === ""
                ? {}
                : { budgetCurrency: request.budget.currency }),
            }),
        ...(request.runtimeActions.length === 0 ? {} : { runtimeActions: request.runtimeActions }),
        workspaces: request.workspaces,
        ...(team === undefined ? {} : { teamId: team.id }),
      });
      const requested = request.runtimeActions.length === 0 ? undefined : parsed.runtimeActions;
      const created = await control.createObjective({
        objective: parsed,
        ownerTagId: owner.id,
        ...(requested === undefined ? {} : { requestedRuntimeActions: requested }),
        dryRun: request.dryRun,
      });
      const objective = created.objective;
      // Warnings name conditions that would hold the Objective's Tasks or limit what they may do;
      // creation still succeeds.
      const warnings =
        objective.status === "completed"
          ? []
          : [...created.warnings, ...(await queries.objectiveRunnable(objective)).reasons];
      // Creating starts the Objective's conversation. Starting is idempotent, so a retried create
      // returns the same first Task. A condition that prevents starting leaves the Objective created.
      let startedTaskId = "";
      let notStarted = "";
      if (!request.dryRun && !objectiveClosed(objective.status)) {
        try {
          if (!(await control.accepting()))
            throw new TagMessagingError(
              503,
              "The Control Plane is draining; create the Objective again later to start it",
            );
          startedTaskId = (await control.startObjective(objective.id)).taskId;
        } catch (error) {
          if (!(error instanceof TagMessagingError)) throw error;
          notStarted = error.message;
        }
      }
      return {
        objective: objectiveMessage(objective, owner.name),
        warnings,
        startedTaskId,
        notStarted,
      };
    },

    async listObjectives(request) {
      const owner = request.owner === "" ? undefined : await store.findTagByName(request.owner);
      if (request.owner !== "" && (owner === undefined || owner.status !== "active"))
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `Tag ${request.owner} does not exist`,
        );
      const size = pageSizeOf(request.pageSize, 100, 200);
      const offset = pageOffset(request.pageToken);
      const objectives = await store.listObjectives(owner?.id, size, offset);
      const more =
        objectives.length === size &&
        (await store.listObjectives(owner?.id, 1, offset + size)).length > 0;
      const names = new Map<string, string | undefined>();
      for (const objective of objectives)
        if (!names.has(objective.ownerTagId))
          names.set(objective.ownerTagId, await ownerName(objective));
      return {
        objectives: objectives.map((objective) =>
          objectiveMessage(objective, names.get(objective.ownerTagId)),
        ),
        nextPageToken: more ? pageToken(offset + size) : "",
      };
    },

    async getObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      assertObjectiveScope(context, id);
      return message(await objectiveOrNotFound(store, id));
    },

    async describeObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      const limit = pageSizeOf(request.pageSize, 50, 100);
      const offset = pageOffset(request.pageToken);
      const view = await queries.readObjectiveOverview(
        { objectiveId: id, limit, offset },
        callerPrincipal(context),
      );
      return overviewMessage(
        view,
        view.tagNames[view.objective.ownerTagId],
        view.nextOffset === null ? "" : pageToken(view.nextOffset),
      );
    },

    async messageObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      const text = request.text.trim();
      if (!text)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "The message is empty",
          [{ path: "text", description: "the message, not only whitespace" }],
        );
      if (request.idempotencyKey !== "" && !IDEMPOTENCY_KEY.test(request.idempotencyKey))
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "An idempotency key is 1 to 200 characters without whitespace or control characters",
          [{ path: "idempotency_key", description: "1 to 200 characters, no whitespace" }],
        );
      await assertAccepting(control);
      const result = await control.messageObjective(
        {
          objectiveId: id,
          text,
          idempotencyKey: request.idempotencyKey || randomUUID(),
        },
        callerPrincipal(context),
      );
      const objective = await store.getObjective(id);
      return messageResponse(result, (await ownerName(objective)) ?? objective.ownerTagId);
    },

    async updateObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      if (request.status === ObjectiveStatus.LIMITED)
        throw operatorError(
          Code.PermissionDenied,
          ErrorReason.PERMISSION_DENIED,
          "Only the owner marks an Objective limited",
        );
      if (request.status === ObjectiveStatus.CANCELLED)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "Only an operator can cancel an Objective, with a cancellation request rather than a status update",
          [{ path: "status", description: "working, blocked, ready_for_review or completed" }],
        );
      const status =
        request.status === undefined ? undefined : OBJECTIVE_STATUS.word(request.status);
      if (request.status !== undefined && status === undefined)
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "status is not set",
          [{ path: "status", description: "working, blocked, ready_for_review or completed" }],
        );
      const update = parseObjectiveStatus({
        expectedRevision: safeNumber(request.expectedRevision, "expected_revision"),
        ...(status === undefined ? {} : { status }),
        ...(request.completionSummary === undefined
          ? {}
          : { completionSummary: request.completionSummary }),
        ...(request.deadline === undefined
          ? {}
          : { deadline: timestampDate(request.deadline).toISOString() }),
        ...(request.budgetLimitMinor === undefined
          ? {}
          : { budgetLimitMinor: safeNumber(request.budgetLimitMinor, "budget_limit_minor") }),
        ...(request.runtimeActions === undefined
          ? {}
          : { runtimeActions: request.runtimeActions.actions }),
      });
      const updated = await control.updateObjective({
        objectiveId: id,
        update,
        operatorId: callerPrincipal(context).operatorId,
      });
      return { objective: await message(updated.objective), warnings: [...updated.warnings] };
    },

    async approveObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      await assertAccepting(control);
      return message(await control.approveObjective({ objectiveId: id }, callerPrincipal(context)));
    },

    async cancelObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      const { reason } = parseCancelObjective(
        request.reason === "" ? {} : { reason: request.reason },
      );
      const result = await control.cancelObjective(
        { objectiveId: id, reason: reason ?? null },
        callerPrincipal(context),
      );
      return {
        objective: await message(result.objective),
        changed: result.changed,
        cancelledTaskIds: [...result.cancelledTaskIds],
      };
    },

    async pauseObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      const result = await control.pauseObjective({ objectiveId: id }, callerPrincipal(context));
      return { objective: await message(result.objective), changed: result.changed };
    },

    async resumeObjective(request, context) {
      const id = requiredId(request.id, context, "Objective");
      const result = await control.resumeObjective({ objectiveId: id }, callerPrincipal(context));
      return {
        objective: await message(result.objective),
        changed: result.changed,
        summary: result.summary ?? "",
      };
    },
  };
}

/** A Team by ID, or else by name; `NotFound` without one. */
async function findTeam(store: OperatorReadStore, idOrName: string) {
  const team =
    (await store.getTeam(idOrName)) ??
    (await store.listTeams()).find((candidate) => candidate.name === idOrName);
  if (team === undefined)
    throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Team ${idOrName} does not exist`, [
      { path: "team", description: "a Team's name or ID" },
    ]);
  return team;
}

function safeNumber(value: bigint, path: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw operatorError(
      Code.InvalidArgument,
      ErrorReason.INVALID_ARGUMENT,
      `${path} is too large`,
      [{ path, description: "a safe integer" }],
    );
  return number;
}
