import {
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  type Objective,
  objectiveClosed,
  objectiveLimitEvents,
  type Store,
  taskFollowupId,
} from "@supertag/core";

type Notification = NonNullable<CoordinationInboxItem["notification"]>;

/** Projects attention and queues immutable notices through the existing Gateway outbox. */
export class BudgetNotifications {
  private cursor: string | undefined;
  private objectiveCursor: string | undefined;
  private limitCursor: string | undefined;
  constructor(
    private readonly store: Store,
    private readonly defaultTaskId?: string,
    private readonly deliveryEnabled = true,
  ) {}

  async describe(item: CoordinationInboxItem): Promise<Notification> {
    const route = await this.route(item);
    if (!("inboundEventId" in route)) return route;
    const reply = await this.store.findOutboundReply(route.inboundEventId, route.key);
    if (!reply && !this.deliveryEnabled)
      return {
        status: "failed",
        reason: "Gateway delivery is not configured; no external notification was delivered.",
      };
    return reply
      ? {
          status: reply.status,
          ...(reply.status === "failed"
            ? {
                reason: "Gateway delivery failed; inspect the configured surface and retry policy.",
              }
            : {}),
        }
      : { status: "pending", reason: "Waiting for Gateway notification reconciliation." };
  }

  async enrich(page: CoordinationInboxPage): Promise<CoordinationInboxPage> {
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (item) =>
          item.kind === "task_budget" ||
          item.kind === "objective_budget" ||
          item.kind === "objective_limit"
            ? { ...item, notification: await this.describe(item) }
            : item,
        ),
      ),
    };
  }

  /** One bounded page per budget kind per sweep; restarting preserves delivery identity. */
  async reconcile(): Promise<void> {
    const page = await this.store.readCoordinationInbox({
      kind: "task_budget",
      limit: 50,
      ...(this.cursor ? { cursor: this.cursor } : {}),
    });
    this.cursor = page.nextCursor;
    const objectivePage = await this.store.readCoordinationInbox({
      kind: "objective_budget",
      limit: 50,
      ...(this.objectiveCursor ? { cursor: this.objectiveCursor } : {}),
    });
    this.objectiveCursor = objectivePage.nextCursor;
    const limitPage = await this.store.readCoordinationInbox({
      kind: "objective_limit",
      limit: 50,
      ...(this.limitCursor ? { cursor: this.limitCursor } : {}),
    });
    this.limitCursor = limitPage.nextCursor;
    for (const item of [...page.items, ...objectivePage.items, ...limitPage.items]) {
      const route = await this.route(item);
      if (!("inboundEventId" in route)) continue;
      if (item.kind === "objective_limit") {
        // One immutable notice per limit event; the delivery key deduplicates across sweeps.
        await this.store.enqueueOutboundReply({
          inboundEventId: route.inboundEventId,
          workerId: "objective-controller",
          presentation: "status",
          deliveryKey: route.key,
          text: `Objective ${JSON.stringify(item.objectiveId)}: ${item.reason ?? "A limit changed."} Inspect supertag describe objective ${item.objectiveId}. An operator can change the budget or deadline with supertag update objective. A reply to this notification changes nothing.`,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      // Error presentation is immutable in the outbox. Concurrent sweeps cannot reset delivery.
      await this.store.enqueueOutboundReply({
        inboundEventId: route.inboundEventId,
        workerId: "objective-controller",
        presentation: "error",
        deliveryKey: route.key,
        text:
          item.kind === "objective_budget"
            ? `Objective allocation decision required for ${JSON.stringify(item.objectiveId)}. Observation assessment is blocked by its declared allocation. Inspect supertag list inbox --kind objective-budget. An authorized operator can apply update_objective with the current expectedRevision and an explicit larger budgetLimitMinor. This notice grants no allocation and may already be resolved; refresh before deciding. A reply to this notification is not approval.`
            : `Budget decision required for Task ${JSON.stringify(route.taskId)} in Objective ${JSON.stringify(item.objectiveId)}.\nThe recorded Attempt stopped because its allocation was exhausted. Accepted work remains valid. This notification grants no additional allocation.\nThe stopped execution may not have supplied an estimate of remaining work. Inspect the Task's result, artifacts, and usage before deciding.\nThis notice may already be resolved. Run supertag list inbox --kind task-budget --output text, or inspect the current Task through the authenticated API. An authorized operator or manager other than the assignee can renew with update_task, expectedStatus failed, status queued, and explicit executionLimits. A reply to this notification is not approval.`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  /** Recheck the current allocation and operator routing choice immediately before delivery. */
  async mayDeliver(outbound: {
    readonly deliveryKey: string;
    readonly inboundEventId: string;
  }): Promise<boolean> {
    const parts = outbound.deliveryKey.split(":");
    if (parts.length !== 4) return false;
    if (parts[0] === "objective-limit") {
      try {
        const objective = await this.store.getObjective(decodeURIComponent(parts[1] ?? ""));
        const eventKey = decodeURIComponent(parts[2] ?? "");
        if (
          objectiveClosed(objective.status) ||
          !objectiveLimitEvents(objective).some((event) => event.key === eventKey)
        )
          return false;
        const anchorId = decodeURIComponent(parts[3] ?? "");
        if ((await this.destination(objective)) !== anchorId) return false;
        return (
          (await this.store.getVerifiedSurfaceTask(anchorId))?.inboundEventId ===
          outbound.inboundEventId
        );
      } catch {
        return false;
      }
    }
    if (parts[0] === "objective-budget") {
      try {
        const objective = await this.store.getObjective(decodeURIComponent(parts[1] ?? ""));
        if (
          objectiveClosed(objective.status) ||
          objective.revision !== Number(parts[2]) ||
          objective.observationState?.blocked !==
            "Observation delivery awaits available Objective budget"
        )
          return false;
        const origin = objective.notificationTaskId
          ? undefined
          : await this.store.getObjectiveSurfaceTask(objective.id);
        const anchorId = decodeURIComponent(parts[3] ?? "");
        if ((objective.notificationTaskId ?? origin?.id ?? this.defaultTaskId) !== anchorId)
          return false;
        return (
          (await this.store.getVerifiedSurfaceTask(anchorId))?.inboundEventId ===
          outbound.inboundEventId
        );
      } catch {
        return false;
      }
    }
    if (parts[0] !== "task-budget") return false;
    let taskId: string, anchorId: string;
    try {
      taskId = decodeURIComponent(parts[1] ?? "");
      anchorId = decodeURIComponent(parts[3] ?? "");
    } catch {
      return false;
    }
    const attemptCount = Number(parts[2]);
    if (!taskId || !anchorId || !Number.isSafeInteger(attemptCount) || attemptCount < 1)
      return false;
    const task = await this.store.getTaskAssignment(taskId);
    if (
      task?.status !== "failed" ||
      task.result?.["failureKind"] !== "budget-exhausted" ||
      task.attemptCount !== attemptCount
    )
      return false;
    const objective = await this.store.getObjective(task.objectiveId);
    if (!["working", "blocked"].includes(objective.status)) return false;
    const origin = objective.notificationTaskId
      ? undefined
      : await this.store.getObjectiveSurfaceTask(objective.id);
    if ((objective.notificationTaskId ?? origin?.id ?? this.defaultTaskId) !== anchorId)
      return false;
    const anchor = await this.store.getVerifiedSurfaceTask(anchorId);
    return anchor?.inboundEventId === outbound.inboundEventId;
  }

  /** The operator notification destination for an Objective, if one is configured. */
  private async destination(objective: Objective): Promise<string | undefined> {
    const origin = objective.notificationTaskId
      ? undefined
      : await this.store.getObjectiveSurfaceTask(objective.id);
    return objective.notificationTaskId ?? origin?.id ?? this.defaultTaskId;
  }

  private async limitRoute(
    item: CoordinationInboxItem,
  ): Promise<Notification | { inboundEventId: string; taskId: string; key: string }> {
    const eventKey = item.key.slice(`objective_limit:${item.objectiveId}:`.length);
    let objective: Objective;
    try {
      objective = await this.store.getObjective(item.objectiveId);
    } catch {
      return { status: "failed", reason: "Objective unavailable." };
    }
    if (
      objectiveClosed(objective.status) ||
      !objectiveLimitEvents(objective).some((event) => event.key === eventKey)
    )
      return { status: "pending", reason: "The limit changed; refresh the inbox." };
    const taskId = await this.destination(objective);
    if (!taskId)
      return {
        status: "unconfigured",
        reason:
          "No operator notification destination is configured; no external notification was delivered.",
      };
    try {
      const anchor = await this.store.getVerifiedSurfaceTask(taskId);
      if (!anchor?.inboundEventId)
        return {
          status: "failed",
          reason:
            "The configured destination is not an active verified human conversation; no external notification was delivered.",
        };
      return {
        inboundEventId: anchor.inboundEventId,
        taskId: anchor.id,
        key: `objective-limit:${encodeURIComponent(objective.id)}:${encodeURIComponent(eventKey)}:${encodeURIComponent(anchor.id)}`,
      };
    } catch {
      return {
        status: "failed",
        reason:
          "The configured notification destination is unavailable; no external notification was delivered.",
      };
    }
  }

  private async route(
    item: CoordinationInboxItem,
  ): Promise<Notification | { inboundEventId: string; taskId: string; key: string }> {
    if (item.kind === "objective_limit") return this.limitRoute(item);
    const evidence = item.evidence.find((entry) => entry.kind === "task");
    if (!evidence) return { status: "failed", reason: "Task evidence unavailable." };
    const task = await this.store.getTaskAssignment(evidence.id);
    if (
      !task ||
      (item.kind !== "objective_budget" &&
        (task.status !== "failed" || task.result?.["failureKind"] !== "budget-exhausted"))
    )
      return {
        status: "pending",
        reason: "The budget decision has already changed; refresh the inbox.",
      };
    const objective = await this.store.getObjective(task.objectiveId);
    if (!["working", "blocked"].includes(objective.status))
      return { status: "pending", reason: "Objective no longer requires a budget decision." };
    if (
      item.kind === "objective_budget" &&
      (objective.observationState?.blocked !==
        "Observation delivery awaits available Objective budget" ||
        !item.evidence.some(
          (entry) => entry.kind === "objective" && entry.revision === objective.revision,
        ))
    )
      return {
        status: "pending",
        reason: "Objective allocation decision changed; refresh the inbox.",
      };
    if (item.kind !== "objective_budget" && task.parentTaskId) {
      const parent = await this.store.getTaskAssignment(task.parentTaskId);
      const followup = await this.store.getTaskAssignment(await taskFollowupId(task.taskId));
      for (const candidate of [parent, followup]) {
        if (
          candidate &&
          candidate.objectiveId === task.objectiveId &&
          ["queued", "running", "waiting"].includes(candidate.status) &&
          candidate.approval !== "pending" &&
          item.nextActorTagIds.includes(candidate.assignedTagId)
        ) {
          const tag = await this.store.findTagById(candidate.assignedTagId);
          const team = await this.store.getTeam(candidate.teamId);
          if (
            tag?.status === "active" &&
            team.status === "active" &&
            team.memberTagIds.includes(candidate.assignedTagId)
          )
            return {
              status: "manager",
              reason:
                "An active authorized parent manager or followup can handle this decision through existing coordination.",
            };
        }
      }
    }
    const origin = objective.notificationTaskId
      ? undefined
      : await this.store.getObjectiveSurfaceTask(objective.id);
    const taskId = objective.notificationTaskId ?? origin?.id ?? this.defaultTaskId;
    if (!taskId)
      return {
        status: "unconfigured",
        reason:
          "No operator notification destination is configured; no external notification was delivered.",
      };
    try {
      const anchor = await this.store.getVerifiedSurfaceTask(taskId);
      if (!anchor?.inboundEventId)
        return {
          status: "failed",
          reason:
            "The configured destination is not an active verified human conversation; no external notification was delivered.",
        };
      const key =
        item.kind === "objective_budget"
          ? `objective-budget:${encodeURIComponent(objective.id)}:${objective.revision}:${encodeURIComponent(anchor.id)}`
          : `task-budget:${encodeURIComponent(task.taskId)}:${task.attemptCount}:${encodeURIComponent(anchor.id)}`;
      return { inboundEventId: anchor.inboundEventId, taskId: task.taskId, key };
    } catch {
      return {
        status: "failed",
        reason:
          "The configured notification destination is unavailable; no external notification was delivered.",
      };
    }
  }
}
