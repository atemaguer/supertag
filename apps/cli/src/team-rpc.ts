import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  parseCreateTeam,
  parseUpdateTeam,
  TagMessagingError,
  type Team as TeamRecord,
} from "@supertag/core";
import { ErrorReason, TeamSchema, type TeamService } from "@supertag/operator-api";
import { pageOffset, pageToken } from "./conversation-messages.js";
import { assertAccepting, pageSizeOf } from "./inbox-rpc.js";
import { timestampOf } from "./objective-protos.js";
import { operatorAuditTarget, operatorError } from "./operator-rpc-context.js";
import type { OperatorControl, OperatorReadStore } from "./operator-seams.js";

export interface TeamServiceDependencies {
  readonly store: Pick<
    OperatorReadStore,
    "findTagById" | "findTagByName" | "getTeam" | "listTeams" | "listTeamsOfTag"
  >;
  /** Creates, changes and deletes Teams. */
  readonly control: Pick<OperatorControl, "accepting" | "createTeam" | "updateTeam" | "deleteTeam">;
}

/** `TeamService`: the Teams of the Organization. */
export function teamService(
  dependencies: TeamServiceDependencies,
): ServiceImpl<typeof TeamService> {
  const { store, control } = dependencies;

  const message = async (team: TeamRecord) => create(TeamSchema, await teamMessage(store, team));

  /** The Tags' IDs, by name; `NotFound` for one that does not exist or was deleted. */
  const memberIds = async (names: readonly string[], path: string): Promise<string[]> => {
    const ids: string[] = [];
    for (const name of new Set(names.map((name) => name.trim()).filter(Boolean))) {
      const tag = await store.findTagByName(name);
      if (tag === undefined || tag.status !== "active")
        throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Tag "${name}" does not exist`, [
          { path, description: "a Tag's name" },
        ]);
      ids.push(tag.id);
    }
    if (ids.length === 0)
      throw operatorError(
        Code.InvalidArgument,
        ErrorReason.INVALID_ARGUMENT,
        "A Team needs at least one member",
        [{ path, description: "1 to 100 Tag names" }],
      );
    return ids;
  };

  return {
    async createTeam(request, context) {
      const id = request.id === "" ? request.name.trim() : request.id;
      noteTarget(context, id);
      await assertAccepting(control);
      const definition = invalidAsArgument(() =>
        parseCreateTeam({
          id,
          name: request.name,
          memberTagIds: [],
          ...(request.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: request.maxConcurrency }),
        }),
      );
      const members = await memberIds(request.members, "members");
      invalidAsArgument(() => parseCreateTeam({ ...definition, memberTagIds: members }));
      return message(
        await refusedAsConflict(() => control.createTeam({ ...definition, memberTagIds: members })),
      );
    },

    async listTeams(request) {
      const member = request.member === "" ? undefined : await store.findTagByName(request.member);
      if (request.member !== "" && member === undefined)
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `Tag "${request.member}" does not exist`,
          [{ path: "member", description: "a Tag's name" }],
        );
      const offset = pageOffset(request.pageToken);
      const size = pageSizeOf(request.pageSize, 100, 500);
      const teams =
        member === undefined ? await store.listTeams() : await store.listTeamsOfTag(member.id);
      const page = teams.slice(offset, offset + size);
      return {
        teams: await Promise.all(page.map(message)),
        nextPageToken: offset + size < teams.length ? pageToken(offset + size) : "",
      };
    },

    async getTeam(request) {
      return message(await findTeam(store, request.team));
    },

    async updateTeam(request, context) {
      const team = await findTeam(store, request.team);
      noteTarget(context, team.id);
      if (
        request.name === undefined &&
        request.members === undefined &&
        request.concurrency === undefined
      )
        throw operatorError(
          Code.InvalidArgument,
          ErrorReason.INVALID_ARGUMENT,
          "Set at least one of name, members and concurrency",
        );
      await assertAccepting(control);
      const change = invalidAsArgument(() =>
        parseUpdateTeam({
          expectedRevision: Number(request.expectedRevision),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.concurrency === undefined
            ? {}
            : {
                maxConcurrency:
                  request.concurrency.maxConcurrency === 0
                    ? null
                    : request.concurrency.maxConcurrency,
              }),
        }),
      );
      const members =
        request.members === undefined
          ? undefined
          : await memberIds(request.members.tags, "members.tags");
      const update = invalidAsArgument(() =>
        parseUpdateTeam({
          ...change,
          ...(members === undefined ? {} : { memberTagIds: members }),
        }),
      );
      return message(await refusedAsConflict(() => control.updateTeam(team.id, update)));
    },

    async deleteTeam(request, context) {
      const team = await findTeam(store, request.team);
      noteTarget(context, team.id);
      await assertAccepting(control);
      if (!(await control.deleteTeam(team.id)))
        throw operatorError(
          Code.NotFound,
          ErrorReason.NOT_FOUND,
          `Team ${request.team} does not exist`,
        );
      return { id: team.id, name: team.name };
    },
  };
}

/** A Team as `TeamService` returns it, with its members' names. */
export async function teamMessage(
  store: Pick<OperatorReadStore, "findTagById">,
  team: TeamRecord,
): Promise<MessageInitShape<typeof TeamSchema>> {
  const tags = await Promise.all(team.memberTagIds.map((id) => store.findTagById(id)));
  return {
    id: team.id,
    name: team.name,
    members: team.memberTagIds.map((tagId, index) => ({
      tagId,
      tag: tags[index]?.status === "active" ? (tags[index]?.name ?? "") : "",
    })),
    ...(team.maxConcurrency === null ? {} : { maxConcurrency: team.maxConcurrency }),
    revision: BigInt(team.revision),
    ...(timestampOf(team.createdAt) === undefined
      ? {}
      : { createdAt: timestampOf(team.createdAt) }),
    ...(timestampOf(team.updatedAt) === undefined
      ? {}
      : { updatedAt: timestampOf(team.updatedAt) }),
  };
}

/** A Team by ID, or else by name; `InvalidArgument` when empty and `NotFound` when missing. */
export async function findTeam(
  store: Pick<OperatorReadStore, "getTeam" | "listTeams">,
  idOrName: string,
): Promise<TeamRecord> {
  if (idOrName === "")
    throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, "team is required", [
      { path: "team", description: "a Team's name or ID" },
    ]);
  const team =
    (await store.getTeam(idOrName)) ??
    (await store.listTeams()).find((candidate) => candidate.name === idOrName);
  if (team === undefined)
    throw operatorError(Code.NotFound, ErrorReason.NOT_FOUND, `Team ${idOrName} does not exist`, [
      { path: "team", description: "a Team's name or ID" },
    ]);
  return team;
}

function noteTarget(context: HandlerContext, id: string): void {
  const note = context.values.get(operatorAuditTarget);
  if (note !== undefined && id !== "") note.target = `Team/${id}`;
}

/** A definition the Team rules refuse is the caller's `InvalidArgument`. */
function invalidAsArgument<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TagMessagingError && error.statusCode === 400)
      throw operatorError(Code.InvalidArgument, ErrorReason.INVALID_ARGUMENT, error.message);
    throw error;
  }
}

/** A Team ID or name another Team holds is `AlreadyExists`; other conflicts stay as they are. */
async function refusedAsConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof TagMessagingError &&
      error.statusCode === 409 &&
      /already (in use|exists)/u.test(error.message)
    )
      throw operatorError(Code.AlreadyExists, ErrorReason.CONFLICT, error.message);
    throw error;
  }
}
