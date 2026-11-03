import type { TagMessage } from "./mailbox.js";
import type { TaskAssignment, TaskAssignmentStatus } from "./task-assignment.js";
import type { Team } from "./team.js";

export interface CommitmentDependency {
  readonly taskId: string;
  readonly state: "accepted" | "pending" | "unavailable";
  readonly status: TaskAssignmentStatus | null;
  readonly nextActorTagIds: readonly string[];
}

export interface CommitmentBlocker {
  readonly kind: "approval" | "dependency" | "review" | "wait" | "schedule" | "repair";
  readonly taskId?: string;
  readonly requiresOperator?: true;
}

export interface CommitmentRequestState {
  readonly requestMessageId: string;
  readonly recipientTeamId: string | null;
  readonly state: "requested" | "accepted" | "declined" | "committed";
  readonly responseMessageId: string | null;
  readonly responseByTagId: string | null;
  readonly respondedAt: string | null;
  readonly commitmentTaskIds: readonly string[];
}

export interface PriorityNegotiationState {
  readonly proposalMessageId: string;
  readonly state: "proposed" | "accepted" | "declined";
  readonly proposedPriority: "urgent" | "high" | "normal" | "low";
  readonly proposedByTagId: string;
  readonly proposedAt: string;
  readonly responseMessageId: string | null;
  readonly responseByTagId: string | null;
  readonly respondedAt: string | null;
}

/** A projection of durable Task state, not a new resource or publication protocol. */
export interface CommitmentViewEntry {
  readonly taskId: string;
  readonly objectiveId: string;
  readonly teamId: string;
  readonly workstreamId: string | null;
  readonly parentTaskId: string | null;
  readonly kind: "assignment" | "mailbox_delivery";
  readonly sourceMessageId: string | null;
  /** Durable request/response state derived from Mailbox records; it grants no authority. */
  readonly request: CommitmentRequestState | null;
  /** Request inherited through the mailbox-delivery parent, when this is committed work. */
  readonly originatingRequestId: string | null;
  /** Negotiation visibility only. Accepted proposals do not reorder the scheduler. */
  readonly priorityNegotiation: PriorityNegotiationState | null;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly assignedTagId: string;
  readonly requestedByTagId: string;
  readonly status: TaskAssignmentStatus;
  /** Current accepted scheduling priority. Mailbox negotiation alone does not change it. */
  readonly priority: TaskAssignment["priority"];
  readonly approval: TaskAssignment["approval"];
  readonly updatedAt: string;
  readonly dependencies: readonly CommitmentDependency[];
  readonly blockers: readonly CommitmentBlocker[];
  /** Responsibility hints, not authorization grants or a guarantee that dispatch can proceed. */
  readonly nextActorTagIds: readonly string[];
  readonly review: {
    readonly eligibleTagIds: readonly string[];
    readonly reviewedByTagId: string | null;
    readonly assessment: string | null;
  };
  readonly resultState: "none" | "submitted" | "accepted" | "rejected";
  /** Accepted means Task review accepted this output; it does not mean a versioned public interface. */
  readonly artifacts: readonly {
    readonly artifactId: string;
    readonly paths: readonly string[];
    readonly taskId: string;
    readonly attemptCount: number;
    readonly reviewState: "submitted" | "accepted" | "rejected";
  }[];
  readonly waitState: TaskAssignment["waitState"];
  /** Evidence pinned when this Task was admitted. */
  readonly consumedArtifacts: readonly {
    readonly artifactId: string;
    readonly path: string;
    readonly uri: string;
    readonly digest: string;
    readonly mediaType?: string;
    readonly provenance: {
      readonly taskId: string;
      readonly attemptCount: number;
      readonly statusAtAdmission: "submitted" | "accepted" | "rejected" | null;
      readonly reviewedByTagId: string | null;
    };
  }[];
}

export interface CommitmentView {
  readonly objectiveId: string;
  readonly commitments: readonly CommitmentViewEntry[];
}

/**
 * Callers must authorize and scope Tasks before projecting them. Missing dependencies stay
 * unavailable: this function never fetches hidden state or infers acceptance from a message.
 */
export function buildCommitmentView(input: {
  readonly objectiveId: string;
  readonly objectiveOwnerTagId: string;
  readonly tasks: readonly TaskAssignment[];
  readonly teams: readonly Pick<Team, "id" | "leadTagId">[];
  readonly now?: string;
  readonly inputArtifactsByTaskId?: ReadonlyMap<string, readonly unknown[]>;
  readonly messages?: readonly TagMessage[];
}): CommitmentView {
  const tasks = input.tasks.filter((task) => task.objectiveId === input.objectiveId);
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const leads = new Map(input.teams.map((team) => [team.id, team.leadTagId]));
  const now = input.now ?? new Date().toISOString();
  const messages = [...(input.messages ?? [])].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const replies = (messageId: string) =>
    messages.filter((message) => message.inReplyTo === messageId);
  const deliveryFor = (task: TaskAssignment): TaskAssignment | undefined => {
    let current: TaskAssignment | undefined = task;
    const visited = new Set<string>();
    while (current && !visited.has(current.taskId)) {
      visited.add(current.taskId);
      const source = current.sourceMessageId
        ? messagesById.get(current.sourceMessageId)
        : undefined;
      if (source?.type === "delegation.requested") return current;
      current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined;
    }
    return undefined;
  };
  const reviewers = (task: TaskAssignment): string[] =>
    [...new Set([input.objectiveOwnerTagId, leads.get(task.teamId)])].filter(
      (id): id is string =>
        id !== undefined &&
        (id !== task.assignedTagId || task.requestedByTagId === task.assignedTagId),
    );
  const directActors = (task: TaskAssignment): string[] => {
    if (task.status === "accepted" || task.status === "cancelled") return [];
    if (task.status === "submitted") return reviewers(task);
    if (task.status === "failed" || task.status === "rejected") return [task.requestedByTagId];
    if (task.approval === "pending") return [];
    return [task.assignedTagId];
  };
  return {
    objectiveId: input.objectiveId,
    commitments: tasks.map((task): CommitmentViewEntry => {
      const delivery = deliveryFor(task);
      const source = delivery?.sourceMessageId
        ? messagesById.get(delivery.sourceMessageId)
        : undefined;
      const requestReplies = source
        ? replies(source.id).filter(
            (message) =>
              message.type === "delegation.accepted" || message.type === "delegation.declined",
          )
        : [];
      const requestResponse = requestReplies[0];
      const commitmentTaskIds = delivery
        ? tasks
            .filter((candidate) => candidate.parentTaskId === delivery.taskId)
            .map((candidate) => candidate.taskId)
        : [];
      const request =
        source?.type === "delegation.requested" && task.taskId === delivery?.taskId
          ? {
              requestMessageId: source.id,
              recipientTeamId: source.recipientTeamId ?? null,
              state: (commitmentTaskIds.length
                ? "committed"
                : requestResponse?.type === "delegation.accepted"
                  ? "accepted"
                  : requestResponse?.type === "delegation.declined"
                    ? "declined"
                    : "requested") as CommitmentRequestState["state"],
              responseMessageId: requestResponse?.id ?? null,
              responseByTagId: requestResponse?.senderTagId ?? null,
              respondedAt: requestResponse?.createdAt ?? null,
              commitmentTaskIds,
            }
          : null;
      const priorityProposal = messages
        .filter(
          (message) =>
            message.type === "priority.proposed" &&
            message.objectiveId === task.objectiveId &&
            message.recipientTeamId === task.teamId &&
            message.body["taskId"] === task.taskId,
        )
        .at(-1);
      const priorityResponse = priorityProposal
        ? replies(priorityProposal.id).find(
            (message) =>
              message.type === "priority.accepted" || message.type === "priority.declined",
          )
        : undefined;
      const dependencies = task.dependencies.map((taskId): CommitmentDependency => {
        const dependency = byId.get(taskId);
        return {
          taskId,
          state: !dependency
            ? "unavailable"
            : dependency.status === "accepted"
              ? "accepted"
              : "pending",
          status: dependency?.status ?? null,
          nextActorTagIds:
            !dependency || dependency.status === "cancelled"
              ? [task.requestedByTagId]
              : directActors(dependency),
        };
      });
      const blockers: CommitmentBlocker[] = [];
      if (task.status === "queued") {
        if (task.approval === "pending")
          blockers.push({ kind: "approval", requiresOperator: true });
        for (const dependency of dependencies)
          if (dependency.state !== "accepted")
            blockers.push({ kind: "dependency", taskId: dependency.taskId });
        if (Date.parse(task.availableAt) > Date.parse(now)) blockers.push({ kind: "schedule" });
      }
      if (task.status === "submitted") blockers.push({ kind: "review" });
      if (task.status === "waiting") blockers.push({ kind: "wait" });
      if (task.status === "failed" || task.status === "rejected") blockers.push({ kind: "repair" });
      const dependencyActors = dependencies
        .filter((dependency) => dependency.state !== "accepted")
        .flatMap((dependency) => dependency.nextActorTagIds);
      let nextActorTagIds =
        task.status === "queued" && blockers.some((blocker) => blocker.kind === "dependency")
          ? [
              ...new Set([
                ...dependencyActors,
                ...(task.approval === "pending" ? directActors(task) : []),
              ]),
            ]
          : directActors(task);
      if (task.status === "waiting" && task.waitState) {
        const acceptedStates: readonly TaskAssignmentStatus[] = ["accepted"];
        const submittedStates: readonly TaskAssignmentStatus[] = [
          "submitted",
          "accepted",
          "rejected",
          "failed",
          "cancelled",
        ];
        const pending = (ids: readonly string[], states: readonly TaskAssignmentStatus[]) =>
          ids.filter((id) => {
            const dependency = byId.get(id);
            return !dependency || !states.includes(dependency.status);
          });
        const acceptedPending = pending(task.waitState.acceptedTaskIds, acceptedStates);
        const submittedPending = pending(task.waitState.submittedTaskIds, submittedStates);
        const ready =
          (task.waitState.acceptedTaskIds.length > 0 && acceptedPending.length === 0) ||
          (task.waitState.submittedTaskIds.length > 0 && submittedPending.length === 0) ||
          (task.waitState.notBefore !== null &&
            Date.parse(task.waitState.notBefore) <= Date.parse(now));
        const waitingIds = ready ? [] : [...acceptedPending, ...submittedPending];
        nextActorTagIds = [
          ...new Set(
            waitingIds.flatMap((id) => {
              const dependency = byId.get(id);
              return !dependency || dependency.status === "cancelled"
                ? [task.requestedByTagId]
                : directActors(dependency);
            }),
          ),
        ];
      }
      const resultState =
        task.status === "submitted" || task.status === "accepted" || task.status === "rejected"
          ? task.status
          : "none";
      const artifacts: CommitmentViewEntry["artifacts"][number][] = [];
      const taskResult = record(task.result?.["taskResult"]);
      const refs = taskResult?.["artifacts"];
      if (resultState !== "none" && Array.isArray(refs)) {
        for (const ref of refs) {
          const artifact = record(ref);
          const artifactId = artifact?.["artifactId"];
          const paths = artifact?.["paths"];
          if (
            typeof artifactId !== "string" ||
            !Array.isArray(paths) ||
            !paths.every((path) => typeof path === "string")
          )
            continue;
          artifacts.push({
            artifactId,
            paths,
            taskId: task.taskId,
            attemptCount: task.attemptCount,
            reviewState: resultState,
          });
        }
      }
      return {
        taskId: task.taskId,
        objectiveId: task.objectiveId,
        teamId: task.teamId,
        workstreamId: task.workstreamId,
        parentTaskId: task.parentTaskId,
        kind: task.sourceMessageId ? "mailbox_delivery" : "assignment",
        sourceMessageId: task.sourceMessageId,
        request,
        originatingRequestId:
          delivery && delivery.taskId !== task.taskId && source?.type === "delegation.requested"
            ? source.id
            : null,
        priorityNegotiation: priorityProposal
          ? {
              proposalMessageId: priorityProposal.id,
              state:
                priorityResponse?.type === "priority.accepted"
                  ? "accepted"
                  : priorityResponse?.type === "priority.declined"
                    ? "declined"
                    : "proposed",
              proposedPriority: priorityProposal.body[
                "priority"
              ] as PriorityNegotiationState["proposedPriority"],
              proposedByTagId: priorityProposal.senderTagId,
              proposedAt: priorityProposal.createdAt,
              responseMessageId: priorityResponse?.id ?? null,
              responseByTagId: priorityResponse?.senderTagId ?? null,
              respondedAt: priorityResponse?.createdAt ?? null,
            }
          : null,
        instruction: task.instruction,
        acceptanceCriteria: task.acceptanceCriteria,
        assignedTagId: task.assignedTagId,
        requestedByTagId: task.requestedByTagId,
        status: task.status,
        priority: task.priority,
        approval: task.approval,
        updatedAt: task.updatedAt,
        dependencies,
        blockers,
        nextActorTagIds,
        review: {
          eligibleTagIds: reviewers(task),
          reviewedByTagId:
            (resultState === "accepted" || resultState === "rejected") &&
            typeof task.result?.["reviewedByTagId"] === "string"
              ? task.result["reviewedByTagId"]
              : null,
          assessment:
            (resultState === "accepted" || resultState === "rejected") &&
            typeof task.result?.["assessment"] === "string"
              ? task.result["assessment"]
              : null,
        },
        resultState,
        artifacts,
        waitState: task.waitState,
        consumedArtifacts: consumedArtifacts(input.inputArtifactsByTaskId?.get(task.taskId) ?? []),
      };
    }),
  };
}

function consumedArtifacts(refs: readonly unknown[]): CommitmentViewEntry["consumedArtifacts"] {
  return refs.flatMap((ref) => {
    const artifact = record(ref);
    const artifactId = artifact?.["artifactId"];
    const path = artifact?.["path"];
    const digest = artifact?.["digest"];
    const provenance = record(artifact?.["provenance"]);
    const taskId = provenance?.["taskId"];
    const attemptCount = provenance?.["attemptCount"];
    if (
      typeof artifactId !== "string" ||
      typeof path !== "string" ||
      typeof digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
      artifact?.["uri"] !== `supertag-artifact:${digest}` ||
      typeof taskId !== "string" ||
      typeof attemptCount !== "number" ||
      !Number.isSafeInteger(attemptCount) ||
      attemptCount < 0
    )
      return [];
    const status = provenance?.["statusAtAdmission"];
    const reviewedBy = provenance?.["reviewedByTagId"];
    const mediaType = artifact["mediaType"];
    return [
      {
        artifactId,
        path,
        uri: `supertag-artifact:${digest}`,
        digest,
        ...(typeof mediaType === "string" ? { mediaType } : {}),
        provenance: {
          taskId,
          attemptCount,
          statusAtAdmission:
            status === "submitted" || status === "accepted" || status === "rejected"
              ? status
              : null,
          reviewedByTagId: typeof reviewedBy === "string" ? reviewedBy : null,
        },
      },
    ];
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
