import {
  type CoordinationInboxItem,
  type CoordinationInboxPage,
  type Objective,
  objectiveClosed,
  objectiveLimitEvents,
  type Store,
} from "@supertag/core";
import { objectiveHome } from "./objective-sessions.js";

type Notification = NonNullable<CoordinationInboxItem["notification"]>;
type Route = { readonly inboundEventId: string; readonly key: string };
type BudgetKind = "objective_budget" | "objective_limit";

const DELIVERY_PREFIX: Readonly<Record<BudgetKind, string>> = {
  objective_budget: "objective-budget",
  objective_limit: "objective-limit",
};

function budgetKind(item: CoordinationInboxItem): item is CoordinationInboxItem & {
  readonly kind: BudgetKind;
} {
  return item.kind === "objective_budget" || item.kind === "objective_limit";
}

/**
 * Posts an Objective's budget and limit inbox items to its home thread as immutable notices,
 * through the Gateway outbox. The delivery key names the Objective, the item and the home thread,
 * so a restart or a repeated sweep posts each notice once.
 */
export class BudgetNotifications {
  private readonly cursors = new Map<BudgetKind, string | undefined>();
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
          budgetKind(item) ? { ...item, notification: await this.describe(item) } : item,
        ),
      ),
    };
  }

  /** One bounded page per kind per sweep; the delivery key deduplicates across sweeps. */
  async reconcile(): Promise<void> {
    for (const kind of ["objective_budget", "objective_limit"] as const) {
      const cursor = this.cursors.get(kind);
      const page = await this.store.readCoordinationInbox({
        kind,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      this.cursors.set(kind, page.nextCursor);
      for (const item of page.items) {
        const route = await this.route(item);
        if (!("inboundEventId" in route)) continue;
        await this.store.enqueueOutboundReply({
          inboundEventId: route.inboundEventId,
          workerId: "objective-controller",
          // Error presentation is immutable in the outbox: a concurrent or repeated sweep
          // cannot reset the delivery of a notice that already reached the home thread.
          presentation: "error",
          deliveryKey: route.key,
          text: budgetNoticeText(item),
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  /** Rechecks, just before delivery, that the notice still applies and its home is unchanged. */
  async mayDeliver(outbound: {
    readonly deliveryKey: string;
    readonly inboundEventId: string;
  }): Promise<boolean> {
    const parts = outbound.deliveryKey.split(":");
    if (parts.length !== 4) return false;
    if (
      parts[0] !== DELIVERY_PREFIX.objective_limit &&
      parts[0] !== DELIVERY_PREFIX.objective_budget
    )
      return false;
    try {
      const objective = await this.store.getObjective(decodeURIComponent(parts[1] ?? ""));
      if (objectiveClosed(objective.status)) return false;
      if (parts[0] === DELIVERY_PREFIX.objective_limit) {
        const eventKey = decodeURIComponent(parts[2] ?? "");
        if (!objectiveLimitEvents(objective).some((event) => event.key === eventKey)) return false;
      }
      const home = await objectiveHome(this.store, objective, this.defaultTaskId);
      return (
        home?.id === decodeURIComponent(parts[3] ?? "") &&
        home.inboundEventId === outbound.inboundEventId
      );
    } catch {
      return false;
    }
  }

  private async route(item: CoordinationInboxItem): Promise<Notification | Route> {
    if (!budgetKind(item) || item.objectiveId === null)
      return { status: "failed", reason: "Not a budget notice." };
    let objective: Objective;
    try {
      objective = await this.store.getObjective(item.objectiveId);
    } catch {
      return { status: "failed", reason: "Objective unavailable." };
    }
    if (objectiveClosed(objective.status))
      return { status: "pending", reason: "The Objective is closed; refresh the inbox." };
    // Both kinds key their inbox item `<kind>:<objectiveId>:<eventKey>`; the notice names the
    // event key alone, so the two kinds build the same delivery key shape.
    const itemKey = item.key.slice(`${item.kind}:${item.objectiveId}:`.length);
    if (
      item.kind === "objective_limit" &&
      !objectiveLimitEvents(objective).some((event) => event.key === itemKey)
    )
      return { status: "pending", reason: "The limit changed; refresh the inbox." };
    const home = await objectiveHome(this.store, objective, this.defaultTaskId);
    if (!home?.inboundEventId)
      // A destination the operator chose that no longer verifies is a failure, not an Objective
      // that was never given one.
      return objective.notificationTaskId
        ? {
            status: "failed",
            reason:
              "The Objective's notification destination could not be verified; no external notification was delivered.",
          }
        : {
            status: "unconfigured",
            reason:
              "The Objective has no home thread and no operator notification destination is configured; no external notification was delivered.",
          };
    return {
      inboundEventId: home.inboundEventId,
      key: `${DELIVERY_PREFIX[item.kind]}:${encodeURIComponent(objective.id)}:${encodeURIComponent(itemKey)}:${encodeURIComponent(home.id)}`,
    };
  }
}

/** The notice an Objective's home thread gets for a budget or limit item. */
export function budgetNoticeText(item: CoordinationInboxItem): string {
  const reason =
    item.kind === "objective_budget"
      ? "Its budget is used up, so it starts no new work."
      : (item.reason ?? "A limit changed.");
  return `Objective ${JSON.stringify(item.objectiveId)}: ${reason} Inspect supertag describe objective ${item.objectiveId}. An operator can change the budget or deadline with supertag update objective.`;
}
